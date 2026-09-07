import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sha256Hex } from "./fingerprints.ts";
import type { BacktestManifest, SourceObject } from "./manifest.ts";

export interface OssConfiguration {
  readonly endpoint: string;
  readonly endpointStyle: "service" | "bucket";
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
  readonly endpointStyle?: "service" | "bucket";
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

/**
 * Deliberately separate from the runtime object reader. It is only for an
 * operator-invoked admission step that freezes an exact archive plan before
 * a backtest is allowed to read any bars.
 */
export interface BoundedPrefixDiscovery {
  listChildren(prefixUri: string): Promise<{
    readonly prefixes: readonly string[];
    readonly objects: readonly BoundedPrefixObject[];
    readonly pages: number;
    readonly requestId?: string;
  }>;
}

export interface BoundedPrefixObject {
  readonly name: string;
  readonly size?: number;
  readonly etag?: string;
  readonly lastModified?: string;
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

interface AliOssListResult {
  readonly res?: AliOssResponse;
  readonly objects?: readonly BoundedPrefixObject[];
  readonly prefixes?: readonly string[];
  readonly nextContinuationToken?: string | null;
  readonly isTruncated?: boolean;
}

export interface AliOssClient {
  head(name: string, options?: Record<string, unknown>): Promise<AliOssHeadResult>;
  get(name: string, options?: Record<string, unknown>): Promise<AliOssGetResult>;
}

export interface AliOssPrefixClient extends AliOssClient {
  listV2(query: {
    readonly prefix: string;
    readonly delimiter: "/";
    readonly "max-keys": number;
    readonly "continuation-token"?: string;
  }): Promise<AliOssListResult>;
}

export interface AliOssClientOptions {
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
  bucket: string;
  endpoint?: string;
  cname: boolean;
  region?: string;
  authorizationV4: boolean;
  retryMax: number;
  timeout: number;
}

type AliOssConstructor = new (options: AliOssClientOptions) => AliOssClient;

export type AliOssClientFactory = (options: AliOssClientOptions) => Promise<AliOssClient>;
export type AliOssPrefixClientFactory = (options: AliOssClientOptions) => Promise<AliOssPrefixClient>;

export interface ExactObject {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly head: ObjectHead;
}

const OSS_ENV_ALIASES = {
  endpoint: ["OSS_ENDPOINT", "MARKET_DATA_S3_ENDPOINT"],
  endpointStyle: ["OSS_ENDPOINT_STYLE", "MARKET_DATA_S3_ENDPOINT_STYLE"],
  region: ["OSS_REGION", "MARKET_DATA_S3_REGION"],
  bucket: ["OSS_BUCKET", "MARKET_DATA_S3_BUCKET"],
  accessKeyId: ["OSS_ACCESS_KEY_ID", "ALIBABACLOUD_ACCESS_KEY_ID"],
  accessKeySecret: ["OSS_ACCESS_KEY_SECRET", "ALIBABACLOUD_SECRET_ACCESS_KEY"],
  securityToken: ["OSS_SECURITY_TOKEN", "ALIBABACLOUD_SECURITY_TOKEN"],
} as const;

function environmentValue(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function inferEndpointStyle(endpoint: string | undefined, bucket: string | undefined): "service" | "bucket" {
  if (!endpoint || !bucket) return "service";
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname.startsWith(bucket.toLowerCase() + ".") ? "bucket" : "service";
  } catch {
    return "service";
  }
}

function endpointStyle(
  value: string | undefined,
  endpoint: string | undefined,
  bucket: string | undefined,
): "service" | "bucket" {
  if (!value) return inferEndpointStyle(endpoint, bucket);
  const normalized = value.toLowerCase();
  if (normalized === "service" || normalized === "bucket") return normalized;
  throw new Error("BACKTEST_OSS_ENDPOINT_STYLE_INVALID");
}

export function readOssConfiguration(env: NodeJS.ProcessEnv = process.env): OssConfigurationStatus & {
  readonly config?: OssConfiguration;
} {
  const values = {
    endpoint: environmentValue(env, OSS_ENV_ALIASES.endpoint),
    endpointStyle: environmentValue(env, OSS_ENV_ALIASES.endpointStyle),
    region: environmentValue(env, OSS_ENV_ALIASES.region),
    bucket: environmentValue(env, OSS_ENV_ALIASES.bucket),
    accessKeyId: environmentValue(env, OSS_ENV_ALIASES.accessKeyId),
    accessKeySecret: environmentValue(env, OSS_ENV_ALIASES.accessKeySecret),
    securityToken: environmentValue(env, OSS_ENV_ALIASES.securityToken),
  };
  const missing = (Object.keys(values) as Array<keyof typeof values>)
    .filter((key) => key !== "securityToken" && key !== "endpointStyle" && !values[key])
    .map((key) => OSS_ENV_ALIASES[key][0]);
  if (missing.length > 0) {
    return {
      configured: false,
      missing,
      endpoint: values.endpoint,
      endpointStyle: inferEndpointStyle(values.endpoint, values.bucket),
      region: values.region,
      bucket: values.bucket,
    };
  }
  return {
    configured: true,
    missing: [],
    endpoint: values.endpoint,
    endpointStyle: endpointStyle(values.endpointStyle, values.endpoint, values.bucket),
    region: values.region,
    bucket: values.bucket,
    config: {
      endpoint: values.endpoint as string,
      endpointStyle: endpointStyle(values.endpointStyle, values.endpoint, values.bucket),
      region: values.region as string,
      bucket: values.bucket as string,
      accessKeyId: values.accessKeyId as string,
      accessKeySecret: values.accessKeySecret as string,
      securityToken: values.securityToken,
    },
  };
}

function ossClientOptions(config: OssConfiguration): AliOssClientOptions {
  return {
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    stsToken: config.securityToken,
    bucket: config.bucket,
    endpoint: config.endpoint,
    // A bucket-style endpoint already includes the bucket hostname. ali-oss
    // calls this CNAME mode and otherwise prepends the bucket a second time.
    cname: config.endpointStyle === "bucket",
    region: config.region,
    authorizationV4: true,
    retryMax: 0,
    timeout: 60_000,
  };
}

const defaultAliOssClientFactory: AliOssClientFactory = async (options) => {
  const module = await import("ali-oss");
  const constructor = (module.default ?? module) as unknown as AliOssConstructor;
  return new constructor(options);
};

const defaultAliOssPrefixClientFactory: AliOssPrefixClientFactory = async (options) =>
  (await defaultAliOssClientFactory(options)) as AliOssPrefixClient;

export function parseExactOssUri(uri: string): { bucket: string; key: string } {
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

export function createReadOnlyOssStore(
  config: OssConfiguration,
  createClient: AliOssClientFactory = defaultAliOssClientFactory,
): ReadOnlyObjectStore {
  let clientPromise: Promise<AliOssClient> | undefined;
  const getClient = async (): Promise<AliOssClient> => {
    clientPromise ??= createClient(ossClientOptions(config));
    return clientPromise;
  };
  return {
    async head(uri: string): Promise<ObjectHead> {
      const { bucket, key } = parseExactOssUri(uri);
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
      const { bucket, key } = parseExactOssUri(uri);
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

/**
 * Lists one explicit, bounded child-prefix set. This is not used by normal
 * manifest/catalog reads: callers must opt into discovery, freeze the result,
 * and subsequently use the exact-object reader above.
 */
export function createBoundedPrefixDiscovery(
  config: OssConfiguration,
  createClient: AliOssPrefixClientFactory = defaultAliOssPrefixClientFactory,
  options: { readonly allowNetwork?: boolean; readonly allowListDiscovery?: boolean } = {},
): BoundedPrefixDiscovery {
  if (!options.allowNetwork) throw new Error("BACKTEST_NETWORK_DISABLED");
  if (!options.allowListDiscovery) throw new Error("BACKTEST_LIST_DISCOVERY_REQUIRES_ALLOW_LIST_DISCOVERY");
  let clientPromise: Promise<AliOssPrefixClient> | undefined;
  const getClient = async (): Promise<AliOssPrefixClient> => {
    clientPromise ??= createClient(ossClientOptions(config));
    return clientPromise;
  };
  return {
    async listChildren(prefixUri: string): Promise<{
      readonly prefixes: readonly string[];
      readonly objects: readonly BoundedPrefixObject[];
      readonly pages: number;
      readonly requestId?: string;
    }> {
      const { bucket, key } = parseExactOssUri(prefixUri);
      if (bucket !== config.bucket) throw new Error("BACKTEST_OSS_BUCKET_MISMATCH");
      const prefix = key.endsWith("/") ? key : key + "/";
      const prefixes: string[] = [];
      const objects: BoundedPrefixObject[] = [];
      let continuationToken: string | undefined;
      let pages = 0;
      let requestId: string | undefined;
      try {
        for (;;) {
          if (pages >= 256) throw new Error("BACKTEST_OSS_PREFIX_DISCOVERY_TRUNCATED");
          const query: {
            prefix: string;
            delimiter: "/";
            "max-keys": number;
            "continuation-token"?: string;
          } = { prefix, delimiter: "/", "max-keys": 1_000 };
          if (continuationToken) query["continuation-token"] = continuationToken;
          const response = await (await getClient()).listV2(query);
          pages += 1;
          requestId ??= response.res?.headers?.["x-oss-request-id"];
          for (const value of response.prefixes ?? []) {
            if (typeof value !== "string" || !value.startsWith(prefix)) {
              throw new Error("BACKTEST_OSS_PREFIX_DISCOVERY_RESPONSE_INVALID");
            }
            prefixes.push(value);
          }
          for (const value of response.objects ?? []) {
            if (!value || typeof value.name !== "string" || !value.name.startsWith(prefix)) {
              throw new Error("BACKTEST_OSS_PREFIX_DISCOVERY_RESPONSE_INVALID");
            }
            objects.push({
              name: value.name,
              ...(typeof value.size === "number" ? { size: value.size } : {}),
              ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
              ...(typeof value.lastModified === "string" ? { lastModified: value.lastModified } : {}),
            });
          }
          const next = typeof response.nextContinuationToken === "string"
            ? response.nextContinuationToken.trim()
            : "";
          if (!response.isTruncated && !next) break;
          if (!next || next === continuationToken) {
            throw new Error("BACKTEST_OSS_PREFIX_DISCOVERY_TRUNCATED");
          }
          continuationToken = next;
        }
        return {
          prefixes: [...new Set(prefixes)].sort(),
          objects,
          pages,
          ...(requestId ? { requestId } : {}),
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("BACKTEST_OSS_PREFIX_DISCOVERY_")) throw error;
        throw new Error("BACKTEST_OSS_PREFIX_DISCOVERY_FAILED");
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
