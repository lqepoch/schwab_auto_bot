import { atomicWriteJson } from "../utils/atomicJson.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digestJson, sha256Hex, compareCodeUnits } from "./fingerprints.ts";
import { barSummary, filterBars, type MinuteBar } from "./bars.ts";
import { readDatasetBars } from "./catalog.ts";
import {
  assertRunnableManifest,
  loadManifest,
  manifestFingerprint,
  type BacktestManifest,
} from "./manifest.ts";
import {
  loadCorporateActions,
  validateCorporateActionPolicy,
  type CorporateAction,
} from "./corporateActions.ts";
import { simulateLongOnlyCashEquity } from "./engine.ts";
import {
  fetchAlpacaCorporateActions,
  type AlpacaCliRunner,
  type AlpacaActionQuery,
  type AlpacaFetchResult,
} from "./alpaca.ts";
import { readOssConfiguration, sourceProtocol } from "./objectStore.ts";

export type EvidenceStatus = "PASS" | "FAIL" | "BLOCKED" | "UNVERIFIED";

export interface BacktestArtifact {
  readonly artifactVersion: 1;
  readonly kind: string;
  readonly status: EvidenceStatus;
  readonly evidenceClass: string;
  readonly readOnly: true;
  readonly brokerWriteAttempted: false;
  readonly warnings: readonly string[];
  readonly [key: string]: unknown;
}

function baseArtifact(
  kind: string,
  status: EvidenceStatus,
  evidenceClass: string,
  warnings: readonly string[] = [],
): Pick<BacktestArtifact, "artifactVersion" | "kind" | "status" | "evidenceClass" | "readOnly" | "brokerWriteAttempted" | "warnings"> {
  return {
    artifactVersion: 1,
    kind,
    status,
    evidenceClass,
    readOnly: true,
    brokerWriteAttempted: false,
    warnings,
  };
}

export async function writeArtifact(outputDir: string, fileName: string, artifact: unknown): Promise<string> {
  const path = join(outputDir, fileName);
  await atomicWriteJson(path, artifact, { directoryMode: 0o750, fileMode: 0o640, pretty: true });
  return path;
}

function isOssUri(uri: string | undefined): boolean {
  return typeof uri === "string" && uri.toLowerCase().startsWith("oss:");
}

function manifestUsesOss(manifest: BacktestManifest): boolean {
  return sourceProtocol(manifest.sourceObject) === "oss" || isOssUri(manifest.corporateActions.uri);
}

function networkAccessAttempted(manifest: BacktestManifest, allowNetwork: boolean | undefined): boolean {
  return allowNetwork === true && manifestUsesOss(manifest);
}

function sourceEvidence(manifest: BacktestManifest): string {
  return manifestUsesOss(manifest)
    ? "OSS_READ_ONLY_PROVIDER_EVIDENCE"
    : "LOCAL_FILE_OR_FIXTURE";
}

export async function runPreflight(
  manifestPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BacktestArtifact> {
  const manifest = await loadManifest(manifestPath);
  const protocol = sourceProtocol(manifest.sourceObject);
  const oss = readOssConfiguration(env);
  const warnings: string[] = [];
  if (manifest.adjustmentMode === "unknown") warnings.push("ADJUSTMENT_MODE_UNKNOWN_WILL_FAIL_BACKTEST");
  if (manifest.universe.completeness === "unknown") warnings.push("UNIVERSE_COMPLETENESS_UNKNOWN_WILL_FAIL_BACKTEST");
  warnings.push("SESSION_DECLARATION_NOT_CALENDAR_VERIFIED");
  warnings.push("ADJUSTMENT_MODE_IS_DECLARATIVE_UNTIL_PROVIDER_EVIDENCE_IS_CAPTURED");
  const actionUsesOss = isOssUri(manifest.corporateActions.uri);
  const ossRequired = protocol === "oss" || actionUsesOss;
  const blocked = ossRequired && !oss.configured;
  if (blocked) warnings.push("OSS_CONFIG_MISSING_NO_NETWORK_PROBE_PERFORMED");
  return {
    ...baseArtifact(
      "backtest-preflight",
      blocked ? "BLOCKED" : "PASS",
      "CONFIGURATION_ONLY",
      warnings,
    ),
    manifestPath,
    manifestFingerprint: manifestFingerprint(manifest),
    datasetId: manifest.datasetId,
    source: {
      protocol,
      uri: manifest.sourceObject.uri,
      schema: manifest.sourceObject.schema,
      kind: manifest.sourceObject.kind,
      sha256: manifest.sourceObject.sha256,
    },
    contract: {
      feed: manifest.feed,
      timeframe: manifest.timeframe,
      session: manifest.session,
      adjustmentMode: manifest.adjustmentMode,
      startDate: manifest.startDate,
      endDate: manifest.endDate,
      universeId: manifest.universe.id,
      universeFingerprint: manifest.universe.fingerprint,
      universeCompleteness: manifest.universe.completeness,
      sessionVerification: "DECLARED_UNVERIFIED",
    },
    oss: {
      required: ossRequired,
      configured: oss.configured,
      missing: oss.missing,
      endpoint: oss.endpoint,
      region: oss.region,
      bucket: oss.bucket,
      networkAccessAttempted: false,
      methods: ["HEAD", "GET"],
    },
    corporateActionsSource: {
      protocol: actionUsesOss ? "oss" : "file",
      uri: manifest.corporateActions.uri ?? null,
    },
  };
}

function classifyReadError(error: unknown): EvidenceStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "BACKTEST_NETWORK_DISABLED"
    || message === "BACKTEST_OSS_CONFIG_MISSING"
    || message === "BACKTEST_OSS_HEAD_FAILED"
    || message === "BACKTEST_OSS_GET_FAILED"
  ) return "BLOCKED";
  return "FAIL";
}

export async function runAudit(
  manifestPath: string,
  options: { allowNetwork?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<BacktestArtifact> {
  const manifest = await loadManifest(manifestPath);
  const warnings: string[] = [
    "ADJUSTMENT_MODE_IS_DECLARATIVE_UNTIL_PROVIDER_EVIDENCE_IS_CAPTURED",
    "SESSION_DECLARATION_NOT_CALENDAR_VERIFIED",
  ];
  if (manifest.adjustmentMode === "unknown") warnings.push("ADJUSTMENT_MODE_UNKNOWN_WILL_FAIL_BACKTEST");
  if (manifest.universe.completeness === "unknown") warnings.push("UNIVERSE_COMPLETENESS_UNKNOWN_WILL_FAIL_BACKTEST");
  if (manifest.sourceObject.kind === "catalog") warnings.push("CATALOG_AUDIT_READS_ALL_DECLARED_SHARDS");
  try {
    const data = await readDatasetBars(manifestPath, manifest, options);
    const actionData = await loadCorporateActions(manifestPath, manifest, options);
    warnings.push(...validateCorporateActionPolicy(manifest, actionData.actions));
    const status: EvidenceStatus = (
      manifest.adjustmentMode === "unknown"
      || manifest.universe.completeness === "unknown"
      || (manifest.adjustmentMode === "raw" && manifest.corporateActions.mode === "none")
    ) ? "UNVERIFIED" : "PASS";
    return {
      ...baseArtifact("backtest-audit", status, sourceEvidence(manifest), warnings),
      manifestPath,
      manifestFingerprint: manifestFingerprint(manifest),
      datasetId: manifest.datasetId,
      sourceObjects: data.sourceObjects,
      catalogFingerprint: data.catalogFingerprint,
      dataFingerprint: data.dataFingerprint,
      actionFingerprint: actionData.dataFingerprint,
      actionSourceUri: actionData.sourceUri,
      bars: barSummary(data.bars),
      corporateActions: {
        mode: manifest.corporateActions.mode,
        provider: manifest.corporateActions.provider,
        actionCount: actionData.actions.length,
        barsAlreadyReflectActions: manifest.corporateActions.appliesToBars,
      },
      session: {
        declared: manifest.session,
        verification: "DECLARED_UNVERIFIED",
      },
      networkAccessAttempted: networkAccessAttempted(manifest, options.allowNetwork),
    };
  } catch (error) {
    const status = classifyReadError(error);
    return {
      ...baseArtifact("backtest-audit", status, status === "BLOCKED" ? "CONFIGURATION_OR_PROVIDER_BLOCKED" : "LOCAL_VALIDATION", warnings),
      manifestPath,
      manifestFingerprint: manifestFingerprint(manifest),
      datasetId: manifest.datasetId,
      errorCode: error instanceof Error ? error.message : "BACKTEST_AUDIT_FAILED",
      networkAccessAttempted: networkAccessAttempted(manifest, options.allowNetwork),
    };
  }
}

function barKey(bar: MinuteBar): string {
  return bar.symbol + "|" + bar.timestamp;
}

function compareNumber(left: number, right: number): boolean {
  return Object.is(left, right) || Math.abs(left - right) <= 1e-12;
}

export async function runParity(
  leftManifestPath: string,
  rightManifestPath: string,
  options: { allowNetwork?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<BacktestArtifact> {
  const [leftManifest, rightManifest] = await Promise.all([
    loadManifest(leftManifestPath),
    loadManifest(rightManifestPath),
  ]);
  const warnings: string[] = ["SESSION_DECLARATION_NOT_CALENDAR_VERIFIED"];
  if (leftManifest.adjustmentMode !== rightManifest.adjustmentMode) {
    warnings.push("ADJUSTMENT_MODES_DIFFER");
  }
  if (leftManifest.sourceObject.kind === "catalog" || rightManifest.sourceObject.kind === "catalog") {
    warnings.push("CATALOG_PARITY_READS_ALL_DECLARED_SHARDS");
  }
  try {
    const [left, right] = await Promise.all([
      readDatasetBars(leftManifestPath, leftManifest, options),
      readDatasetBars(rightManifestPath, rightManifest, options),
    ]);
    const rightByKey = new Map(right.bars.map((bar) => [barKey(bar), bar]));
    const mismatches: Array<Record<string, unknown>> = [];
    let mismatchCount = 0;
    for (const bar of left.bars) {
      const other = rightByKey.get(barKey(bar));
      if (!other) {
        mismatchCount += 1;
        if (mismatches.length < 100) mismatches.push({ key: barKey(bar), reason: "missing-right" });
        continue;
      }
      if (
        !compareNumber(bar.open, other.open)
        || !compareNumber(bar.high, other.high)
        || !compareNumber(bar.low, other.low)
        || !compareNumber(bar.close, other.close)
        || !compareNumber(bar.volume, other.volume)
      ) {
        mismatchCount += 1;
        if (mismatches.length < 100) mismatches.push({
          key: barKey(bar),
          reason: "value-different",
          left: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
          right: { open: other.open, high: other.high, low: other.low, close: other.close, volume: other.volume },
        });
      }
      rightByKey.delete(barKey(bar));
    }
    for (const key of [...rightByKey.keys()].sort(compareCodeUnits)) {
      mismatchCount += 1;
      if (mismatches.length < 100) mismatches.push({ key, reason: "missing-left" });
    }
    return {
      ...baseArtifact(
        "backtest-parity",
        mismatchCount === 0 ? "PASS" : "UNVERIFIED",
        "LOCAL_COMPARISON",
        warnings,
      ),
      left: {
        manifestPath: leftManifestPath,
        manifestFingerprint: manifestFingerprint(leftManifest),
        dataFingerprint: left.dataFingerprint,
        bars: barSummary(left.bars),
        session: { declared: leftManifest.session, verification: "DECLARED_UNVERIFIED" },
      },
      right: {
        manifestPath: rightManifestPath,
        manifestFingerprint: manifestFingerprint(rightManifest),
        dataFingerprint: right.dataFingerprint,
        bars: barSummary(right.bars),
        session: { declared: rightManifest.session, verification: "DECLARED_UNVERIFIED" },
      },
      mismatchCount,
      mismatches,
      networkAccessAttempted: options.allowNetwork === true
        && (manifestUsesOss(leftManifest) || manifestUsesOss(rightManifest)),
    };
  } catch (error) {
    const status = classifyReadError(error);
    return {
      ...baseArtifact("backtest-parity", status, status === "BLOCKED" ? "CONFIGURATION_OR_PROVIDER_BLOCKED" : "LOCAL_VALIDATION", warnings),
      leftManifestPath,
      rightManifestPath,
      errorCode: error instanceof Error ? error.message : "BACKTEST_PARITY_FAILED",
      networkAccessAttempted: options.allowNetwork === true
        && (manifestUsesOss(leftManifest) || manifestUsesOss(rightManifest)),
    };
  }
}

export async function runBacktest(
  manifestPath: string,
  options: {
    symbol?: string;
    initialCash?: number;
    allowNetwork?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<BacktestArtifact> {
  const manifest = await loadManifest(manifestPath);
  assertRunnableManifest(manifest);
  const symbol = (options.symbol ?? manifest.universe.symbols[0]).trim().toUpperCase();
  if (!manifest.universe.symbols.includes(symbol)) throw new Error("BACKTEST_SYMBOL_NOT_IN_UNIVERSE_" + symbol);
  const initialPolicyWarnings = validateCorporateActionPolicy(manifest, [], { requireEvidence: true });
  const data = await readDatasetBars(manifestPath, manifest, {
    allowNetwork: options.allowNetwork,
    env: options.env,
    requiredSymbols: [symbol],
  });
  const actionData = await loadCorporateActions(manifestPath, manifest, options);
  const warnings = [
    "SESSION_DECLARATION_NOT_CALENDAR_VERIFIED",
    ...initialPolicyWarnings,
    ...validateCorporateActionPolicy(manifest, actionData.actions, { requireEvidence: true }),
  ];
  const initialCash = options.initialCash ?? 100_000;
  const simulation = simulateLongOnlyCashEquity(data.bars, manifest, actionData.actions, { symbol, initialCash });
  const runFingerprint = digestJson({
    manifestFingerprint: manifestFingerprint(manifest),
    dataFingerprint: data.dataFingerprint,
    actionFingerprint: actionData.dataFingerprint,
    strategy: simulation.strategy,
    symbol,
    initialCash,
  });
  return {
    ...baseArtifact("backtest-run", "PASS", sourceEvidence(manifest), warnings),
    runId: runFingerprint.slice(0, 24),
    manifestPath,
    manifestFingerprint: manifestFingerprint(manifest),
    datasetId: manifest.datasetId,
    sourceObjects: data.sourceObjects,
    catalogFingerprint: data.catalogFingerprint,
    dataFingerprint: data.dataFingerprint,
    actionFingerprint: actionData.dataFingerprint,
    actionSourceUri: actionData.sourceUri,
    bars: barSummary(filterBars(data.bars, { symbol })),
    simulation,
    session: {
      declared: manifest.session,
      verification: "DECLARED_UNVERIFIED",
    },
    networkAccessAttempted: networkAccessAttempted(manifest, options.allowNetwork),
  };
}

export async function fetchActions(
  query: AlpacaActionQuery,
  options: { env?: NodeJS.ProcessEnv; runner?: AlpacaCliRunner; maxPages?: number } = {},
): Promise<AlpacaFetchResult> {
  return fetchAlpacaCorporateActions(query, options);
}

export async function writeFetchedActions(
  outputPath: string,
  result: AlpacaFetchResult,
): Promise<{ path: string; sha256: string; receipt: string }> {
  const payload = { schemaVersion: 1, provider: "alpaca", actions: result.actions };
  await atomicWriteJson(outputPath, payload, { directoryMode: 0o750, fileMode: 0o640, pretty: true });
  const bytes = await readFile(outputPath);
  return {
    path: outputPath,
    sha256: sha256Hex(bytes),
    receipt: result.receipt.dataFingerprint,
  };
}
