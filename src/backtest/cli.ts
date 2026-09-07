import { config as loadEnvConfig } from "dotenv";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fetchActions,
  runAudit,
  runBacktest,
  runParity,
  runPreflight,
  writeArtifact,
  writeFetchedActions,
} from "./workflow.ts";

type FlagValue = string | boolean;
type Flags = ReadonlyMap<string, FlagValue>;

function parseFlags(args: readonly string[]): { command: string; flags: Flags } {
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "help";
  const flags = new Map<string, FlagValue>();
  let index = command === "help" && args[0]?.startsWith("-") ? 0 : 1;
  while (index < args.length) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error("BACKTEST_CLI_UNEXPECTED_ARGUMENT");
    const equals = token.indexOf("=");
    const key = (equals > 0 ? token.slice(2, equals) : token.slice(2)).trim();
    if (!key || key === "help") {
      flags.set("help", true);
      index += 1;
      continue;
    }
    if (equals > 0) {
      flags.set(key, token.slice(equals + 1));
      index += 1;
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 2;
    } else {
      flags.set(key, true);
      index += 1;
    }
  }
  return { command, flags };
}

function flag(flags: Flags, name: string): FlagValue | undefined {
  return flags.get(name);
}

function stringFlag(flags: Flags, name: string, required = false): string | undefined {
  const value = flag(flags, name);
  if (value === true || value === false || value === undefined) {
    if (required) throw new Error("BACKTEST_CLI_FLAG_REQUIRED_" + name.toUpperCase().replaceAll("-", "_"));
    return undefined;
  }
  const text = value.trim();
  if (!text && required) throw new Error("BACKTEST_CLI_FLAG_REQUIRED_" + name.toUpperCase().replaceAll("-", "_"));
  return text || undefined;
}

function boolFlag(flags: Flags, name: string): boolean {
  const value = flag(flags, name);
  if (value === true) return true;
  if (value === undefined) return false;
  if (value === false) return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("BACKTEST_CLI_BOOLEAN_INVALID_" + name.toUpperCase().replaceAll("-", "_"));
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("BACKTEST_CLI_NUMBER_INVALID_" + name.toUpperCase().replaceAll("-", "_"));
  return number;
}

function manifestFlag(flags: Flags): string {
  return stringFlag(flags, "manifest", true) as string;
}

function outputDirFlag(flags: Flags): string {
  return resolve(stringFlag(flags, "output-dir") ?? ".artifacts/backtest");
}

function loadEnvironment(flags: Flags): void {
  const envPath = stringFlag(flags, "env-file");
  loadEnvConfig({ path: envPath ?? ".env", quiet: true });
}

function printHelp(): void {
  process.stdout.write([
    "Read-only historical 1-minute backtest CLI",
    "",
    "Commands:",
    "  preflight --manifest FILE [--env-file FILE] [--output-dir DIR]",
    "  audit --manifest FILE [--allow-network] [--env-file FILE] [--output-dir DIR]",
    "  parity --left FILE --right FILE [--allow-network] [--output-dir DIR]",
    "  run --manifest FILE [--symbol AAPL] [--initial-cash 100000] [--allow-network] [--env-file FILE]",
    "  fetch-actions --symbols AAPL,MSFT --since 2016-01-01 --until 2016-12-31",
    "               --allow-network [--env-file FILE] [--output-dir DIR]",
    "",
    "Network is disabled unless --allow-network is explicitly present.",
    "OSS access is exact-object HEAD/GET only; no LIST, PUT, DELETE, latest, or glob.",
  ].join("\n") + "\n");
}

async function runCommand(command: string, flags: Flags): Promise<unknown> {
  if (command === "help" || boolFlag(flags, "help")) {
    printHelp();
    return { status: "PASS", kind: "backtest-help" };
  }
  loadEnvironment(flags);
  const outputDir = outputDirFlag(flags);
  await mkdir(outputDir, { recursive: true, mode: 0o750 });
  const allowNetwork = boolFlag(flags, "allow-network");
  if (command === "preflight") {
    const report = await runPreflight(manifestFlag(flags));
    const artifactPath = await writeArtifact(outputDir, "preflight.json", report);
    return { ...report, artifactPath };
  }
  if (command === "audit") {
    const report = await runAudit(manifestFlag(flags), { allowNetwork });
    const artifactPath = await writeArtifact(outputDir, "audit.json", report);
    return { ...report, artifactPath };
  }
  if (command === "parity") {
    const left = stringFlag(flags, "left", true) as string;
    const right = stringFlag(flags, "right", true) as string;
    const report = await runParity(left, right, { allowNetwork });
    const artifactPath = await writeArtifact(outputDir, "parity.json", report);
    return { ...report, artifactPath };
  }
  if (command === "run") {
    const report = await runBacktest(manifestFlag(flags), {
      symbol: stringFlag(flags, "symbol"),
      initialCash: numberFlag(flags, "initial-cash", 100_000),
      allowNetwork,
    });
    const artifactPath = await writeArtifact(outputDir, String(report.runId) + ".json", report);
    return { ...report, artifactPath };
  }
  if (command === "fetch-actions") {
    if (!allowNetwork) throw new Error("ALPACA_NETWORK_REQUIRES_ALLOW_NETWORK");
    const symbols = (stringFlag(flags, "symbols", true) as string).split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
    const since = stringFlag(flags, "since", true) as string;
    const until = stringFlag(flags, "until", true) as string;
    const result = await fetchActions({
      symbols,
      since,
      until,
    }, { maxPages: numberFlag(flags, "max-pages", 10) });
    const actionsPath = resolve(stringFlag(flags, "actions-out") ?? (outputDir + "/alpaca-actions.json"));
    await mkdir(dirname(actionsPath), { recursive: true, mode: 0o750 });
    const stored = await writeFetchedActions(actionsPath, result);
    const receipt = {
      artifactVersion: 1,
      kind: "alpaca-corporate-actions-receipt",
      status: "PASS",
      evidenceClass: result.receipt.evidenceClass,
      readOnly: true,
      brokerWriteAttempted: false,
      actionsPath: stored.path,
      actionsSha256: stored.sha256,
      receipt: result.receipt,
      warnings: ["PROVIDER_ACTIONS_MUST_BE_REVIEWED_BEFORE_MANIFEST_USE"],
    };
    const receiptPath = await writeArtifact(outputDir, "alpaca-actions-receipt.json", receipt);
    return { ...receipt, receiptPath };
  }
  throw new Error("BACKTEST_CLI_COMMAND_UNKNOWN_" + command);
}

export async function runBacktestCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    const { command, flags } = parseFlags(args);
    const result = await runCommand(command, flags);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (
      result && typeof result === "object" && "status" in result
      && result.status !== "PASS"
      && command !== "help"
    ) {
      process.exitCode = 2;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "BACKTEST_CLI_FAILED";
    process.stderr.write(JSON.stringify({ status: "FAIL", errorCode: code }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runBacktestCli();
}
