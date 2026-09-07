import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sha256Hex } from "./fingerprints.ts";
import type { BacktestManifest, SourceObject } from "./manifest.ts";

export interface OssConfiguration {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken?: string;
}

export interface OssConfigurationStatus {
  readonly configured: boolean;
  readonly missing: readonly string[];
  readonly endpoint?: string;
  readonly region?: string;
  readonly bucket?: string;
}

export interface ObjectHead {
  readonly requestId?: string;
  readonly source: "local-file" | "oss";
}

export interface ReadOnlyObjectStore {
  head(uri: string): Promise<ObjectHead>;
  get(uri: string): Promise<Buffer>;
}

interface AliOssResponse {
  readonly status?: number;
  readonly headers?: Record<string, string | undefined>;
}

interface AliOssHeadResult {
  readonly status?: number;
  readonly res?: AliOssResponse;
}

interface AliOssGetResult {
  readonly res?: AliOssResponse;
  readonly content?: Buffer;
}

interface AliOssClient {
  head(name: string, options?: Record<string, unknown>): Promise<AliOssHeadResult>;
  get(name: string, options?: Record<string, unknown>): Promise<AliOssGetResult>;
}

type AliOssConstructor = new (options: {
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
  bucket: string;
  endpoint?: string;
  region?: string;
  authorizationV4: boolean;
  retryMax: number;
  timeout: number;
}) => AliOssClient;

export interface ExactObject {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly head: ObjectHead;
}

const OSS_ENV_KEYS = {
  endpoint: "OSS_ENDPOINT",
  region: "OSS_REGION",
  bucket: "OSS_BUCKET",
  accessKeyId: "OSS_ACCESS_KEY_ID",
  accessKeySecret: "OSS_ACCESS_KEY_SECRET",
  securityToken: "OSS_SECURITY_TOKEN",
} as const;

function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function readOssConfiguration(env: NodeJS.ProcessEnv = process.env): OssConfigurationStatus & {
  readonly config?: OssConfiguration;
} {
  const values = {
    endpoint: environmentValue(env, OSS_ENV_KEYS.endpoint),
    region: environmentValue(env, OSS_ENV_KEYS.region),
    bucket: environmentValue(env, OSS_ENV_KEYS.bucket),
    accessKeyId: environmentValue(env, OSS_ENV_KEYS.accessKeyId),
    accessKeySecret: environmentValue(env, OSS_ENV_KEYS.accessKeySecret),
    securityToken: environmentValue(env, OSS_ENV_KEYS.securityToken),
  };
  const missing = (Object.keys(values) as Array<keyof typeof values>)
    .filter((key) => key !== "securityToken" && !values[key])
    .map((key) => OSS_ENV_KEYS[key]);
  if (missing.length > 0) {
    return {
      configured: false,
      missing,
      endpoint: values.endpoint,
      region: values.region,
      bucket: values.bucket,
    };
  }
  return {
    configured: true,
    missing: [],
    endpoint: values.endpoint,
    region: values.region,
    bucket: values.bucket,
    config: {
      endpoint: values.endpoint as string,
      region: values.region as string,
      bucket: values.bucket as string,
      accessKeyId: values.accessKeyId as string,
      accessKeySecret: values.accessKeySecret as string,
      securityToken: values.securityToken,
    },
  };
}

function parseOssUri(uri: string): { bucket: string; key: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("BACKTEST_SOURCE_URI_INVALID");
  }
  if (parsed.protocol !== "oss:" || !parsed.hostname || !parsed.pathname || parsed.search || parsed.hash) {
    throw new Error("BACKTEST_SOURCE_URI_MUST_BE_EXACT_OSS_URI");
  }
  let key: string;
  try {
    key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error("BACKTEST_SOURCE_OBJECT_KEY_INVALID");
  }
  if (!key || key.includes("..") || /[*?]/.test(key) || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(key)) {
    throw new Error("BACKTEST_SOURCE_OBJECT_KEY_NOT_EXACT");
  }
  return { bucket: parsed.hostname, key };
}

function resolveFileUri(uri: string, manifestPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri, pathToFileURL(resolve(manifestPath)));
  } catch {
    throw new Error("BACKTEST_LOCAL_SOURCE_URI_INVALID");
  }
  if (
    parsed.protocol !== "file:"
    || parsed.search
    || parsed.hash
    || /[*?]/.test(parsed.pathname)
    || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(parsed.pathname)
  ) {
    throw new Error("BACKTEST_LOCAL_SOURCE_URI_MUST_BE_EXACT_FILE");
  }
  try {
    return fileURLToPath(parsed);
  } catch {
    throw new Error("BACKTEST_LOCAL_SOURCE_URI_INVALID");
  }
}

function objectUriProtocol(uri: string): "file" | "oss" {
  const protocol = uri.slice(0, uri.indexOf(":")).toLowerCase();
  if (protocol === "file") return "file";
  if (protocol === "oss") return "oss";
  throw new Error("BACKTEST_SOURCE_URI_PROTOCOL_UNSUPPORTED");
}

function assertExpectedHash(bytes: Buffer, expected: string): string {
  const actual = sha256Hex(bytes);
  if (actual !== expected) throw new Error("BACKTEST_SOURCE_SHA256_MISMATCH");
  return actual;
}

export function createReadOnlyOssStore(config: OssConfiguration): ReadOnlyObjectStore {
  let clientPromise: Promise<AliOssClient> | undefined;
  const getClient = async (): Promise<AliOssClient> => {
    clientPromise ??= import("ali-oss").then((module) => {
      const constructor = (module.default ?? module) as unknown as AliOssConstructor;
      return new constructor({
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
        stsToken: config.securityToken,
        bucket: config.bucket,
        endpoint: config.endpoint,
        region: config.region,
        authorizationV4: true,
        retryMax: 0,
        timeout: 60_000,
      });
    });
    return clientPromise;
  };
  return {
    async head(uri: string): Promise<ObjectHead> {
      const { bucket, key } = parseOssUri(uri);
      if (bucket !== config.bucket) throw new Error("BACKTEST_OSS_BUCKET_MISMATCH");
      try {
        const response = await (await getClient()).head(key);
        return {
          source: "oss",
          requestId: response.res?.headers?.["x-oss-request-id"],
        };
      } catch {
        throw new Error("BACKTEST_OSS_HEAD_FAILED");
      }
    },
    async get(uri: string): Promise<Buffer> {
      const { bucket, key } = parseOssUri(uri);
      if (bucket !== config.bucket) throw new Error("BACKTEST_OSS_BUCKET_MISMATCH");
      try {
        const response = await (await getClient()).get(key);
        if (!response.content) throw new Error("BACKTEST_OSS_EMPTY_OBJECT");
        return response.content;
      } catch {
        throw new Error("BACKTEST_OSS_GET_FAILED");
      }
    },
  };
}

export async function readExactObject(
  manifestPath: string,
  source: SourceObject,
  options: { allowNetwork?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ExactObject> {
  return readExactUri(manifestPath, source.uri, source.sha256, options);
}

export async function readExactUri(
  manifestPath: string,
  uri: string,
  expectedSha256: string,
  options: { allowNetwork?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ExactObject> {
  const protocol = objectUriProtocol(uri);
  if (protocol === "file") {
    const bytes = await readFile(resolveFileUri(uri, manifestPath));
    return {
      bytes,
      sha256: assertExpectedHash(bytes, expectedSha256),
      head: { source: "local-file" },
    };
  }
  if (!options.allowNetwork) throw new Error("BACKTEST_NETWORK_DISABLED");
  const status = readOssConfiguration(options.env);
  if (!status.configured || !status.config) throw new Error("BACKTEST_OSS_CONFIG_MISSING");
  const store = createReadOnlyOssStore(status.config);
  const head = await store.head(uri);
  const bytes = await store.get(uri);
  return { bytes, sha256: assertExpectedHash(bytes, expectedSha256), head };
}

export function sourceProtocol(source: BacktestManifest["sourceObject"]): "file" | "oss" {
  return objectUriProtocol(source.uri);
}
