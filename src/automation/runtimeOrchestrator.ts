import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SchwabActivityStream, type ActivityBatch } from "./stream/activityStream.ts";
import { beginLogin, login, requireWeeklyReauthorization, SchwabTokenProvider, type AutomationAuthOptions } from "./auth/provider.ts";
import { UnauthorizedRefreshCoordinator } from "./auth/unauthorizedRefresh.ts";
import { runInteractiveLogin } from "./auth/cli.ts";
import { createWeeklyReauthorizationEnsurer } from "./auth/weeklyReauthorization.ts";
import { PriorityGate, PriorityWriter, type Priority } from "./scheduling/priorityRuntime.ts";
import { RequestBudget } from "./scheduling/requestBudget.ts";
import { ExplorerActionPacer } from "./scheduling/explorerActionPacer.ts";
import { SchwabRestClient } from "./broker/schwabClient.ts";
import { SchwabApiError } from "../utils/errors.ts";
import { atomicWriteJson } from "../utils/atomicJson.ts";
import { parseRuntimePolicy } from "./policy/runtime.ts";
import { EXIT_ORDER_PRICE, orderInfo, orderPolicyViolation, type Json } from "./policy/order.ts";
import {
  buildPrimaryActiveOpeningOrderIds,
  managedOpeningInfo,
  selectActiveOpeningOrders,
} from "./orderIndex.ts";
import { completeNetDebitFill, completeOrderLimitFill } from "./execution/fillPrice.ts";
import { MAX_ACTIVE_ORDERS, PriceExplorer, type ExplorerAction } from "./execution/priceExplorer.ts";
import { ExecutionJournal } from "./observability/executionJournal.ts";
import { DurableJsonlWriter } from "./observability/durableJsonl.ts";
import { safeRuntimeError } from "./observability/runtimeError.ts";
import { EXIT_IDLE_BUY_FILL_DELAY_MS, EXIT_REFRESH_MS, LIQUIDITY_EXIT_DELAY_MS, LIQUIDITY_EXIT_REFRESH_MS, LIQUIDITY_EXIT_REFRESH_ROUNDS, exitEligibility, exitRefreshNeeded, maySubmitExit } from "./policy/exit.ts";
import { acquireRuntimeLock } from "./state/runtimeLock.ts";
import { ExitTemplateStateStore, FixedPriceCycleStateStore, PriceExplorerStateStore } from "./state/runtimeStateStores.ts";
import { FixedPriceReplenishmentGuard, STALE_ORDER_RECREATE_RETRY_MS, mayRecreateStaleOrder, mayRecoverFixedPriceFill, mayReplenishFixedPrice } from "./execution/fixedPriceCycle.ts";
import { effectiveFixedPriceRefreshIntervalMs, FixedPriceRefreshPacer } from "./scheduling/refreshPacer.ts";
import { RefreshRoundLimit } from "./scheduling/refreshRoundLimit.ts";
import { classifyPreviewRejection, previewRejectionCooldownFromError, previewRejectionDetails, previewRejectionSummary } from "./execution/previewRejection.ts";
import { ACTIVITY_REST_DEBOUNCE_MS, ACTIVITY_REST_MIN_INTERVAL_MS, nextActivityRestConfirmationAt } from "./scheduling/activityPacer.ts";
import { FULL_SNAPSHOT_MAX_AGE_MS, isFullSnapshotFresh } from "./policy/fullSnapshotFreshness.ts";
import {
  formatFixedPriceRebuy,
  formatFixedPriceReplace,
  formatRefreshSpreadSkipped,
} from "./observability/businessLog.ts";
import { FixedPriceRefreshRoundGuard } from "./execution/fixedPriceRoundGuard.ts";
import { refreshAuthoritativeSnapshots } from "./policy/refreshPreflight.ts";
import {
  EXISTING_ORDER_REPLACE_NO_PREVIEW,
  orderWritePreflight,
  replacementSourceViolation,
  type OrderWritePreflight,
} from "./execution/orderWritePreflight.ts";
import {
  appendBrokerRateLimit,
  brokerRateLimitFromHeaders,
  type BrokerRateLimit,
} from "./broker/rateLimit.ts";
import {
  RefreshSpreadSkipTracker,
  REQUIRED_REFRESH_SPREAD_WIDTH,
  isRefreshSpreadEligible,
  refreshSpreadWidth,
} from "./policy/refreshOrder.ts";
import { BrokerWriteCoordinator } from "./broker/writeCoordinator.ts";
import { OrderSnapshotCoordinator, RuntimeStartupCoordinator } from "./broker/orderSnapshotCoordinator.ts";
import {
  fingerprintOrder,
  safePath,
  UnknownWriteReconciliation,
  type UnknownWriteFailure,
} from "./state/unknownWriteReconciliation.ts";
import { bindRuntimeAbortSignal, bindRuntimeProcessHandlers } from "./runtimeProcess.ts";
import { defaultAutomationRuntimeEntryPath, repositoryRootFromAutomationModuleUrl } from "./repositoryPaths.ts";
import { resolveAutomationRuntimeHost, type AutomationRuntimeOptions } from "./runtimeHost.ts";
import { superviseBackgroundTask } from "./backgroundTask.ts";

/**
 * Production automation composition and lifecycle orchestrator.
 * Broker mutation invariants stay behind the existing write coordinator, WAL,
 * reconciliation and snapshot-freshness gates. src/main.ts remains a stable
 * executable boundary for process management and hot-switch tooling.
 */
export async function runAutomationRuntime(options: AutomationRuntimeOptions = {}): Promise<void> {
const codeRoot = repositoryRootFromAutomationModuleUrl(import.meta.url);
const host = resolveAutomationRuntimeHost(options, {
  entryPath: defaultAutomationRuntimeEntryPath(import.meta.url),
  workspaceRoot: codeRoot,
});
const root = host.workspaceRoot;
const automationAuthOptions: AutomationAuthOptions = {
  env: host.env,
  statePath: host.env.SCHWAB_BOT_AUTH_FILE || join(root, "state", "schwab-auth.json"),
};
const evidencePath = join(root, ".state", "send-evidence.jsonl");
const policyAlertPath = join(root, ".state", "policy-alerts.jsonl");
const explorerStatePath = join(root, ".state", "net-price-explorer.json");
const fixedPriceCycleStatePath = join(root, ".state", "fixed-price-cycle.json");
const exitTemplateStatePath = join(root, ".state", "exit-templates.json");
const runtimeStatePath = join(root, ".state", "runtime", "active-run.json");
const runtimeControlPath = join(root, ".state", "runtime", "control-request.json");
const runtimeLockPath = join(root, ".state", "runtime", "active-run.lock");
const unknownWriteStatePath = join(root, ".state", "unknown-writes.json");
const runId = randomUUID();
const runtimeStartedAt = Date.now();
const PREVIEW_REJECTION_COOLDOWN_MS = 30_000;
let executionJournalPersistenceFault: unknown = null;
let executionJournalStopHandler: (() => void) | null = null;
const executionJournal = new ExecutionJournal(root, runId, (error) => {
  executionJournalPersistenceFault ??= error;
  host.stderr.write(`${new Date().toISOString()} EXECUTION_JOURNAL_WRITE_FAILED error=${safeRuntimeError(error)}\n`);
  executionJournalStopHandler?.();
});
let operationalAuditStopHandler: ((source: string) => void) | null = null;
function noteOperationalAuditFailure(source: string, error: unknown): void {
  host.stderr.write(`${new Date().toISOString()} OPERATIONAL_AUDIT_WRITE_FAILED source=${source} error=${safeRuntimeError(error)}\n`);
  operationalAuditStopHandler?.(source);
}
const sendEvidenceAudit = new DurableJsonlWriter(evidencePath, {
  failureCode: "SEND_EVIDENCE_PERSISTENCE_FAILED",
  onFailure: (error) => noteOperationalAuditFailure("send-evidence", error),
});
const policyAlertAudit = new DurableJsonlWriter(policyAlertPath, {
  failureCode: "POLICY_ALERT_PERSISTENCE_FAILED",
  onFailure: (error) => noteOperationalAuditFailure("policy-alert", error),
});
const working = new Set(["PENDING_ACTIVATION", "QUEUED", "WORKING", "PARTIALLY_FILLED", "AWAITING_PARENT_ORDER"]);
const readOnly = host.argv.includes("--read-only");
const once = host.argv.includes("--once");
const confirmIndex = host.argv.indexOf("--confirm-live");
const confirmedLive = confirmIndex >= 0 && host.argv[confirmIndex + 1] === "I_UNDERSTAND";
if (!readOnly && !confirmedLive) {
  throw new Error("真实写入必须显式传入 --confirm-live I_UNDERSTAND");
}
const policy = parseRuntimePolicy(host.argv);
const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId, host.pid);
let unbindRuntimeProcessHandlers = () => {};
let unbindRuntimeAbortSignal = () => {};
try {
let sellOrderAutomationDisabledRecorded = false;
let latestBrokerRateLimit: BrokerRateLimit | null = null;
const singaporeLogFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Singapore", dateStyle: "short", timeStyle: "medium", hour12: false,
});
const newYorkDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

function stamp(message: string): void {
  const value = singaporeLogFormatter.format(new Date());
  const renderedMessage = appendBrokerRateLimit(message, latestBrokerRateLimit);
  host.stderr.write(`${value} ${renderedMessage}\n`);
  executionJournal.record("console", {
    message: renderedMessage,
    brokerRateLimit: latestBrokerRateLimit,
  });
}

function handleRuntimeStateWriteFailure(store: string, error: unknown): void {
  const code = safeRuntimeError(error);
  executionJournal.record("runtime.state-persistence-failed", { store, code });
  stamp(`RUNTIME_STATE_PERSISTENCE_FAILED store=${store} error=${code}`);
  requestStop(`state-persistence-failed:${store}`);
}

const explorerStateStore = new PriceExplorerStateStore(explorerStatePath, {
  readOnly,
  onWriteFailure: (error) => handleRuntimeStateWriteFailure("price-explorer", error),
});
const fixedPriceCycleStateStore = new FixedPriceCycleStateStore(fixedPriceCycleStatePath, {
  readOnly,
  onWriteFailure: (error) => handleRuntimeStateWriteFailure("fixed-price-cycle", error),
});
const exitTemplateStateStore = new ExitTemplateStateStore(exitTemplateStatePath, {
  readOnly,
  onWriteFailure: (error) => handleRuntimeStateWriteFailure("exit-template", error),
});

const ensureWeeklyReauthorization = createWeeklyReauthorizationEnsurer({
  requireWeeklyReauthorization: () => requireWeeklyReauthorization(new Date(), automationAuthOptions),
  reauthorizeInteractively: host.reauthorizeInteractively ?? (() => runInteractiveLogin({
    beginLogin: () => beginLogin(automationAuthOptions),
    login: (callbackUrl, state) => login(callbackUrl, state, automationAuthOptions),
  })),
  onReauthorizationRequired: () => {
    executionJournal.record("auth.weekly-reauth-required", { action: "interactive-login" });
    stamp("AUTH_WEEKLY_REAUTH_REQUIRED: interactive OAuth login is required before broker writes; browser opening now");
  },
  onReauthorized: () => {
    executionJournal.record("auth.weekly-reauthorized", { action: "interactive-login" });
    stamp("AUTH_WEEKLY_REAUTHORIZED: weekly OAuth authorization confirmed; broker-write guards remain active");
  },
});

function recordSellOrderAutomationDisabled(): void {
  if (sellOrderAutomationDisabledRecorded) return;
  sellOrderAutomationDisabledRecorded = true;
  executionJournal.record("exit.automation.disabled", {
    reason: "cli-disable-sell-orders",
    existingWorkingSellOrders: "left-unchanged",
  });
}

function isClosingPayload(payload: Json): boolean {
  return info(payload)?.closing === true
    || (Array.isArray(payload.orderLegCollection) && payload.orderLegCollection.some((leg: Json) =>
      ["SELL_TO_CLOSE", "BUY_TO_CLOSE"].includes(String(leg.instruction)),
    ));
}

async function writeRuntimeState(state: "running" | "stopping" | "stopped", reason?: string): Promise<void> {
  const value = {
    schemaVersion: 1,
    state,
    reason: reason ?? null,
    runId,
    pid: host.pid,
    workspaceRoot: root,
    nodePath: host.execPath,
    entryPath: host.entryPath,
    buildId: host.env.SCHWAB_BOT_BUILD_ID ?? null,
    args: host.argv.slice(2),
    journalPath: executionJournal.path,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(runtimeStatePath, value);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function persistExplorer(): void {
  explorerStateStore.save(explorer);
}

function persistFixedPriceCycle(): void {
  fixedPriceCycleStateStore.save(fixedPriceCycleConsumedFills);
}

const tokens = new SchwabTokenProvider(stamp, automationAuthOptions);
const unauthorizedRefresh = new UnauthorizedRefreshCoordinator({
  refresh: () => tokens.get(true),
  onFailure: (code) => {
    executionJournal.record("auth.background-refresh-failed", { source: "broker-401", code });
    stamp(`AUTH_BACKGROUND_REFRESH_FAILED code=${code}`);
  },
});
const budget = new RequestBudget({
  onRefreshHeadroomWait: ({ usedLast60s, refreshCeiling }) => {
    stamp(`整体刷新等待滚动配额释放 usedLast60s=${usedLast60s} refreshCeiling=${refreshCeiling}`);
  },
  onRateLimited: (seconds) => stamp(`Schwab 429，全局退避 ${seconds}s`),
});
const client = new SchwabRestClient();

async function api(
  path: string,
  init: RequestInit = {},
  priority: Priority = 0,
): Promise<{ body: any; headers: Headers; status: number }> {
  await budget.admit(priority);
  const token = await tokens.get();
  try {
    const response = await client.request<any>(path, init, token);
    latestBrokerRateLimit = brokerRateLimitFromHeaders(response.headers);
    return response;
  } catch (error) {
    if (error instanceof SchwabApiError) {
      latestBrokerRateLimit = brokerRateLimitFromHeaders(error.headers);
      if (error.status === 429) budget.rateLimited(error.headers["retry-after"] ?? null);
      if (error.status === 401 && unauthorizedRefresh.schedule()) {
        executionJournal.record("auth.background-refresh-scheduled", { source: "broker-401" });
      }
      throw Object.assign(new Error(`SCHWAB_HTTP_${error.status}`), {
        status: error.status,
        statusText: error.statusText,
        headers: { ...error.headers },
        requestId: error.requestId,
        method: error.method ?? init.method ?? "GET",
        path,
        isNetworkError: error.isNetworkError === true,
        cause: error,
      });
    }
    throw error;
  }
}

const writer = new PriorityWriter(stamp);
const finalWriteGate = new PriorityGate();
let accountHash = "";
let orders: Json[] = [];
let polling = false;
let fullSnapshotReconciled = false;
const evaluatingExitStrategies = new Set<string>();
let lastFullOrderPollAt = 0;
let stopping = false;
let stopReason = "normal";
executionJournalStopHandler = () => {
  requestStop("execution-journal-persistence-failed");
};
if (executionJournalPersistenceFault !== null) executionJournalStopHandler();
operationalAuditStopHandler = (source) => {
  requestStop(`operational-audit-persistence-failed:${source}`);
};
let controlCheckRunning = false;
let activityRestTimer: NodeJS.Timeout | null = null;
const runtimeIntervals: NodeJS.Timeout[] = [];
let activityRestRunning = false;
let fixedPriceRefreshRoundActive = false;
let lastIncompleteActivityAt = 0;
let lastActivityRestAt = 0;
let lastFillPollAt = 0;
const staleExitRecreateInFlight = new Set<string>();
const staleExitRetryAt = new Map<string, number>();
const openingFillLots = new Map<string, Map<string, number>>();
const lastOpeningFillAt = new Map<string, number>();
const inventoryObservedAt = new Map<string, number>();
const inventoryByStrategy = new Map<string, number>();
const observedFillQuantities = new Map<string, number>();
let inventoryFillBaselineEstablished = false;
const unknownWriteReconciliation = new UnknownWriteReconciliation(unknownWriteStatePath);
let unknownWritePersistenceFault: unknown = null;
const reportedUnknownPending = new Map<string, string>();
const sellDue = new Map<string, number>();
const sellSubmitDue = new Map<string, number>();
const sellSubmitInFlight = new Set<string>();
const cancelingSells = new Set<string>();
await unknownWriteReconciliation.load();
const exitGateStates = new Map<string, string>();
const liquidityExitRefreshes = new Map<string, { sellAt: number; remainingRefreshes: number; nextAt: number }>();
const exitWorkerTimers = new Map<string, { dueAt: number; timer: NodeJS.Timeout }>();
let exitPositionSnapshot: { at: number; epoch: number; positions: Map<string, { long: number; short: number }> } | null = null;
let exitPositionSnapshotPending: Promise<{ epoch: number; positions: Map<string, { long: number; short: number }> }> | null = null;
let exitPositionSnapshotEpoch = 0;
const previewRejectedUntil = new Map<string, number>();
const reportedPolicyAlerts = new Set<string>();
const REFILL_WRITE_PRIORITY_SETTLEMENT_MS = 5_000;
const explorer = await explorerStateStore.load();
const fixedPriceCycleConsumedFills = await fixedPriceCycleStateStore.load();
// A strategy has at most one fixed-price opening order.  Reserve its refill
// slot before a refill Submit's Preview so activity confirmation and a full snapshot cannot
// race each other into duplicate buy submissions.
const fixedPriceReplenishmentGuard = new FixedPriceReplenishmentGuard();
let replenishmentWritePriorityUntil = 0;
const explorerTemplates = new Map<string, Json>();
const exitTemplatesByStrategy = await exitTemplateStateStore.load();
const reportedUnpricedFills = new Set<string>();
const reportedHistoricalFixedPriceFills = new Set<string>();
const normalExplorerActionPacer = new ExplorerActionPacer({ cooldownMs: policy.orderCooldownMs });
const fixedPriceRefreshPacer = new FixedPriceRefreshPacer();
const refreshRoundLimit = new RefreshRoundLimit(policy.maxRefreshRounds);
const fixedPriceRefreshRoundGuard = new FixedPriceRefreshRoundGuard();
const observedOrderStates = new Map<string, { status: string; filledQuantity: number; price: string; closeTime: string | null }>();
const refreshSpreadSkipTracker = new RefreshSpreadSkipTracker();
const deferredExplorerRetries = new Map<string, { attempts: number; nextAt: number }>();
const EXPLORER_FUNDING_RETRY_MS = LIQUIDITY_EXIT_DELAY_MS + LIQUIDITY_EXIT_REFRESH_MS * LIQUIDITY_EXIT_REFRESH_ROUNDS;

function flatten(source: any[]): Json[] {
  const output: Json[] = [];
  const visit = (order: Json): void => {
    output.push(order);
    for (const child of order.childOrderStrategies ?? []) visit(child);
  };
  for (const order of source) visit(order);
  return output;
}

function info(order: Json) { return orderInfo(order); }

function orderId(order: Json): string { return String(order.orderId); }
function quantity(order: Json): number { return Number(order.quantity ?? 0); }
function remaining(order: Json): number {
  return Math.max(0, quantity(order) - Number(order.filledQuantity ?? 0));
}
function eventTime(order: Json): number {
  return Date.parse(order.closeTime ?? order.cancelTime ?? order.enteredTime ?? 0);
}

function recordOpeningFillLot(strategy: string, order: Json): void {
  if (order.status !== "FILLED") return;
  const filledAt = Date.parse(String(order.closeTime ?? ""));
  if (!Number.isFinite(filledAt)) return;
  const lots = openingFillLots.get(strategy) ?? new Map<string, number>();
  const firstObserved = !lots.has(orderId(order));
  lots.set(orderId(order), filledAt);
  openingFillLots.set(strategy, lots);
  lastOpeningFillAt.set(strategy, Math.max(lastOpeningFillAt.get(strategy) ?? 0, filledAt));
  rememberExitTemplate(strategy, order);
  if (firstObserved && !readOnly && !policy.disableSellOrders && mayRecoverFixedPriceFill(filledAt, runtimeStartedAt)) {
    scheduleExitWorker(strategy, order, Math.max(Date.now(), filledAt + EXIT_IDLE_BUY_FILL_DELAY_MS), "opening-fill-idle-deadline");
  }
}

function orderAuditData(order: Json): Record<string, unknown> {
  const meta = info(order);
  return {
    orderId: orderId(order),
    status: String(order.status ?? "UNKNOWN"),
    price: order.price ?? null,
    quantity: quantity(order),
    filledQuantity: Number(order.filledQuantity ?? 0),
    enteredAt: order.enteredTime ?? null,
    closeTime: order.closeTime ?? null,
    cancelTime: order.cancelTime ?? null,
    strategyKey: meta?.key ?? null,
    direction: meta?.opening ? "opening" : meta?.closing ? "closing" : null,
    legs: Array.isArray(order.orderLegCollection) ? order.orderLegCollection.map((leg: Json) => ({
      instruction: leg.instruction ?? null,
      symbol: leg.instrument?.symbol ?? null,
      quantity: leg.quantity ?? null,
    })) : [],
  };
}

function payloadAuditData(payload: Json): Record<string, unknown> {
  return {
    orderType: payload.orderType ?? null,
    price: payload.price ?? null,
    quantity: payload.quantity ?? null,
    complexOrderStrategyType: payload.complexOrderStrategyType ?? null,
    legs: Array.isArray(payload.orderLegCollection) ? payload.orderLegCollection.map((leg: Json) => ({
      instruction: leg.instruction ?? null,
      symbol: leg.instrument?.symbol ?? null,
      quantity: leg.quantity ?? null,
    })) : [],
  };
}

function unknownOperation(method: "POST" | "PUT" | "DELETE"): UnknownWriteFailure["operation"] {
  return method === "POST" ? "PLACE_ORDER" : method === "PUT" ? "REPLACE_ORDER" : "CANCEL_ORDER";
}

function baselineOrderIds(payload: Json, targetOrderId?: string): string[] {
  const payloadFingerprint = fingerprintOrder(payload);
  const ids = orders
    .filter((order) => fingerprintOrder(order) === payloadFingerprint)
    .map(orderId);
  if (targetOrderId) ids.push(targetOrderId);
  return [...new Set(ids)];
}

function assertOperationalAuditsHealthy(): void {
  executionJournal.assertHealthy();
  sendEvidenceAudit.assertHealthy();
  policyAlertAudit.assertHealthy();
}

function assertBrokerWritesAllowed(
  key: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  ignoredIntentId?: string,
): void {
  assertOperationalAuditsHealthy();
  if (!fullSnapshotReconciled) {
    executionJournal.record("broker.write.blocked", {
      key, method, path: safePath(path), reason: "full-snapshot-reconciliation-required",
    });
    throw new Error("FULL_SNAPSHOT_RECONCILIATION_REQUIRED");
  }
  if (!isFullSnapshotFresh(lastFullOrderPollAt)) {
    executionJournal.record("broker.write.blocked", {
      key,
      method,
      path: safePath(path),
      reason: "full-snapshot-stale",
      lastFullOrderPollAt,
      maxAgeMs: FULL_SNAPSHOT_MAX_AGE_MS,
    });
    throw new Error("FULL_SNAPSHOT_RECONCILIATION_REQUIRED");
  }
  if (unknownWritePersistenceFault) {
    executionJournal.record("broker.write.blocked", {
      key,
      method,
      path: safePath(path),
      reason: "unknown-write-state-persistence-fault",
    });
    throw new Error("UNKNOWN_WRITE_STATE_PERSISTENCE_FAILED");
  }
  const unresolved = unknownWriteReconciliation.pending().filter((record) => record.id !== ignoredIntentId);
  if (unresolved.length === 0) return;
  executionJournal.record("broker.write.blocked", {
    key,
    method,
    path: safePath(path),
    reason: "unknown-write-pending-reconciliation",
    pendingCount: unresolved.length,
  });
  throw new Error("UNKNOWN_WRITE_PENDING_RECONCILIATION");
}

async function beginUnknownWrite(failure: UnknownWriteFailure) {
  try {
    const record = await unknownWriteReconciliation.beginWrite(failure);
    executionJournal.record("broker.write.intent-persisted", {
      id: record.id,
      phase: record.phase,
      operation: record.operation,
      method: record.method,
      key: record.key,
      path: record.path,
      pathFingerprint: record.pathFingerprint,
      payloadFingerprint: record.payloadFingerprint,
      baselineOrderIds: record.baselineOrderIds,
      targetOrderId: record.targetOrderId,
      targetFingerprint: record.targetFingerprint,
      preSendAt: record.preSendAt,
      createdAt: record.createdAt,
    });
    return record;
  } catch (error) {
    unknownWritePersistenceFault = error;
    executionJournal.record("broker.write.unknown-persistence-failed", {
      operation: failure.operation,
      method: failure.method,
    });
    stamp("UNKNOWN_WRITE_STATE_PERSISTENCE_FAILED: all broker writes are now blocked");
    throw new Error("UNKNOWN_WRITE_STATE_PERSISTENCE_FAILED");
  }
}


async function completeUnknownWrite(
  id: string,
  operation: UnknownWriteFailure["operation"],
  key: string,
  outcome: "confirmed" | "not-sent" = "confirmed",
): Promise<void> {
  try {
    await unknownWriteReconciliation.completeWrite(id);
    executionJournal.record("broker.write.ledger-cleared", { id, operation, key, outcome });
  } catch (error) {
    unknownWritePersistenceFault = error;
    executionJournal.record("broker.write.unknown-persistence-failed", { operation, key });
    stamp("UNKNOWN_WRITE_STATE_PERSISTENCE_FAILED: all broker writes are now blocked");
    throw new Error("UNKNOWN_WRITE_STATE_PERSISTENCE_FAILED");
  }
}

async function settleUnknownWrite(
  id: string,
  operation: UnknownWriteFailure["operation"],
  key: string,
  outcome: Pick<UnknownWriteFailure, "status" | "reason">,
): Promise<Awaited<ReturnType<UnknownWriteReconciliation["settleWrite"]>>> {
  try {
    const record = await unknownWriteReconciliation.settleWrite(id, outcome);
    if (!record) {
      executionJournal.record("broker.write.ledger-cleared", { id, operation, key, outcome: "explicit-4xx" });
      return null;
    }
    executionJournal.record("broker.write.unknown-persisted", {
      id: record.id,
      phase: record.phase,
      operation: record.operation,
      method: record.method,
      key: record.key,
      path: record.path,
      pathFingerprint: record.pathFingerprint,
      payloadFingerprint: record.payloadFingerprint,
      baselineOrderIds: record.baselineOrderIds,
      targetOrderId: record.targetOrderId,
      targetFingerprint: record.targetFingerprint,
      preSendAt: record.preSendAt,
      createdAt: record.createdAt,
      reason: record.reason,
      status: record.status,
    });
    stamp("UNKNOWN_WRITE_PENDING operation=" + record.operation + " key=" + record.key + " id=" + record.id + " reason=" + record.reason);
    return record;
  } catch (error) {
    unknownWritePersistenceFault = error;
    executionJournal.record("broker.write.unknown-persistence-failed", { operation, key });
    stamp("UNKNOWN_WRITE_STATE_PERSISTENCE_FAILED: all broker writes are now blocked");
    throw new Error("UNKNOWN_WRITE_STATE_PERSISTENCE_FAILED");
  }
}

async function reconcileUnknownWritesAfterFullSnapshot(): Promise<void> {
  try {
    const result = await unknownWriteReconciliation.reconcile(orders);
  for (const record of result.resolved) {
    reportedUnknownPending.delete(record.id);
    executionJournal.record("broker.write.unknown-reconciled", {
      id: record.id,
      operation: record.operation,
      method: record.method,
      key: record.key,
      path: record.path,
      targetOrderId: record.targetOrderId,
      reason: record.reason,
    });
    stamp(`UNKNOWN_WRITE_RECONCILED operation=${record.operation} key=${record.key} id=${record.id}`);
  }
  for (const item of result.pending) {
    const signature = `${item.reason}:${item.matchingOrderCount}`;
    if (reportedUnknownPending.get(item.record.id) === signature) continue;
    reportedUnknownPending.set(item.record.id, signature);
    executionJournal.record("broker.write.unknown-still-pending", {
      id: item.record.id,
      operation: item.record.operation,
      method: item.record.method,
      key: item.record.key,
      path: item.record.path,
      targetOrderId: item.record.targetOrderId,
      reason: item.reason,
      matchingOrderCount: item.matchingOrderCount,
    });
    stamp(`UNKNOWN_WRITE_PENDING operation=${item.record.operation} key=${item.record.key} id=${item.record.id} reconciliation=${item.reason}`);
  }
  } catch (error) {
    unknownWritePersistenceFault = error;
    executionJournal.record("broker.write.unknown-persistence-failed", { operation: "RECONCILIATION", method: "READ_ONLY" });
    stamp("UNKNOWN_WRITE_STATE_PERSISTENCE_FAILED: all broker writes are now blocked");
    throw error;
  }
}

const coordinatorIntentMetadata = new Map<string, { operation: UnknownWriteFailure["operation"]; key: string }>();
const brokerWriteCoordinator = new BrokerWriteCoordinator({
  ledger: {
    beginWrite: async (failure) => {
      const record = await beginUnknownWrite(failure);
      coordinatorIntentMetadata.set(record.id, { operation: failure.operation, key: failure.key });
      return record;
    },
    completeWrite: async (id) => {
      const metadata = coordinatorIntentMetadata.get(id);
      await completeUnknownWrite(id, metadata?.operation ?? "PLACE_ORDER", metadata?.key ?? "coordinator");
      coordinatorIntentMetadata.delete(id);
    },
    discardWrite: async (id) => {
      const metadata = coordinatorIntentMetadata.get(id);
      await completeUnknownWrite(
        id,
        metadata?.operation ?? "PLACE_ORDER",
        metadata?.key ?? "coordinator",
        "not-sent",
      );
      coordinatorIntentMetadata.delete(id);
    },
    settleWrite: async (id, outcome) => {
      const metadata = coordinatorIntentMetadata.get(id);
      const record = await settleUnknownWrite(id, metadata?.operation ?? "PLACE_ORDER", metadata?.key ?? "coordinator", outcome);
      if (!record) coordinatorIntentMetadata.delete(id);
      return record;
    },
  },
  transport: {
    send: async (request) => {
      const body = request.payload === undefined ? undefined : JSON.stringify(request.payload);
      const response = await api(request.path, {
        method: request.method,
        ...(body === undefined ? {} : { body }),
      }, request.transportPriority ?? 0);
      return { status: response.status, headers: response.headers };
    },
  },
  guards: {
    beforeFinalWrite: async () => {
      assertOperationalAuditsHealthy();
      await ensureWeeklyReauthorization();
      policy.requireExecutionWindow();
      assertOperationalAuditsHealthy();
    },
    beforeTransportSend: (request, intent) => {
      policy.requireExecutionWindow();
      assertBrokerWritesAllowed(request.key, request.method, request.path, intent.id);
    },
    assertReady: (request) => assertBrokerWritesAllowed(request.key, request.method, request.path),
    isStopping: () => stopping,
    isReadOnly: () => readOnly,
    onPersistenceFault: (error) => { unknownWritePersistenceFault = error; },
  },
  gate: finalWriteGate,
  emit: (event) => executionJournal.record(`broker.write.coordinator.${event.event}`, {
    key: event.request.key,
    operation: event.request.operation,
    method: event.request.method,
    path: safePath(event.request.path),
    status: event.status ?? null,
    ledgerId: event.ledgerId ?? null,
    reason: event.reason ?? null,
  }),
});

const orderSnapshotCoordinator = new OrderSnapshotCoordinator<Json>({
  fetch: async (scope, priority) => {
    const now = new Date();
    const lookbackMs = scope === "full" ? 60 * 60_000 : 5 * 60_000;
    const from = new Date(now.getTime() - lookbackMs);
    const query = new URLSearchParams({
      fromEnteredTime: from.toISOString(),
      toEnteredTime: now.toISOString(),
      maxResults: "3000",
    });
    if (scope === "fills") query.set("status", "FILLED");
    const response = await api(`/trader/v1/accounts/${accountHash}/orders?${query}`, {}, priority);
    if (!Array.isArray(response.body)) throw new Error("订单快照不是数组");
    return flatten(response.body);
  },
  reconcileUnknownWrites: async () => reconcileUnknownWritesAfterFullSnapshot(),
  onAuthoritativeReplaced: async (incoming) => {
    orders = [...incoming];
  },
  onFullReconciled: async (incoming) => {
    recordOrderTransitions("full", incoming);
    reportWorkingOrderPolicyViolations();
    reportWorkingRefreshSpreadSkips();
    reconcileExplorerSnapshot();
    executionJournal.record("orders.snapshot.synced", { scope: "full", orders: incoming.length });
  },
  onFillsMerged: async (incoming, state) => {
    orders = [...state.authoritative] as Json[];
    recordOrderTransitions("fills", incoming);
    executionJournal.record("orders.snapshot.synced", { scope: "fills", fills: incoming.length });
  },
  onFailure: (scope, error) => {
    if (scope === "full") fullSnapshotReconciled = false;
    if (!String(error).includes("REFRESH_QUOTA_HEADROOM")) {
      stamp(`订单快照失败 full=${scope === "full"} error=${safeRuntimeError(error)}`);
    }
  },
  isStopping: () => stopping,
  mergeKey: (order) => orderId(order),
});

function recordOrderTransitions(source: "full" | "fills", values: readonly Json[]): void {
  let inventoryMayHaveChanged = false;
  for (const order of values) {
    const id = orderId(order);
    const current = {
      status: String(order.status ?? "UNKNOWN"),
      filledQuantity: Number(order.filledQuantity ?? 0),
      price: String(order.price ?? ""),
      closeTime: order.closeTime ? String(order.closeTime) : null,
    };
    const previous = observedOrderStates.get(id);
    if (!previous) {
      executionJournal.record("order.observed", { source, ...orderAuditData(order) });
      if (current.filledQuantity > 0 || current.status === "FILLED") {
        inventoryMayHaveChanged = true;
        executionJournal.record("order.fill", {
          source,
          ...orderAuditData(order),
          filledAt: order.closeTime ?? null,
          deltaQuantity: current.filledQuantity,
        });
      }
    } else if (
      previous.status !== current.status
      || previous.filledQuantity !== current.filledQuantity
      || previous.price !== current.price
      || previous.closeTime !== current.closeTime
    ) {
      executionJournal.record("order.transition", { source, previous, current, ...orderAuditData(order) });
      if (current.filledQuantity > previous.filledQuantity || current.status === "FILLED") {
        inventoryMayHaveChanged = true;
        executionJournal.record("order.fill", {
          source,
          ...orderAuditData(order),
          filledAt: order.closeTime ?? null,
          deltaQuantity: current.filledQuantity - previous.filledQuantity,
        });
      }
    }
    observedOrderStates.set(id, current);
  }
  if (inventoryMayHaveChanged) invalidateExitPositionSnapshot();
}
function newYorkDate(): string {
  const parts = newYorkDateFormatter.formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function payloadFrom(order: Json, requestedQuantity = quantity(order), closing = false, openingPriceCents?: number): Json {
  const legs = order.orderLegCollection.map((leg: Json) => {
    let instruction = String(leg.instruction);
    if (closing) {
      instruction = instruction === "BUY_TO_OPEN" ? "SELL_TO_CLOSE"
        : instruction === "SELL_TO_OPEN" ? "BUY_TO_CLOSE" : instruction;
    }
    return {
      orderLegType: "OPTION",
      instruction,
      positionEffect: closing ? "CLOSING" : "OPENING",
      quantity: requestedQuantity,
      instrument: { symbol: leg.instrument.symbol, assetType: "OPTION" },
    };
  });
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: closing ? "NET_CREDIT" : "NET_DEBIT",
    price: closing ? String(EXIT_ORDER_PRICE) : openingPriceCents === undefined
      ? String(order.price) : (openingPriceCents / 100).toFixed(2),
    quantity: requestedQuantity,
    orderStrategyType: "SINGLE",
    complexOrderStrategyType: "VERTICAL",
    orderLegCollection: legs,
  };
}

function localOrder(payload: Json, id: string): Json {
  return {
    ...structuredClone(payload),
    orderId: id,
    status: "WORKING",
    enteredTime: new Date().toISOString(),
    filledQuantity: 0,
  };
}

function applyLocalSubmit(payload: Json, id: string): void {
  orders.push(localOrder(payload, id));
  observedFillQuantities.set(id, 0);
  if (info(payload)?.closing) sellDue.set(id, Date.now() + EXIT_REFRESH_MS);
}

function applyLocalReplace(sourceId: string, payload: Json, replacementId: string): void {
  const source = orders.find((order) => orderId(order) === sourceId);
  if (source) source.status = "REPLACED";
  orders.push(localOrder(payload, replacementId));
  observedFillQuantities.set(replacementId, 0);
  if (info(payload)?.closing) sellDue.set(replacementId, Date.now() + EXIT_REFRESH_MS);
}

function previewAccepted(body: any): boolean {
  const validation = body?.orderValidationResult;
  const rejects = validation?.rejects ?? [];
  const reviews = validation?.reviews ?? [];
  return Boolean(
    validation && body?.orderStrategy
    && Array.isArray(rejects) && Array.isArray(reviews)
    && rejects.length === 0 && reviews.length === 0,
  );
}

function previewBlockers(body: any): string {
  const validation = body?.orderValidationResult;
  const details = [
    ...(Array.isArray(validation?.rejects) ? validation.rejects : []),
    ...(Array.isArray(validation?.reviews) ? validation.reviews : []),
  ];
  if (!details.length) return "MISSING_OR_INVALID_PREVIEW_EVIDENCE";
  return details.map((item: Json) => {
    const raw = String(item.validationRuleName ?? item.overrideName ?? "UNKNOWN");
    return createHash("sha256").update(raw).digest("hex").slice(0, 12);
  }).join(",");
}

function requestLiquidityExit(payload: Json): void {
  if (policy.disableSellOrders) {
    executionJournal.record("exit.liquidity-suppressed", {
      reason: "cli-disable-sell-orders",
      order: payloadAuditData(payload),
    });
    return;
  }
  const meta = info(payload);
  if (!meta?.opening) return;
  rememberExitTemplate(meta.key, payload);
  const sellAt = Date.now() + LIQUIDITY_EXIT_DELAY_MS;
  liquidityExitRefreshes.set(meta.key, {
    sellAt,
    remainingRefreshes: LIQUIDITY_EXIT_REFRESH_ROUNDS,
    nextAt: sellAt,
  });
  executionJournal.record("exit.liquidity-triggered", {
    strategy: meta.key,
    sellAt: new Date(sellAt).toISOString(),
    delayMs: LIQUIDITY_EXIT_DELAY_MS,
    refreshIntervalMs: LIQUIDITY_EXIT_REFRESH_MS,
    refreshRounds: LIQUIDITY_EXIT_REFRESH_ROUNDS,
    order: payloadAuditData(payload),
  });
  scheduleExitWorker(meta.key, payload, sellAt, "insufficient-funds-countdown");
  void reconcilePositions(false)
    .catch((error) => stamp(`LIQUIDITY_EXIT_POSITION_REFRESH_FAILED strategy=${meta.key} error=${safeRuntimeError(error)}`))
    .finally(() => evaluateExits());
}

async function evidence(
  key: string,
  method: string,
  path: string,
  payload: Json,
  preflight: OrderWritePreflight | "NOT_APPLICABLE",
): Promise<void> {
  await sendEvidenceAudit.append({
    at: new Date().toISOString(), key, method, endpoint: path, preflight,
    payloadShape: { orderType: payload.orderType, price: payload.price, quantity: payload.quantity },
  });
}

function reportPolicyAlert(source: string, order: Json, code: string, message: string): void {
  const id = String(order.orderId ?? "PENDING");
  const key = `${source}:${id}:${code}:${String(order.price)}`;
  if (reportedPolicyAlerts.has(key)) return;
  reportedPolicyAlerts.add(key);
  const record = {
    at: new Date().toISOString(), source, orderId: id, code, price: order.price ?? null, message,
  };
  executionJournal.record("policy.alert", record);
  stamp(`POLICY_ALERT code=${code} source=${source} order=${id} price=${String(order.price ?? "unknown")} detail=${message}`);
  void policyAlertAudit.append(record).catch(() => undefined);
}

function reportWorkingOrderPolicyViolations(): void {
  const today = newYorkDate();
  for (const order of orders) {
    if (!working.has(String(order.status))) continue;
    const meta = info(order);
    if (!meta || !policy.underlyings.has(meta.underlying)) continue;
    const violation = orderPolicyViolation(order, policy, today);
    if (violation) reportPolicyAlert("order-snapshot", order, violation.code, violation.message);
  }
}

function recordRefreshSpreadSkip(order: Json, source: string): boolean {
  const meta = info(order);
  if (!meta || isRefreshSpreadEligible(meta)) return false;
  const id = orderId(order);
  const width = refreshSpreadWidth(meta);
  if (refreshSpreadSkipTracker.shouldReport(id, meta)) {
    executionJournal.record("order.refresh-skipped", {
      source,
      reason: "spread-width-not-one",
      requiredSpreadWidth: REQUIRED_REFRESH_SPREAD_WIDTH,
      actualSpreadWidth: width,
      ...orderAuditData(order),
    });
    stamp(formatRefreshSpreadSkipped(meta, id, width));
  }
  return true;
}

function reportWorkingRefreshSpreadSkips(): void {
  const today = newYorkDate();
  for (const order of orders) {
    const meta = info(order);
    if (
      !working.has(String(order.status))
      || !meta
      || meta.expiration !== today
      || !policy.underlyings.has(meta.underlying)
      || !policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    ) continue;
    recordRefreshSpreadSkip(order, "order-snapshot");
  }
}

async function waitForReplenishmentWriteWindow(priority: Priority, key: string): Promise<void> {
  // Low-priority fixed-price Replace tasks may complete local validation in
  // parallel, but must not take the one final broker write just as
  // activity-driven REST reconciliation is about to reveal a fill. Once a new
  // refill is queued, retain a short window for its Submit Preview to finish
  // and enter the final gate.
  if (priority < 2) return;
  const deferredAt = Date.now();
  while (!stopping && (activityRestRunning || Date.now() < replenishmentWritePriorityUntil)) await wait(25);
  const delayMs = Date.now() - deferredAt;
  if (delayMs > 0) {
    executionJournal.record("broker.write.deferred-for-replenishment", {
      key, priority, delayMs, activityRestRunning, replenishmentWritePriorityUntil: new Date(replenishmentWritePriorityUntil).toISOString(),
    });
  }
}

async function writeOrder(key: string, method: "POST" | "PUT", path: string, payload: Json, priority: Priority): Promise<string> {
  if (stopping) {
    executionJournal.record("broker.write.skipped", { key, reason: "runtime-stopping", method, path, order: payloadAuditData(payload) });
    throw new Error("RUNTIME_STOPPING");
  }
  if (readOnly) {
    executionJournal.record("broker.write.skipped", { key, reason: "read-only", method, path, order: payloadAuditData(payload) });
    return "READ_ONLY";
  }
  assertBrokerWritesAllowed(key, method, path);
  if (policy.disableSellOrders && isClosingPayload(payload)) {
    executionJournal.record("exit.write.blocked", {
      key, method, path, reason: "cli-disable-sell-orders", order: payloadAuditData(payload),
    });
    throw new Error("SELL_ORDERS_DISABLED");
  }
  const violation = orderPolicyViolation(payload, policy, newYorkDate());
  if (violation) {
    executionJournal.record("broker.write.blocked", { key, method, path, code: violation.code, message: violation.message, order: payloadAuditData(payload) });
    reportPolicyAlert("write-blocked", payload, violation.code, violation.message);
    throw new Error(`ORDER_POLICY_BLOCKED_${violation.code}`);
  }
  await ensureWeeklyReauthorization();
  policy.requireExecutionWindow();
  const preflightDecision = orderWritePreflight(method, path, accountHash);
  if (preflightDecision.violation) {
    executionJournal.record("broker.write.blocked", {
      key, method, path, code: preflightDecision.violation, order: payloadAuditData(payload),
    });
    throw new Error(preflightDecision.violation);
  }
  const preflight = preflightDecision.preflight;
  if (preflight === EXISTING_ORDER_REPLACE_NO_PREVIEW) {
    const replaceOrderId = preflightDecision.replaceOrderId;
    const source = orders.find((order) => orderId(order) === replaceOrderId);
    const sourceViolation = replacementSourceViolation(source, payload);
    if (sourceViolation) {
      executionJournal.record("broker.write.blocked", {
        key,
        method,
        path,
        code: sourceViolation,
        sourceOrderId: replaceOrderId,
        sourceStatus: source?.status ?? null,
        order: payloadAuditData(payload),
      });
      throw new Error(sourceViolation);
    }
    executionJournal.record("broker.preview.skipped", {
      key,
      reason: "existing-order-native-replace",
      preflight,
      method,
      path,
      sourceOrderId: replaceOrderId,
      sourceStatus: source?.status,
      order: payloadAuditData(payload),
    });
  } else {
    const previewFingerprint = createHash("sha256")
      .update(`${path}\0${JSON.stringify(payload)}`)
      .digest("hex");
    if (Date.now() < (previewRejectedUntil.get(previewFingerprint) ?? 0)) {
      executionJournal.record("broker.preview.skipped", { key, reason: "cached-rejection", preflight, method, path, order: payloadAuditData(payload) });
      throw new Error("CACHED_PREVIEW_REJECTED");
    }
    executionJournal.record("broker.preview.requested", { key, preflight, method, path, priority, order: payloadAuditData(payload) });
    const preview = await api(
      `/trader/v1/accounts/${accountHash}/previewOrder`,
      { method: "POST", body: JSON.stringify(payload) },
      priority,
    );
    if (!previewAccepted(preview.body)) {
      const rejection = classifyPreviewRejection(preview.body);
      previewRejectedUntil.set(previewFingerprint, Date.now() + rejection.cooldownMs);
      const blockers = previewBlockers(preview.body);
      const details = previewRejectionDetails(preview.body);
      const detailSummary = previewRejectionSummary(details);
      const insufficientFunds = rejection.code === "INSUFFICIENT_FUNDS";
      executionJournal.record("broker.preview.rejected", {
        key, preflight, method, path, blockers, details, rejectionCode: rejection.code, cooldownMs: rejection.cooldownMs, insufficientFunds, order: payloadAuditData(payload),
      });
      if (insufficientFunds) {
        requestLiquidityExit(payload);
        throw new Error(`SCHWAB_PREVIEW_INSUFFICIENT_FUNDS rejectionCode=${rejection.code} cooldownMs=${rejection.cooldownMs} details=${detailSummary}`);
      }
      throw new Error(`SCHWAB_PREVIEW_REJECTED rejectionCode=${rejection.code} cooldownMs=${rejection.cooldownMs} details=${detailSummary}`);
    }
    previewRejectedUntil.delete(previewFingerprint);
    executionJournal.record("broker.preview.accepted", { key, preflight, method, path, order: payloadAuditData(payload) });
  }
  const replaceTargetOrderId = preflightDecision.replaceOrderId;
  await evidence(key, method, path, payload, preflight);
  await waitForReplenishmentWriteWindow(priority, key);
  executionJournal.record("broker.write.requested", { key, preflight, method, path, priority, order: payloadAuditData(payload) });
  const result = await brokerWriteCoordinator.execute({
    key,
    method,
    operation: unknownOperation(method),
    path,
    payload,
    baselineOrderIds: () => baselineOrderIds(payload, replaceTargetOrderId ?? undefined),
    targetOrderId: replaceTargetOrderId ?? undefined,
    targetOrder: replaceTargetOrderId
      ? () => orders.find((order) => orderId(order) === replaceTargetOrderId)
      : undefined,
    priority,
    transportPriority: 0,
  });
  const brokerOrderId = result.orderId;
  if (!brokerOrderId) throw new Error("BROKER_ORDER_ID_MISSING");
  executionJournal.record("broker.write.accepted", { key, preflight, method, path, brokerOrderId, order: payloadAuditData(payload) });
  return brokerOrderId;
}

async function cancelOrder(key: string, orderIdValue: string, priority: Priority = 2): Promise<void> {
  if (stopping) {
    executionJournal.record("broker.cancel.skipped", { key, orderId: orderIdValue, reason: "runtime-stopping" });
    throw new Error("RUNTIME_STOPPING");
  }
  if (readOnly) {
    executionJournal.record("broker.cancel.skipped", { key, orderId: orderIdValue, reason: "read-only" });
    return;
  }
  const source = orders.find((order) => orderId(order) === orderIdValue);
  assertCancelableTarget(source, key, orderIdValue);
  if (policy.disableSellOrders && (info(source ?? {})?.closing || key.startsWith("sell-") || key.startsWith("stale-recreate"))) {
    executionJournal.record("exit.cancel.blocked", {
      key, orderId: orderIdValue, reason: "cli-disable-sell-orders",
    });
    throw new Error("SELL_ORDERS_DISABLED");
  }
  const path = `/trader/v1/accounts/${accountHash}/orders/${orderIdValue}`;
  assertBrokerWritesAllowed(key, "DELETE", path);
  await ensureWeeklyReauthorization();
  policy.requireExecutionWindow();
  await evidence(key, "DELETE", path, {}, "NOT_APPLICABLE");
  executionJournal.record("broker.cancel.requested", { key, orderId: orderIdValue, path });
  await brokerWriteCoordinator.execute({
    key,
    method: "DELETE",
    operation: "CANCEL_ORDER",
    path,
    baselineOrderIds: [orderIdValue],
    targetOrderId: orderIdValue,
    targetOrder: () => orders.find((order) => orderId(order) === orderIdValue),
    validateFinal: () => {
      const currentTarget = orders.find((order) => orderId(order) === orderIdValue);
      assertCancelableTarget(currentTarget, key, orderIdValue);
    },
    priority,
    transportPriority: priority,
  });
  const current = orders.find((order) => orderId(order) === orderIdValue);
  if (current) current.status = "CANCELED";
  executionJournal.record("broker.cancel.accepted", { key, orderId: orderIdValue, path });
}

function assertCancelableTarget(source: Json | undefined, key: string, orderIdValue: string): void {
  if (!source) {
    executionJournal.record("broker.cancel.blocked", {
      key, orderId: orderIdValue, reason: "target-order-not-in-authoritative-snapshot",
    });
    throw new Error("CANCEL_TARGET_NOT_IN_AUTHORITATIVE_SNAPSHOT");
  }
  if (!working.has(String(source.status ?? ""))) {
    executionJournal.record("broker.cancel.blocked", {
      key,
      orderId: orderIdValue,
      reason: "target-order-not-working",
      status: source.status ?? null,
    });
    throw new Error("CANCEL_TARGET_NOT_WORKING");
  }
}

async function bootstrap(): Promise<void> {
  const linked = await api("/trader/v1/accounts/accountNumbers");
  if (!Array.isArray(linked.body) || linked.body.length !== 1 || typeof linked.body[0]?.hashValue !== "string") {
    throw new Error("需要且仅允许一个 Schwab linked account");
  }
  accountHash = linked.body[0].hashValue;
  await unknownWriteReconciliation.bindAccount(accountHash);
}

async function loadActivityStreamContext(): Promise<{
  accessToken: string;
  socketUrl: string;
  customerId: string;
  correlationId: string;
  channel: string;
  functionId: string;
}> {
  const preference = await api("/trader/v1/userPreference", {}, 0);
  const streamer = preference.body?.streamerInfo?.[0];
  const required = [
    streamer?.streamerSocketUrl,
    streamer?.schwabClientCustomerId,
    streamer?.schwabClientCorrelId,
    streamer?.schwabClientChannel,
    streamer?.schwabClientFunctionId,
  ];
  if (required.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("STREAMER_PREFERENCE_INVALID");
  }
  return {
    accessToken: await tokens.get(),
    socketUrl: streamer.streamerSocketUrl,
    customerId: streamer.schwabClientCustomerId,
    correlationId: streamer.schwabClientCorrelId,
    channel: streamer.schwabClientChannel,
    functionId: streamer.schwabClientFunctionId,
  };
}

async function poll(full = false, priority: Priority = 0): Promise<boolean> {
  // A full poll owns the authoritative snapshot and reconciliation barrier.
  // Fill/activity polls may merge read-only hints while it is running, but the
  // broker-write coordinator rechecks fullSnapshotReconciled at its final gate.
  if (stopping) return false;
  if (full) {
    if (polling) return false;
    polling = true;
    fullSnapshotReconciled = false;
  }
  try {
    const successful = full
      ? await orderSnapshotCoordinator.pollFull(priority)
      : await orderSnapshotCoordinator.pollFills(priority);
    if (!successful) return false;
    if (full) {
      // The snapshot coordinator only reports success after its consumer
      // callback has completed.  Copy readiness after that await so the final
      // write gate cannot open during transition/explorer side effects.
      fullSnapshotReconciled = orderSnapshotCoordinator.fullSnapshotReconciled;
      lastFullOrderPollAt = orderSnapshotCoordinator.lastFullSnapshotAt;
    }
    if (!readOnly) {
      trackInventoryFillDeltas();
      if (policy.isExecutionWindowOpen()) {
        detectExplorerFills();
        adoptSells();
      }
    }
    lastFillPollAt = Date.now();
    return true;
  } finally {
    if (full) polling = false;
  }
}

function handleAccountActivity(batch: ActivityBatch): void {
  // Stream payloads are hints only. The REST order snapshot remains the sole
  // authority for fills, terminal state, and any later broker write.
  executionJournal.record("activity.signal.received", { hints: batch.hints.length, complete: batch.complete });
  scheduleActivityRestConfirmation();
}

function scheduleActivityRestConfirmation(): void {
  lastIncompleteActivityAt = Date.now();
  armActivityRestConfirmation();
}

function armActivityRestConfirmation(): void {
  if (activityRestTimer || activityRestRunning || stopping) return;
  // The stream is only a wake-up signal.  Keep the REST confirmation, but do
  // not deliberately add two seconds to a newly filled opening order.
  const dueAt = nextActivityRestConfirmationAt(Date.now(), lastActivityRestAt);
  activityRestTimer = setTimeout(() => {
    activityRestTimer = null;
    launchRuntimeBackgroundTask("activity-rest-confirmation", runActivityRestConfirmation);
  }, Math.max(0, dueAt - Date.now()));
}

async function runActivityRestConfirmation(): Promise<void> {
  if (stopping) return;
  if (lastFillPollAt >= lastIncompleteActivityAt) return;
  activityRestRunning = true;
  const confirmingThrough = lastIncompleteActivityAt;
  let confirmed = false;
  const coveredByOtherPoll = lastFillPollAt >= confirmingThrough;
  try {
    if (!stopping && !coveredByOtherPoll) {
      // Record the attempt before I/O.  Otherwise a transient REST failure can
      // immediately re-arm every stream message and consume the entire quota.
      lastActivityRestAt = Date.now();
      executionJournal.record("activity.rest-confirmation-started", {
        confirmingThrough: new Date(confirmingThrough).toISOString(),
        debounceMs: ACTIVITY_REST_DEBOUNCE_MS,
        minIntervalMs: ACTIVITY_REST_MIN_INTERVAL_MS,
      });
      confirmed = await poll(false, 0);
    }
  } finally {
    activityRestRunning = false;
  }
  if ((!confirmed && !coveredByOtherPoll) || lastIncompleteActivityAt > confirmingThrough) {
    armActivityRestConfirmation();
  }
}

function managedOpening(order: Json): ReturnType<typeof orderInfo> {
  return managedOpeningInfo(order, policy, newYorkDate());
}

function rememberExitTemplate(strategy: string, order: Json): void {
  if (readOnly || policy.disableSellOrders) return;
  const current = exitTemplatesByStrategy.get(strategy);
  if (current && orderId(current) === orderId(order)) return;
  exitTemplatesByStrategy.set(strategy, structuredClone(order));
  exitTemplateStateStore.save(exitTemplatesByStrategy);
}

function reconcileExplorerSnapshot(): void {
  const liveByGroup = new Map<string, Set<string>>();
  for (const order of orders) {
    const meta = managedOpening(order);
    if (!meta) continue;
    explorerTemplates.set(meta.key, order);
    rememberExitTemplate(meta.key, order);
    if (order.status === "FILLED") recordOpeningFillLot(meta.key, order);
    if (!working.has(String(order.status))) continue;
    explorer.registerWorkingOrder(meta.key, orderId(order), Math.round(Number(order.price) * 100), eventTime(order));
    const ids = liveByGroup.get(meta.key) ?? new Set<string>();
    ids.add(orderId(order));
    liveByGroup.set(meta.key, ids);
  }
  for (const groupKey of explorer.groupKeys()) explorer.reconcileWorkingBrokerOrders(groupKey, liveByGroup.get(groupKey) ?? new Set());
  // A full broker response is the authority. Recalculate eligibility from it;
  // do not infer current work from a previous snapshot delta.
  if (policy.repeatBuyAtOrderPrice && fixedPriceRefreshRoundActive) {
    const primaryOpeningIds = primaryActiveOpeningOrderIds();
    for (const order of orders) queueFixedPriceRefresh(order, "full-order-reconciliation", primaryOpeningIds);
  }
  reconcileCurrentExitStrategies();
  persistExplorer();
}

function explorerActionKey(groupKey: string, action: ExplorerAction): string {
  return `price-explorer:${groupKey}:${action.generation}:${action.dueAt}:${action.logicalId}:${action.kind}`;
}

function deferExplorerActionForFunding(groupKey: string, action: ExplorerAction): void {
  const key = explorerActionKey(groupKey, action);
  const previous = deferredExplorerRetries.get(key);
  const retry = { attempts: (previous?.attempts ?? 0) + 1, nextAt: Date.now() + EXPLORER_FUNDING_RETRY_MS };
  deferredExplorerRetries.set(key, retry);
  persistExplorer();
  executionJournal.record("explorer.action.deferred-for-funding", {
    groupKey,
    action,
    attempts: retry.attempts,
    retryAt: new Date(retry.nextAt).toISOString(),
  });
}

function deferExplorerActionForExit(groupKey: string, action: ExplorerAction): void {
  const key = explorerActionKey(groupKey, action);
  const previous = deferredExplorerRetries.get(key);
  const retry = { attempts: (previous?.attempts ?? 0) + 1, nextAt: Date.now() + LIQUIDITY_EXIT_REFRESH_MS };
  deferredExplorerRetries.set(key, retry);
  executionJournal.record("explorer.action.deferred-for-exit", {
    groupKey,
    action,
    attempts: retry.attempts,
    retryAt: new Date(retry.nextAt).toISOString(),
  });
}

function queueExplorerActions(groupKey: string, actions: ExplorerAction[]): void {
  for (const action of actions) {
    const key = explorerActionKey(groupKey, action);
    const retry = deferredExplorerRetries.get(key);
    if (retry && Date.now() < retry.nextAt) continue;
    executionJournal.record("explorer.action.queued", { groupKey, action });
    writer.enqueue({
      key,
      // Exit orders use priority 0.  New buys are admitted before ordinary
      // opening-order refreshes, but neither may preempt an active exit.
      priority: action.kind === "ensure" ? 1 : 2,
      run: () => executeExplorerAction(groupKey, action),
    });
  }
}

function activeOpeningOrders(groupKey: string): Json[] {
  return selectActiveOpeningOrders(orders, groupKey, newYorkDate(), policy.underlyings, working);
}

function primaryActiveOpeningOrderIds(): Map<string, string> {
  return buildPrimaryActiveOpeningOrderIds(orders, policy, newYorkDate(), working);
}

function queueFixedPriceRefresh(
  candidate: Json,
  source: "round-start" | "full-order-reconciliation",
  primaryOpeningIds: ReadonlyMap<string, string>,
): void {
  const meta = managedOpening(candidate);
  const id = orderId(candidate);
  if (
    !meta || !working.has(String(candidate.status))
    || primaryOpeningIds.get(meta.key) !== id
  ) return;
  if (fixedPriceRefreshRoundActive && !fixedPriceRefreshRoundGuard.reserveStrategy(meta.key)) return;
  writer.enqueue({
    key: `fixed-price-cycle-refresh:${id}`,
    priority: 2,
    run: async () => {
      if (stopping || !policy.isExecutionWindowOpen()) return;
      const current = orders.find((order) => orderId(order) === id);
      if (!current || !working.has(String(current.status)) || !managedOpening(current)) return;
      const quotaIntervalMs = budget.fixedPriceRefreshIntervalMs();
      const intervalMs = effectiveFixedPriceRefreshIntervalMs(policy.fixedPriceRefreshIntervalMs, quotaIntervalMs);
      executionJournal.record("fixed-price-cycle.refresh-started", {
        strategy: meta.key,
        orderId: id,
        source,
        configuredIntervalMs: policy.fixedPriceRefreshIntervalMs,
        quotaIntervalMs,
        intervalMs,
      });
      await fixedPriceRefreshPacer.admit(intervalMs);
      const latest = orders.find((order) => orderId(order) === id);
      if (!latest || !working.has(String(latest.status)) || !managedOpening(latest)) return;
      const payload = payloadFrom(latest, 1, false, Math.round(Number(latest.price) * 100));
      const replacement = await writeOrder(
        `fixed-price-cycle-refresh:${id}:${Date.now()}`,
        "PUT",
        `/trader/v1/accounts/${accountHash}/orders/${id}`,
        payload,
        2,
      );
      applyLocalReplace(id, payload, replacement);
      stamp(formatFixedPriceReplace(managedOpening(latest)!, Number(latest.price)));
      executionJournal.record("fixed-price-cycle.order-replaced", {
        sourceOrder: orderAuditData(latest), replacementOrderId: replacement, order: payloadAuditData(payload),
      });
    },
  });
}

function queueVerifiedStaleExitRecreate(strategy: string, source: Json, template: Json): void {
  if (policy.disableSellOrders) return;
  if (recordRefreshSpreadSkip(source, "stale-exit-recreate")) return;
  const id = orderId(source);
  if (staleExitRecreateInFlight.has(id)) return;
  if (!mayRecreateStaleOrder(eventTime(source), Date.now(), staleExitRetryAt.get(id) ?? 0)) return;
  staleExitRecreateInFlight.add(id);
  const retryAt = Date.now() + STALE_ORDER_RECREATE_RETRY_MS;
  staleExitRetryAt.set(id, retryAt);
  // Override the rejected Replace's longer fingerprint cooldown for this
  // separate, guarded stale-recreate path.  If this attempt cannot complete,
  // the strategy worker wakes this individual old sell again in ten seconds.
  sellDue.set(id, retryAt);
  writer.enqueue({
    key: `stale-recreate:closing:${id}`,
    priority: 0,
    run: async () => {
      try {
        executionJournal.record("order.stale-recreate.started", { direction: "closing", strategy, sourceOrderId: id });
        // Every stale exit has its own retry clock.  The final broker write is
        // still serial, but unrelated 90-second exits never wait on a global
        // "oldest order" cooldown.  A periodic full order snapshot must not
        // block the Cancel itself; reconciliation happens immediately after.
        await cancelOrder(`stale-recreate-cancel:${id}`, id, 0);
        const pollStartedAt = lastFullOrderPollAt;
        for (let attempt = 0; polling && attempt < 100 && !stopping; attempt += 1) await wait(50);
        const reconciled = !stopping && await poll(true, 0);
        // Several stale exits can be canceled together.  One authoritative
        // full order snapshot is sufficient for every waiter it includes.
        for (let attempt = 0; polling && attempt < 100 && !stopping; attempt += 1) await wait(50);
        if (stopping || (!reconciled && lastFullOrderPollAt <= pollStartedAt)) {
          executionJournal.record("order.stale-recreate.deferred", { direction: "closing", strategy, sourceOrderId: id, reason: "full-reconciliation-unavailable" });
          return;
        }
        const stillWorking = orders.some((order) => working.has(String(order.status)) && info(order)?.closing && info(order)?.key === strategy);
        if (stillWorking) {
          executionJournal.record("order.stale-recreate.deferred", { direction: "closing", strategy, sourceOrderId: id, reason: "working-order-remains-after-reconciliation" });
          return;
        }
        // The cancel + full order reconciliation above establishes that this
        // strategy has no working sell.  Positions can still have changed
        // while this job waited in the serial writer, so never reuse the
        // quantity captured when the stale order was first observed.
        const inventory = await refreshExitInventory(strategy, template, "before-stale-recreate-submit");
        const { targetQuantity } = currentExitTarget(strategy, inventory, Date.now());
        if (targetQuantity <= 0) {
          executionJournal.record("order.stale-recreate.deferred", {
            direction: "closing", strategy, sourceOrderId: id, reason: "no-current-exit-inventory", inventory,
          });
          return;
        }
        const payload = payloadFrom(template, targetQuantity, true);
        const brokerOrderId = await writeOrder(`stale-recreate-submit:${id}:${Date.now()}`, "POST", `/trader/v1/accounts/${accountHash}/orders`, payload, 0);
        applyLocalSubmit(payload, brokerOrderId);
        executionJournal.record("order.stale-recreate.submitted", { direction: "closing", strategy, sourceOrderId: id, brokerOrderId, order: payloadAuditData(payload) });
      } catch (error) {
        executionJournal.record("order.stale-recreate.deferred", { direction: "closing", strategy, sourceOrderId: id, reason: safeRuntimeError(error) });
      } finally {
        staleExitRecreateInFlight.delete(id);
      }
    },
  });
}

function hasExitPriority(groupKey: string): boolean {
  if (policy.disableSellOrders) return false;
  if (liquidityExitRefreshes.has(groupKey)) return true;
  return orders.some((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === groupKey
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  });
}

function isConfiguredExplorerGroup(groupKey: string): boolean {
  const [underlying, expiration, , rawLowerStrike, rawHigherStrike] = groupKey.split(":");
  const lowerStrike = Number(rawLowerStrike);
  const higherStrike = Number(rawHigherStrike);
  return policy.underlyings.has(underlying)
    && expiration === newYorkDate()
    && policy.isWithinStrikeRange(underlying, lowerStrike, higherStrike);
}

async function executeExplorerAction(groupKey: string, action: ExplorerAction): Promise<void> {
  if (stopping || readOnly || !policy.isExecutionWindowOpen() || !explorer.isCurrentGeneration(groupKey, action.generation)) {
    executionJournal.record("explorer.action.skipped", {
      groupKey,
      action,
      stopping,
      readOnly,
      executionWindowOpen: policy.isExecutionWindowOpen(),
      generationCurrent: explorer.isCurrentGeneration(groupKey, action.generation),
    });
    return;
  }
  const queueDelayMs = Math.max(0, Date.now() - action.dueAt);
  executionJournal.record("explorer.action.started", { groupKey, action, queueDelayMs });
  if (queueDelayMs > policy.roundCooldownMs) {
    stamp(`PRICE_EXPLORER_ACTION_LATE group=${groupKey} logical=${action.logicalId} delayMs=${queueDelayMs}`);
  }
  if (action.kind === "resolve-three") {
    const followups = explorer.resolveThree(groupKey, action.generation, Date.now());
    persistExplorer();
    executionJournal.record("explorer.three-way.resolved", { groupKey, action, followups });
    queueExplorerActions(groupKey, followups);
    return;
  }
  if (hasExitPriority(groupKey)) {
    deferExplorerActionForExit(groupKey, action);
    executionJournal.record("explorer.action.skipped", { groupKey, action, reason: "exit-priority-active" });
    return;
  }
  if (action.binding === false) await normalExplorerActionPacer.admit();
  const complete = (): void => {
    deferredExplorerRetries.delete(explorerActionKey(groupKey, action));
    explorer.acknowledge(groupKey, action);
    persistExplorer();
    executionJournal.record("explorer.action.completed", { groupKey, action });
  };
  const logical = explorer.order(groupKey, action.logicalId);
  if (!logical || logical.filled) {
    executionJournal.record("explorer.action.noop", { groupKey, action, reason: logical ? "logical-filled" : "logical-missing" });
    complete();
    return;
  }
  const desiredPrice = action.priceCents === undefined ? logical.priceCents : explorer.setPrice(groupKey, logical.id, action.priceCents);
  const current = logical.brokerOrderId === null ? null : orders.find((order) => orderId(order) === logical.brokerOrderId && working.has(String(order.status)));
  if (current) {
    if (recordRefreshSpreadSkip(current, "price-explorer")) {
      complete();
      return;
    }
    if (action.kind === "ensure" && Math.round(Number(current.price) * 100) === desiredPrice) {
      executionJournal.record("explorer.action.noop", { groupKey, action, reason: "working-price-already-matches", order: orderAuditData(current) });
      complete();
      return;
    }
    const payload = payloadFrom(current, 1, false, desiredPrice);
    try {
      const replacement = await writeOrder(
        `price-explorer-replace:${groupKey}:${logical.id}:${Date.now()}`,
        "PUT", `/trader/v1/accounts/${accountHash}/orders/${orderId(current)}`, payload, 0,
      );
      applyLocalReplace(orderId(current), payload, replacement);
      explorer.replaceBrokerOrder(groupKey, logical.id, replacement, desiredPrice);
      stamp(`PRICE_EXPLORER_REPLACE group=${groupKey} logical=${logical.id} price=${(desiredPrice / 100).toFixed(2)} replacement=${replacement}`);
      executionJournal.record("explorer.order.replaced", { groupKey, action, logicalId: logical.id, sourceOrder: orderAuditData(current), replacementOrderId: replacement, priceCents: desiredPrice });
    } catch (error) {
      if (String(error).startsWith("Error: SCHWAB_PREVIEW_INSUFFICIENT_FUNDS")) {
        deferExplorerActionForFunding(groupKey, action);
        return;
      }
      complete();
      throw error;
    }
    complete();
    return;
  }
  if (logical.brokerOrderId !== null || action.kind === "refresh") {
    executionJournal.record("explorer.action.noop", { groupKey, action, reason: logical.brokerOrderId !== null ? "stale-broker-order" : "refresh-without-working-order" });
    complete();
    return;
  }
  const template = explorerTemplates.get(groupKey) ?? exitTemplatesByStrategy.get(groupKey);
  if (!template || managedOpening(template)?.key !== groupKey) {
    stamp(`PRICE_EXPLORER_TEMPLATE_MISSING group=${groupKey} logical=${logical.id}`);
    executionJournal.record("explorer.action.skipped", { groupKey, action, reason: "template-missing" });
    complete();
    return;
  }
  explorerTemplates.set(groupKey, template);
  executionJournal.record("explorer.template.recovered", { groupKey, logicalId: logical.id, source: "persisted-exit-template" });
  if (activeOpeningOrders(groupKey).length >= MAX_ACTIVE_ORDERS) {
    stamp(`PRICE_EXPLORER_SLOT_FULL group=${groupKey} logical=${logical.id} active=${MAX_ACTIVE_ORDERS}`);
    executionJournal.record("explorer.action.skipped", { groupKey, action, reason: "active-order-cap", activeOrderCap: MAX_ACTIVE_ORDERS });
    complete();
    return;
  }
  const payload = payloadFrom(template, 1, false, desiredPrice);
  try {
    const brokerOrderId = await writeOrder(
      `price-explorer-submit:${groupKey}:${logical.id}:${Date.now()}`,
      "POST", `/trader/v1/accounts/${accountHash}/orders`, payload, 0,
    );
    applyLocalSubmit(payload, brokerOrderId);
    explorer.bindBrokerOrder(groupKey, logical.id, brokerOrderId);
    stamp(`PRICE_EXPLORER_SUBMIT group=${groupKey} logical=${logical.id} price=${(desiredPrice / 100).toFixed(2)} order=${brokerOrderId}`);
    executionJournal.record("explorer.order.submitted", { groupKey, action, logicalId: logical.id, brokerOrderId, priceCents: desiredPrice, order: payloadAuditData(payload) });
  } catch (error) {
    if (String(error).startsWith("Error: SCHWAB_PREVIEW_INSUFFICIENT_FUNDS")) {
      deferExplorerActionForFunding(groupKey, action);
      return;
    }
    complete();
    throw error;
  }
  complete();
}

function detectExplorerFills(): void {
  const now = Date.now();
  const fillPriceSource = policy.repeatBuyAtOrderPrice ? "orderLimit" : "actualNet";
  for (const order of orders) {
    const meta = managedOpening(order);
    if (!meta || order.status !== "FILLED") continue;
    const fill = policy.repeatBuyAtOrderPrice ? completeOrderLimitFill(order) : completeNetDebitFill(order);
    if (!fill) {
      const id = orderId(order);
      if (!reportedUnpricedFills.has(id)) {
        reportedUnpricedFills.add(id);
        stamp(`PRICE_EXPLORER_FILL_PRICE_UNAVAILABLE order=${id} source=${fillPriceSource}; no exploration action sent`);
        executionJournal.record("explorer.fill.ignored", { order: orderAuditData(order), fillPriceSource, reason: "price-unavailable" });
      }
      continue;
    }
    if (fill.priceCents < policy.entryNotionalMin || fill.priceCents > policy.entryNotionalMax) {
      stamp(`PRICE_EXPLORER_FILL_PRICE_OUT_OF_RANGE order=${orderId(order)} source=${fillPriceSource} price=${(fill.priceCents / 100).toFixed(2)}; no exploration action sent`);
      executionJournal.record("explorer.fill.ignored", { order: orderAuditData(order), fillPriceSource, priceCents: fill.priceCents, reason: "price-out-of-range" });
      continue;
    }
    if (policy.repeatBuyAtOrderPrice) {
      if (!mayRecoverFixedPriceFill(fill.filledAt, runtimeStartedAt)) {
        const id = orderId(order);
        if (!reportedHistoricalFixedPriceFills.has(id)) {
          reportedHistoricalFixedPriceFills.add(id);
          executionJournal.record("fixed-price-cycle.fill.ignored", { order: orderAuditData(order), priceCents: fill.priceCents, filledAt: new Date(fill.filledAt).toISOString(), reason: "before-startup-grace-window" });
        }
        continue;
      }
      queueFixedPriceReplenishment(meta.key, order, fill.priceCents);
      continue;
    }
    if (now - fill.filledAt > 10_000) {
      executionJournal.record("explorer.fill.ignored", { order: orderAuditData(order), fillPriceSource, priceCents: fill.priceCents, filledAt: new Date(fill.filledAt).toISOString(), reason: "outside-ten-second-window" });
      continue;
    }
    const transition = explorer.recordCompleteFill(meta.key, orderId(order), fill.priceCents, fill.filledAt);
    persistExplorer();
    executionJournal.record("explorer.fill.accepted", {
      groupKey: meta.key,
      order: orderAuditData(order),
      fillPriceSource,
      explorationPriceCents: fill.priceCents,
      filledAt: new Date(fill.filledAt).toISOString(),
      transition,
    });
    if (transition.actions.length > 0) queueExplorerActions(meta.key, transition.actions);
    if (transition.triggered) {
      stamp(`PRICE_EXPLORER_PAIR group=${meta.key} source=${fillPriceSource} price=${(fill.priceCents / 100).toFixed(2)} generation=${transition.generation}`);
      executionJournal.record("explorer.generation.triggered", { groupKey: meta.key, fillPriceSource, priceCents: fill.priceCents, generation: transition.generation, nextActions: transition.actions });
    }
  }
}

function queueFixedPriceReplenishment(groupKey: string, filledOrder: Json, priceCents: number): void {
  const filledOrderId = orderId(filledOrder);
  if (fixedPriceCycleConsumedFills.has(filledOrderId)) return;
  if (!fixedPriceReplenishmentGuard.reserve(groupKey, filledOrderId)) {
    executionJournal.record("fixed-price-cycle.deferred", {
      groupKey, filledOrderId, reason: "strategy-replenishment-unavailable",
    });
    return;
  }
  replenishmentWritePriorityUntil = Math.max(
    replenishmentWritePriorityUntil,
    Date.now() + REFILL_WRITE_PRIORITY_SETTLEMENT_MS,
  );
  const priority = executionPriority("replenishment");
  const queuedAt = Date.now();
  executionJournal.record("fixed-price-cycle.rebuy-queued", {
    groupKey, filledOrderId, priceCents, priority, queuedAt: new Date(queuedAt).toISOString(),
  });
  writer.enqueue({
    key: `fixed-price-cycle:${filledOrderId}`,
    priority,
    run: async () => {
      if (stopping) {
        executionJournal.record("fixed-price-cycle.deferred", { groupKey, filledOrderId, reason: "runtime-stopping" });
        fixedPriceReplenishmentGuard.release(groupKey, filledOrderId);
        return;
      }
      if (!mayReplenishFixedPrice(activeOpeningOrders(groupKey).length)) {
        executionJournal.record("fixed-price-cycle.deferred", { groupKey, filledOrderId, reason: "active-order-cap" });
        fixedPriceReplenishmentGuard.release(groupKey, filledOrderId);
        return;
      }
      const payload = payloadFrom(filledOrder, 1, false, priceCents);
      try {
        const brokerOrderId = await writeOrder(`fixed-price-cycle:${filledOrderId}:${Date.now()}`, "POST", `/trader/v1/accounts/${accountHash}/orders`, payload, priority);
        applyLocalSubmit(payload, brokerOrderId);
        fixedPriceCycleConsumedFills.add(filledOrderId);
        fixedPriceReplenishmentGuard.clearDeferred(filledOrderId);
        persistFixedPriceCycle();
        const queueDelayMs = Date.now() - queuedAt;
        const filledMeta = info(filledOrder);
        stamp(filledMeta
          ? formatFixedPriceRebuy(filledMeta, priceCents / 100)
          : `补买 ${groupKey} ${(priceCents / 100).toFixed(2)}`);
        executionJournal.record("fixed-price-cycle.rebuy-submitted", { groupKey, filledOrderId, priceCents, brokerOrderId, queueDelayMs, order: payloadAuditData(payload) });
      } catch (error) {
        const message = String(error);
        if (message.startsWith("Error: SCHWAB_PREVIEW_INSUFFICIENT_FUNDS")) return;
        if (message.includes("SCHWAB_PREVIEW_REJECTED") || message.includes("CACHED_PREVIEW_REJECTED")) {
          const retryAt = Date.now() + previewRejectionCooldownFromError(error, PREVIEW_REJECTION_COOLDOWN_MS);
          fixedPriceReplenishmentGuard.defer(filledOrderId, retryAt);
          executionJournal.record("fixed-price-cycle.deferred", {
            groupKey, filledOrderId, reason: "preview-rejected", retryAt: new Date(retryAt).toISOString(),
          });
          return;
        }
        throw error;
      } finally {
        fixedPriceReplenishmentGuard.release(groupKey, filledOrderId);
      }
    },
  });
}

async function explorerTick(): Promise<void> {
  if (stopping || readOnly || policy.repeatBuyAtOrderPrice || !policy.isExecutionWindowOpen()) return;
  for (const groupKey of explorer.groupKeys()) {
    if (!isConfiguredExplorerGroup(groupKey)) continue;
    const actions = explorer.due(groupKey, Date.now());
    if (actions.length > 0) queueExplorerActions(groupKey, actions);
  }
}

function shuffled<T>(values: readonly T[]): T[] {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(Math.random() * (index + 1));
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}

async function explorerRoundLoop(): Promise<void> {
  while (!stopping && !readOnly) {
    if (!refreshRoundLimit.mayStartRound()) return;
    if (policy.repeatBuyAtOrderPrice) {
      if (await fixedPriceRefreshRound()) {
        const state = recordRefreshRoundCompleted("fixed-price");
        if (state.maximumReached) {
          await finishRefreshLimitedRun(state);
          return;
        }
      }
      continue;
    }
    if (!policy.isExecutionWindowOpen()) {
      await wait(60_000);
      continue;
    }
    while (polling && !stopping) await wait(50);
    if (stopping || !await runRefreshPreflight()) {
      await wait(policy.roundCooldownMs);
      continue;
    }
    for (const groupKey of shuffled(explorer.groupKeys())) {
      if (!isConfiguredExplorerGroup(groupKey)) continue;
      // A binding action for one repeated buy must not suspend the other
      // logical orders in this vertical.  Only the three-order state decision
      // remains group-scoped because it changes the generation itself.
      if (explorer.hasPendingGroupControlAction(groupKey)) continue;
      const now = Date.now();
      const actions = [
        ...explorer.planMissingOrderRecovery(groupKey, now),
        ...explorer.planRoundRecovery(groupKey, now),
      ];
      queueExplorerActions(groupKey, actions);
      if (actions.length > 0) await wait(policy.orderCooldownMs);
    }
    const state = recordRefreshRoundCompleted("price-explorer");
    if (state.maximumReached) {
      await finishRefreshLimitedRun(state);
      return;
    }
    await wait(policy.roundCooldownMs);
  }
}

function recordRefreshRoundCompleted(mode: "fixed-price" | "price-explorer") {
  const state = refreshRoundLimit.completeRound();
  executionJournal.record("refresh.round.completed", { mode, ...state });
  if (state.maximumReached) {
    executionJournal.record("refresh.round-limit-reached", { mode, ...state });
    stamp(`REFRESH_ROUND_LIMIT_REACHED completed=${state.completedRounds} maximum=${state.maximumRounds}; waiting for queued refresh work before controlled shutdown`);
  }
  return state;
}

async function finishRefreshLimitedRun(state: ReturnType<typeof refreshRoundLimit.completeRound>): Promise<void> {
  executionJournal.record("run.refresh-round-limit-draining", state);
  await writer.waitIdle();
  if (!requestStop("max-refresh-rounds")) return;
  executionJournal.record("run.refresh-round-limit-completed", state);
  stamp(`REFRESH_ROUND_LIMIT_COMPLETED completed=${state.completedRounds}; queued refresh work is settled and the runtime is stopping`);
}

async function fixedPriceRefreshRound(): Promise<boolean> {
  fixedPriceRefreshRoundGuard.beginRound();
  try {
    if (!policy.isExecutionWindowOpen()) {
      await wait(60_000);
      return false;
    }
    while (polling && !stopping) await wait(50);
    if (stopping || !await runRefreshPreflight()) {
      await wait(policy.roundCooldownMs);
      return false;
    }
    fixedPriceRefreshRoundActive = true;
    const primaryOpeningIds = primaryActiveOpeningOrderIds();
    const candidates = shuffled(orders.filter((order) => {
      const meta = managedOpening(order);
      if (meta === null || !working.has(String(order.status))) return false;
      // Existing external duplicates are left untouched, but fixed-price mode
      // maintains and refreshes only one working opening order per strategy.
      return primaryOpeningIds.get(meta.key) === orderId(order);
    }));
    for (const candidate of candidates) {
      if (stopping) break;
      queueFixedPriceRefresh(candidate, "round-start", primaryOpeningIds);
    }
    await writer.waitIdle();
    if (stopping) return false;
    await wait(policy.roundCooldownMs);
    return true;
  } finally {
    fixedPriceRefreshRoundActive = false;
    fixedPriceRefreshRoundGuard.endRound();
  }
}

function trackInventoryFillDeltas(): void {
  const today = newYorkDate();
  for (const order of orders) {
    const meta = info(order);
    if (!meta || meta.expiration !== today || !policy.underlyings.has(meta.underlying)) continue;
    const id = orderId(order);
    const filled = Number(order.filledQuantity ?? 0);
    const previous = observedFillQuantities.get(id);
    observedFillQuantities.set(id, filled);
    if (!inventoryFillBaselineEstablished || previous === undefined || filled <= previous) continue;
    const delta = filled - previous;
    const direction = meta.opening ? 1 : -1;
    inventoryByStrategy.set(
      meta.key,
      Math.max(0, (inventoryByStrategy.get(meta.key) ?? 0) + direction * delta),
    );
    if (meta.opening && order.status === "FILLED") {
      recordOpeningFillLot(meta.key, order);
      inventoryObservedAt.set(meta.key, Date.now());
    }
    stamp(`内存库存更新 strategy=${meta.key} delta=${direction * delta} inventory=${inventoryByStrategy.get(meta.key)}`);
  }
  inventoryFillBaselineEstablished = true;
}

function adoptSells(): void {
  if (policy.disableSellOrders) {
    sellDue.clear();
    staleExitRetryAt.clear();
    staleExitRecreateInFlight.clear();
    cancelingSells.clear();
    return;
  }
  const active = new Set<string>();
  for (const order of orders) {
    const meta = info(order);
    if (
      !meta?.closing || !working.has(String(order.status))
      || meta.expiration !== newYorkDate() || !policy.underlyings.has(meta.underlying)
    ) continue;
    active.add(orderId(order));
    if (!sellDue.has(orderId(order))) {
      const refreshAt = Date.now() + EXIT_REFRESH_MS;
      sellDue.set(orderId(order), refreshAt);
      executionJournal.record("exit.working-sell-adopted", {
        strategy: meta.key,
        orderId: orderId(order),
        refreshAt: new Date(refreshAt).toISOString(),
      });
    }
  }
  for (const id of sellDue.keys()) {
    if (!active.has(id)) {
      sellDue.delete(id);
      cancelingSells.delete(id);
      staleExitRecreateInFlight.delete(id);
      staleExitRetryAt.delete(id);
    }
  }
}

async function positions(priority: Priority = 2): Promise<Map<string, { long: number; short: number }>> {
  const response = await api(`/trader/v1/accounts/${accountHash}?fields=positions`, {}, priority);
  const values = response.body?.securitiesAccount?.positions;
  if (!Array.isArray(values)) throw new Error("持仓响应无效");
  return new Map(values.map((item: Json) => [
    String(item.instrument?.symbol),
    { long: Number(item.longQuantity ?? 0), short: Number(item.shortQuantity ?? 0) },
  ]));
}

function availableFor(template: Json, current: Map<string, { long: number; short: number }>): number {
  const values = template.orderLegCollection.map((leg: Json) => {
    const value = current.get(String(leg.instrument.symbol)) ?? { long: 0, short: 0 };
    return ["BUY_TO_OPEN", "SELL_TO_CLOSE"].includes(String(leg.instruction))
      ? value.long
      : value.short;
  });
  return Math.max(0, Math.floor(Math.min(...values)));
}

async function reconcilePositions(announce = true): Promise<void> {
  const current = await positions();
  const templates = new Map<string, Json>(exitTemplatesByStrategy);
  for (const order of orders) {
    const meta = info(order);
    if (
      !meta || meta.expiration !== newYorkDate()
      || !policy.underlyings.has(meta.underlying)
    ) continue;
    if (!templates.has(meta.key) || meta.opening) {
      templates.set(meta.key, order);
      rememberExitTemplate(meta.key, order);
    }
  }
  for (const [strategy, template] of templates) {
    const inventory = availableFor(template, current);
    const previous = inventoryByStrategy.get(strategy) ?? 0;
    inventoryByStrategy.set(strategy, inventory);
    if (inventory > 0 && previous <= 0) {
      inventoryObservedAt.set(strategy, Date.now());
    }
    if (inventory <= 0) inventoryObservedAt.delete(strategy);
  }
  if (announce) stamp(`订单与持仓完整对账完成 strategies=${templates.size}`);
}

/**
 * Exit workers are independent per vertical, but the account-level positions
 * endpoint is coalesced for one second.  Workers and queued broker writes use
 * this same snapshot, so a write-time inventory guard does not multiply
 * identical Schwab reads across strategies.  A confirmed fill invalidates the
 * shared epoch; the next caller refreshes it once for every waiting strategy.
 */
async function freshExitPositions(): Promise<Map<string, { long: number; short: number }>> {
  const epoch = exitPositionSnapshotEpoch;
  if (exitPositionSnapshot && exitPositionSnapshot.epoch === epoch && Date.now() - exitPositionSnapshot.at < 1_000) {
    return exitPositionSnapshot.positions;
  }
  if (!exitPositionSnapshotPending) {
    const requestEpoch = exitPositionSnapshotEpoch;
    exitPositionSnapshotPending = positions(0).then((positionsSnapshot) => {
      const result = { epoch: requestEpoch, positions: positionsSnapshot };
      if (result.epoch === exitPositionSnapshotEpoch) {
        exitPositionSnapshot = { at: Date.now(), ...result };
      }
      return result;
    }).finally(() => {
      exitPositionSnapshotPending = null;
    });
  }
  const result = await exitPositionSnapshotPending;
  // If a fill arrived while the shared request was in flight, discard that
  // old result once and let all waiting callers coalesce on its replacement.
  return result.epoch === exitPositionSnapshotEpoch ? result.positions : freshExitPositions();
}

function invalidateExitPositionSnapshot(): void {
  exitPositionSnapshotEpoch += 1;
  exitPositionSnapshot = null;
}

async function refreshExitInventory(
  strategy: string, template: Json, source = "independent-worker",
): Promise<number> {
  const current = await freshExitPositions();
  const inventory = availableFor(template, current);
  const previous = inventoryByStrategy.get(strategy) ?? 0;
  inventoryByStrategy.set(strategy, inventory);
  if (inventory > 0 && previous <= 0) inventoryObservedAt.set(strategy, Date.now());
  if (inventory <= 0) inventoryObservedAt.delete(strategy);
  executionJournal.record("exit.inventory.reconciled", { strategy, inventory, source });
  return inventory;
}

function currentExitTarget(
  strategy: string, inventory: number, now: number,
): { eligibility: ReturnType<typeof exitEligibility>; liquidity: { sellAt: number; remainingRefreshes: number; nextAt: number } | undefined; liquidityReady: boolean; targetQuantity: number } {
  const eligibility = exitEligibility(inventory, lastOpeningFillAt.get(strategy) ?? null, now);
  const liquidity = liquidityExitRefreshes.get(strategy);
  const liquidityReady = liquidity !== undefined && now >= liquidity.sellAt;
  return {
    eligibility,
    liquidity,
    liquidityReady,
    targetQuantity: liquidityReady ? inventory : eligibility.targetQuantity,
  };
}

async function runRefreshPreflight(): Promise<boolean> {
  try {
    const admitted = await refreshAuthoritativeSnapshots({
      refreshOrders: () => poll(true, 0),
      refreshPositions: () => reconcilePositions(false),
    });
    if (admitted) {
      executionJournal.record("refresh.preflight.reconciled", {
        snapshots: ["orders", "positions"],
        orders: orders.length,
      });
    }
    return admitted;
  } catch (error) {
    executionJournal.record("refresh.preflight.failed", { error: safeRuntimeError(error) });
    stamp(`刷新前订单或持仓对账失败 error=${safeRuntimeError(error)}`);
    return false;
  }
}

async function ensureFreshOrdersForExit(): Promise<boolean> {
  if (Date.now() - lastFullOrderPollAt < 5_000) return true;
  while (polling && !stopping) await wait(50);
  if (stopping) return false;
  if (Date.now() - lastFullOrderPollAt < 5_000) return true;
  return poll(true, 2);
}

function exitTemplates(): Map<string, Json> {
  const latest = new Map<string, Json>();
  for (const order of orders) {
    const meta = info(order);
    if (
      order.status !== "FILLED" || !meta?.opening
      || !policy.underlyings.has(meta.underlying)
      || meta.expiration !== newYorkDate()
      || !policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    ) continue;
    const previous = latest.get(meta.key);
    if (!previous || eventTime(order) > eventTime(previous)) latest.set(meta.key, order);
    recordOpeningFillLot(meta.key, order);
  }
  for (const order of orders) {
    const meta = info(order);
    if (
      meta?.closing && working.has(String(order.status))
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying)
      && policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
      && !latest.has(meta.key)
    ) {
      latest.set(meta.key, order);
    }
  }
  for (const order of orders) {
    const meta = info(order);
    if (
      meta?.opening && meta.expiration === newYorkDate()
      && policy.underlyings.has(meta.underlying)
      && policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
      && (inventoryByStrategy.get(meta.key) ?? 0) > 0
      && !latest.has(meta.key)
    ) latest.set(meta.key, order);
  }
  for (const [strategy, template] of exitTemplatesByStrategy) {
    const meta = info(template);
    if (
      (inventoryByStrategy.get(strategy) ?? 0) > 0 && !latest.has(strategy)
      && meta && policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    ) latest.set(strategy, template);
  }
  return latest;
}

function nextExitWorkerDue(strategy: string): number {
  const now = Date.now();
  const liquidity = liquidityExitRefreshes.get(strategy);
  if (liquidity) return Math.max(now, liquidity.nextAt);
  const nextIdleDeadline = (lastOpeningFillAt.get(strategy) ?? now) + EXIT_IDLE_BUY_FILL_DELAY_MS;
  const nextSellRefresh = orders
    .filter((order) => info(order)?.closing && info(order)?.key === strategy)
    .map((order) => sellDue.get(orderId(order)) ?? Number.POSITIVE_INFINITY)
    .filter((dueAt) => dueAt > now)
    .sort((left, right) => left - right)[0];
  // Ten seconds is the worker's discovery cadence.  An idle deadline or
  // sell refresh is allowed to wake the same vertical sooner.
  const pendingIdleDeadline = nextIdleDeadline > now ? nextIdleDeadline : Number.POSITIVE_INFINITY;
  return Math.min(pendingIdleDeadline, nextSellRefresh ?? Number.POSITIVE_INFINITY, now + policy.roundCooldownMs);
}

function exitStrategyNeedsWorker(strategy: string): boolean {
  if (liquidityExitRefreshes.has(strategy) || (inventoryByStrategy.get(strategy) ?? 0) > 0) return true;
  return orders.some((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === strategy
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  });
}

function scheduleExitWorker(strategy: string, template: Json, dueAt: number, reason: string): void {
  if (stopping || readOnly || policy.disableSellOrders) return;
  const safeDueAt = Math.max(Date.now(), dueAt);
  const existing = exitWorkerTimers.get(strategy);
  if (existing && existing.dueAt <= safeDueAt) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    exitWorkerTimers.delete(strategy);
    void runExitWorker(strategy, template, reason);
  }, Math.max(0, safeDueAt - Date.now()));
  exitWorkerTimers.set(strategy, { dueAt: safeDueAt, timer });
  executionJournal.record("exit.worker.scheduled", {
    strategy,
    reason,
    dueAt: new Date(safeDueAt).toISOString(),
  });
}

async function runExitWorker(strategy: string, template: Json, reason: string): Promise<void> {
  if (stopping || readOnly || policy.disableSellOrders) return;
  if (!policy.isExecutionWindowOpen()) {
    scheduleExitWorker(strategy, template, Date.now() + policy.roundCooldownMs, "outside-execution-window");
    return;
  }
  if (evaluatingExitStrategies.has(strategy)) {
    scheduleExitWorker(strategy, template, Date.now() + 250, "worker-already-running");
    return;
  }
  evaluatingExitStrategies.add(strategy);
  executionJournal.record("exit.worker.started", { strategy, reason });
  try {
    await refreshExitInventory(strategy, template);
    await evaluateExitStrategy(strategy, template, false);
  } catch (error) {
    stamp(`独立卖出 worker 失败 strategy=${strategy} error=${safeRuntimeError(error)}`);
    executionJournal.record("exit.worker.failed", { strategy, reason, error: safeRuntimeError(error) });
  } finally {
    evaluatingExitStrategies.delete(strategy);
    if (!stopping && exitStrategyNeedsWorker(strategy)) {
      scheduleExitWorker(strategy, template, nextExitWorkerDue(strategy), "worker-next-round");
    }
  }
}

async function evaluateExitStrategy(strategy: string, template: Json, forceStartup: boolean): Promise<void> {
  if (policy.disableSellOrders) return;
  const now = Date.now();
  const inventory = inventoryByStrategy.get(strategy) ?? 0;
  const activeClosingOrders = (): Json[] => orders.filter((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === strategy
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  }).sort((left, right) => eventTime(left) - eventTime(right) || orderId(left).localeCompare(orderId(right)));
  const active = activeClosingOrders();
  if (inventory <= 0) {
    for (const sell of active) queueSellCancel(strategy, sell, "empty-inventory");
    return;
  }
  const confirmedOpeningFillAt = lastOpeningFillAt.get(strategy) ?? null;
  const { eligibility, liquidity, liquidityReady, targetQuantity } = currentExitTarget(strategy, inventory, now);
  const gateState = `${inventory}:${targetQuantity}:${eligibility.reason}:${liquidity?.remainingRefreshes ?? 0}:${liquidityReady}`;
  if (exitGateStates.get(strategy) !== gateState) {
    exitGateStates.set(strategy, gateState);
    executionJournal.record("exit.gate", {
      strategy,
      inventory,
      lastOpeningFillAt: confirmedOpeningFillAt === null ? null : new Date(confirmedOpeningFillAt).toISOString(),
      liquidity: liquidity ?? null,
      ...eligibility,
      targetQuantity,
    });
  }
  if (forceStartup) stamp(`启动独立卖出 worker strategy=${strategy} inventory=${inventory} activeSells=${active.length}`);
  if (targetQuantity <= 0) {
    for (const sell of active) queueSellCancel(strategy, sell, "idle-countdown-reset");
    return;
  }
  if (active.length > 1) {
    for (const sell of active.slice(1)) queueSellCancel(strategy, sell, "duplicate-working-sell");
    return;
  }
  const sell = active[0];
  const liquidityRefreshDue = liquidity !== undefined
    && liquidityReady && liquidity.remainingRefreshes > 0 && now >= liquidity.nextAt;
  if (sell) {
    if (recordRefreshSpreadSkip(sell, "sell-refresh")) return;
    const id = orderId(sell);
    const due = sellDue.get(id) ?? 0;
    const needsReplace = exitRefreshNeeded(
      Number(sell.price), quantity(sell), remaining(sell), EXIT_ORDER_PRICE, targetQuantity,
    );
    if (!needsReplace) {
      if (mayRecreateStaleOrder(eventTime(sell), now, staleExitRetryAt.get(id) ?? 0)) {
        queueVerifiedStaleExitRecreate(strategy, sell, template);
        return;
      }
      if (liquidityRefreshDue && liquidity) advanceLiquidityRefresh(strategy, liquidity, id, now);
      sellDue.set(id, now + (liquidityRefreshDue ? LIQUIDITY_EXIT_REFRESH_MS : EXIT_REFRESH_MS));
      executionJournal.record("exit.refresh-noop", {
        strategy, orderId: id, quantity: targetQuantity,
        reason: liquidityRefreshDue ? "unchanged-liquidity-refresh" : "unchanged-working-sell",
      });
      return;
    }
    if (!liquidityRefreshDue && now < due) return;
    if (liquidityRefreshDue && liquidity) advanceLiquidityRefresh(strategy, liquidity, id, now);
    sellDue.set(id, now + (liquidityRefreshDue ? LIQUIDITY_EXIT_REFRESH_MS : EXIT_REFRESH_MS));
    const priority = executionPriority("exit");
    writer.enqueue({
      key: `sell-refresh:${id}`, priority,
      run: async () => {
        const liveSell = orders.find((order) => orderId(order) === id);
        if (!liveSell || !working.has(String(liveSell.status))) return;
        // Revalidate with the shared account-level snapshot immediately before
        // the final Replace. The queue can wait behind unrelated writes, so
        // the quantity decided by the worker is not safe to reuse here.
        const currentInventory = await refreshExitInventory(strategy, template, "before-sell-refresh");
        const currentTarget = currentExitTarget(strategy, currentInventory, Date.now()).targetQuantity;
        if (currentTarget <= 0) {
          executionJournal.record("exit.refresh.skipped", {
            strategy, orderId: id, reason: "no-current-exit-inventory", inventory: currentInventory,
          });
          queueSellCancel(strategy, liveSell, "no-current-exit-inventory");
          return;
        }
        if (!exitRefreshNeeded(Number(liveSell.price), quantity(liveSell), remaining(liveSell), EXIT_ORDER_PRICE, currentTarget)) {
          executionJournal.record("exit.refresh-noop", {
            strategy, orderId: id, quantity: currentTarget, reason: "unchanged-after-write-time-inventory-check",
          });
          return;
        }
        const payload = payloadFrom(template, currentTarget, true);
        try {
          const replacement = await writeOrder(`sell-refresh:${id}:${Date.now()}`, "PUT", `/trader/v1/accounts/${accountHash}/orders/${id}`, payload, priority);
          applyLocalReplace(id, payload, replacement);
          stamp(`卖单 Replace strategy=${strategy} quantity=${currentTarget} replacement=${replacement}`);
        } catch (error) {
          if (!deferExitAfterPreviewRejection(strategy, id, error)) throw error;
          // A broker PRICE_OR_QUANTITY rejection can be an order-age or
          // exchange-state issue rather than a duplicate sell.  Each eligible
          // 90-second exit gets its own guarded retry every ten seconds.
          if (mayRecreateStaleOrder(eventTime(liveSell), Date.now(), staleExitRetryAt.get(id) ?? 0)) {
            executionJournal.record("exit.preview-rebuild-queued", {
              strategy, orderId: id, inventory: currentInventory, targetQuantity: currentTarget,
            });
            queueVerifiedStaleExitRecreate(strategy, liveSell, template);
          }
        }
      },
    });
    return;
  }
  if (now < (sellSubmitDue.get(strategy) ?? 0)) return;
  if (!maySubmitExit(active.length, sellSubmitInFlight.has(strategy))) {
    executionJournal.record("exit.submit.skipped", {
      strategy,
      reason: active.length > 0 ? "working-sell-already-exists" : "submit-already-in-flight",
      activeWorkingSells: active.map(orderId),
    });
    return;
  }
  if (Date.now() - lastFullOrderPollAt >= 5_000 && !await ensureFreshOrdersForExit()) return;
  // A full reconciliation may have completed while its REST request was in
  // flight.  Do not enqueue a stale sell-submit decision.
  if (!maySubmitExit(activeClosingOrders().length, sellSubmitInFlight.has(strategy))) {
    executionJournal.record("exit.submit.skipped", { strategy, reason: "working-sell-found-after-reconciliation" });
    return;
  }
  sellSubmitDue.set(strategy, now + (liquidityReady ? LIQUIDITY_EXIT_REFRESH_MS : EXIT_REFRESH_MS));
  if (liquidityReady && liquidity) liquidity.nextAt = now + LIQUIDITY_EXIT_REFRESH_MS;
  const priority = executionPriority("exit");
  sellSubmitInFlight.add(strategy);
  writer.enqueue({
    key: `sell-submit:${strategy}`, priority,
    run: async () => {
      try {
        const currentInventory = await refreshExitInventory(strategy, template, "before-sell-submit");
        const currentTarget = currentExitTarget(strategy, currentInventory, Date.now()).targetQuantity;
        if (currentTarget <= 0) {
          executionJournal.record("exit.submit.skipped", {
            strategy, reason: "no-current-exit-inventory", inventory: currentInventory,
          });
          return;
        }
        const current = activeClosingOrders();
        if (current.length > 0) {
          executionJournal.record("exit.submit.skipped", {
            strategy, reason: "working-sell-found-before-preview", activeWorkingSells: current.map(orderId),
          });
          return;
        }
        const payload = payloadFrom(template, currentTarget, true);
        const newId = await writeOrder(`sell-submit:${strategy}:${Date.now()}`, "POST", `/trader/v1/accounts/${accountHash}/orders`, payload, priority);
        applyLocalSubmit(payload, newId);
        stamp(`自动卖出 strategy=${strategy} quantity=${currentTarget} newOrder=${newId}`);
      } catch (error) {
        if (!deferExitAfterPreviewRejection(strategy, null, error)) throw error;
      } finally {
        sellSubmitInFlight.delete(strategy);
      }
    },
  });
}

function queueSellCancel(strategy: string, sell: Json, reason: string): void {
  if (policy.disableSellOrders) return;
  const id = orderId(sell);
  if (cancelingSells.has(id)) return;
  cancelingSells.add(id);
  const priority = executionPriority("exit");
  writer.enqueue({
    key: `sell-cancel:${reason}:${id}`, priority,
    run: async () => {
      await cancelOrder(`sell-cancel:${reason}:${id}`, id);
      sellDue.delete(id);
      stamp(`卖单取消 strategy=${strategy} order=${id} reason=${reason}`);
    },
  });
}

function liquidityConstrained(): boolean {
  return liquidityExitRefreshes.size > 0;
}

function executionPriority(kind: "replenishment" | "exit" | "refresh"): Priority {
  if (kind === "refresh") return 2;
  if (liquidityConstrained()) return kind === "exit" ? 0 : 1;
  return kind === "replenishment" ? 0 : 1;
}

function deferExitAfterPreviewRejection(strategy: string, orderIdValue: string | null, error: unknown): boolean {
  const message = String(error);
  if (!message.includes("SCHWAB_PREVIEW_REJECTED") && !message.includes("CACHED_PREVIEW_REJECTED")) return false;
  const cooldownMs = message.includes("CACHED_PREVIEW_REJECTED")
    ? PREVIEW_REJECTION_COOLDOWN_MS
    : previewRejectionCooldownFromError(error, PREVIEW_REJECTION_COOLDOWN_MS);
  const nextAt = Date.now() + cooldownMs;
  if (orderIdValue) sellDue.set(orderIdValue, nextAt);
  else sellSubmitDue.set(strategy, nextAt);
  // A funding-triggered exit normally refreshes every five seconds.  A
  // rejected Preview must override that cadence or it will continuously
  // consume Preview quota and delay priority replenishments.
  const liquidity = liquidityExitRefreshes.get(strategy);
  if (liquidity) liquidity.nextAt = Math.max(liquidity.nextAt, nextAt);
  executionJournal.record("exit.preview-retry-deferred", {
    strategy,
    orderId: orderIdValue,
    nextAt: new Date(nextAt).toISOString(),
    cooldownMs,
    reason: message.includes("CACHED_PREVIEW_REJECTED") ? "cached-rejection" : "broker-rejection",
  });
  stamp(`卖单 Preview 拒绝，延后重试 strategy=${strategy} retryInMs=${cooldownMs}`);
  return true;
}

function advanceLiquidityRefresh(
  strategy: string,
  liquidity: { sellAt: number; remainingRefreshes: number; nextAt: number },
  orderIdValue: string,
  now: number,
): void {
  liquidity.remainingRefreshes -= 1;
  if (liquidity.remainingRefreshes <= 0) {
    liquidityExitRefreshes.delete(strategy);
    executionJournal.record("exit.liquidity-refresh-complete", { strategy, refreshedOrder: orderIdValue });
    return;
  }
  liquidity.nextAt = now + LIQUIDITY_EXIT_REFRESH_MS;
  executionJournal.record("exit.liquidity-refresh-round", {
    strategy,
    refreshedOrder: orderIdValue,
    remainingRounds: liquidity.remainingRefreshes,
    nextAt: new Date(liquidity.nextAt).toISOString(),
  });
}

function evaluateExits(forceStartup = false): void {
  if (stopping || readOnly || policy.disableSellOrders || !policy.isExecutionWindowOpen()) return;
  for (const [strategy, template] of exitTemplates()) {
    // Startup intentionally wakes every known strategy. Subsequent discovery
    // rounds may only create workers for newly current strategies: resetting
    // existing timers here defeats their per-strategy refresh and retry due
    // times, causing repeated Preview traffic every global round.
    if (exitStrategyNeedsWorker(strategy) && (forceStartup || (!exitWorkerTimers.has(strategy) && !evaluatingExitStrategies.has(strategy)))) {
      scheduleExitWorker(strategy, template, Date.now(), forceStartup ? "startup-recovery" : "discovery-round");
    }
  }
}

function reconcileCurrentExitStrategies(): void {
  if (stopping || readOnly || policy.disableSellOrders || !policy.isExecutionWindowOpen()) return;
  for (const [strategy, template] of exitTemplates()) {
    // Keep a live strategy's own timer intact. A current full-order response
    // only starts a worker for a strategy that is not already being watched.
    if (exitStrategyNeedsWorker(strategy) && !exitWorkerTimers.has(strategy) && !evaluatingExitStrategies.has(strategy)) {
      scheduleExitWorker(strategy, template, Date.now(), "full-order-reconciliation");
    }
  }
}

let activityStream: SchwabActivityStream | null = null;

async function checkControlRequest(): Promise<void> {
  if (controlCheckRunning || stopping) return;
  controlCheckRunning = true;
  try {
    const request = JSON.parse(await readFile(runtimeControlPath, "utf8")) as { command?: unknown; requestId?: unknown };
    if ((request.command !== "stop" && request.command !== "stop-for-restart") || typeof request.requestId !== "string" || !request.requestId) {
      return;
    }
    if (!requestStop(String(request.command))) return;
    executionJournal.record("run.control-requested", { command: request.command, requestId: request.requestId });
    stamp(`RUNTIME_CONTROL_ACCEPTED command=${request.command} requestId=${request.requestId}`);
    await writeRuntimeState("stopping", stopReason);
    await unlink(runtimeControlPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      stamp(`RUNTIME_CONTROL_READ_FAILED error=${safeRuntimeError(error)}`);
    }
  } finally {
    controlCheckRunning = false;
  }
}

function requestStop(reason: string): boolean {
  if (stopping) return false;
  stopReason = reason;
  stopping = true;
  return true;
}

async function completeStoppedBeforeStartup(): Promise<void> {
  await writeRuntimeState("stopped", stopReason);
  executionJournal.record("run.stopped", { reason: stopReason, phase: "before-startup" });
  await executionJournal.flush();
}

function launchRuntimeBackgroundTask(
  task: string,
  operation: () => void | Promise<unknown>,
): void {
  superviseBackgroundTask(task, operation, (_task, error, code) => {
    if (!requestStop(`background-task-failed:${task}`)) return;
    executionJournal.record("runtime.background-task-failed", {
      task,
      code,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    stamp(`RUNTIME_BACKGROUND_TASK_FAILED task=${task} code=${code}`);
  });
}

unbindRuntimeProcessHandlers = bindRuntimeProcessHandlers(host.processEvents, {
  onSignal: (signal) => {
    if (!requestStop("signal")) return;
    executionJournal.record("run.signal-received", { signal });
  },
  onExit: () => runtimeLock.release(),
});
unbindRuntimeAbortSignal = bindRuntimeAbortSignal(host.signal, () => {
  if (!requestStop("abort-signal")) return;
  executionJournal.record("run.abort-requested", { source: "AutomationRuntimeOptions.signal" });
});

if (stopping) {
  await completeStoppedBeforeStartup();
  return;
}
executionJournal.record("run.journal-preflight", { readOnly });
await executionJournal.flush();
if (stopping) {
  await completeStoppedBeforeStartup();
  return;
}
if (!readOnly) await ensureWeeklyReauthorization();
if (stopping) {
  await completeStoppedBeforeStartup();
  return;
}
await writeRuntimeState("running");
if (stopping) {
  await completeStoppedBeforeStartup();
  return;
}
executionJournal.record("run.started", {
  readOnly,
  once,
  underlyings: [...policy.underlyings],
  strikeMin: policy.strikeMin,
  strikeMax: policy.strikeMax,
  strikeRanges: Object.fromEntries(policy.strikeRanges),
  executionWindow: `${policy.executionStart}-${policy.executionEnd}`,
  fixedPriceRefreshIntervalMs: policy.fixedPriceRefreshIntervalMs,
  maxRefreshRounds: policy.maxRefreshRounds,
  repeatBuyAtOrderPrice: policy.repeatBuyAtOrderPrice,
  disableSellOrders: policy.disableSellOrders,
  buildId: host.env.SCHWAB_BOT_BUILD_ID ?? null,
});
const strikeRangesSummary = [...policy.strikeRanges.entries()]
  .flatMap(([underlying, ranges]) => ranges.map((range) => `${underlying}:${range.minimum}:${range.maximum}`))
  .join(",");
stamp(readOnly ? "Node 直连 Schwab 只读启动" : `Node 直连 Schwab 启动 underlyings=${[...policy.underlyings].join(",")} refreshStrikeRanges=${strikeRangesSummary} executionWindow=${policy.executionStart}-${policy.executionEnd} ET orderCooldown=${policy.orderCooldownMs}ms fixedPriceRefreshInterval=${policy.fixedPriceRefreshIntervalMs}ms maxRefreshRounds=${policy.maxRefreshRounds ?? "unlimited"} roundCooldown=${policy.roundCooldownMs}ms`);
if (!readOnly) stamp(policy.repeatBuyAtOrderPrice
  ? "FIXED_PRICE_CYCLE_ENABLED source=orderLimit; price exploration is disabled; one working opening order per strategy is maintained and refreshed at its existing price"
  : "PRICE_EXPLORER_FILL_PRICE_SOURCE source=actualNet");
if (policy.disableSellOrders) {
  recordSellOrderAutomationDisabled();
  stamp("SELL_ORDER_AUTOMATION_DISABLED: no sell Submit, Replace, or Cancel will be sent; existing working sells are left unchanged");
}
const startupCoordinator = new RuntimeStartupCoordinator({
  bootstrap,
  fullSnapshot: () => poll(true),
  onBlocked: async (reason, error) => {
    const startupReason = reason === "bootstrap-failed"
      ? "account-bootstrap-failed"
      : "initial-full-order-reconciliation-failed";
    executionJournal.record("run.start-blocked", {
      reason: startupReason,
      error: error === undefined ? null : safeRuntimeError(error),
    });
    stamp(reason === "bootstrap-failed"
      ? `启动停止：账户 bootstrap 失败 error=${safeRuntimeError(error)}`
      : "启动停止：初始完整订单快照或未知写入只读对账失败，未启动任何交易循环");
    requestStop(startupReason);
  },
  startActivityStream: async () => {
    if (once || stopping) return;
    activityStream = new SchwabActivityStream({
      loadContext: loadActivityStreamContext,
      onActivity: handleAccountActivity,
      onState: stamp,
    });
    activityStream.start();
    if (!readOnly) launchRuntimeBackgroundTask("explorer-round-loop", explorerRoundLoop);
  },
});
const startupReady = await startupCoordinator.start();
if (startupReady && !readOnly && !stopping) {
  await reconcilePositions();
  stamp(policy.disableSellOrders
    ? "启动阶段：卖单自动化已禁用；仅执行买单与只读订单/持仓对账"
    : policy.repeatBuyAtOrderPrice
    ? "启动阶段：先处理全部可卖库存；固定价格模式保留整体买单同价 Replace 刷新，并且每个策略只维护一张工作买单"
    : "启动阶段：先处理全部可卖库存，再启动整体买单刷新");
  await evaluateExits(true);
  if (!policy.disableSellOrders) stamp("启动卖出评估已调度；成交监听、每策略卖单维护与整体刷新并行运行");
}
if (once || !startupReady || stopping) {
  if (!stopping) requestStop(once ? "once-complete" : "startup-blocked");
} else {
  runtimeIntervals.push(setInterval(() => {
    const fallbackDue = Date.now() - lastFillPollAt >= 30_000;
    if (!activityStream?.ready || fallbackDue) {
      launchRuntimeBackgroundTask("fallback-fill-poll", () => poll(false));
    }
  }, 2_000));
  if (!policy.repeatBuyAtOrderPrice) runtimeIntervals.push(setInterval(() => {
    launchRuntimeBackgroundTask("explorer-tick", explorerTick);
  }, 200));
  if (policy.repeatBuyAtOrderPrice) runtimeIntervals.push(setInterval(() => {
    if (fixedPriceRefreshRoundActive) {
      launchRuntimeBackgroundTask("fixed-price-full-poll", () => poll(true, 3));
    }
  }, 2_000));
  runtimeIntervals.push(setInterval(() => void evaluateExits(), policy.roundCooldownMs));
  runtimeIntervals.push(setInterval(() => void checkControlRequest(), 250));
}
while (!stopping) await wait(250);
for (const interval of runtimeIntervals) clearInterval(interval);
for (const { timer } of exitWorkerTimers.values()) clearTimeout(timer);
exitWorkerTimers.clear();
if (activityRestTimer) clearTimeout(activityRestTimer);
executionJournal.record("run.stopping", { reason: stopReason });
if (!readOnly) persistExplorer();
const streamToStop = activityStream as SchwabActivityStream | null;
if (streamToStop) await streamToStop.stop();
await writer.waitIdle();
const auditFlushResults = await Promise.allSettled([
  sendEvidenceAudit.flush(),
  policyAlertAudit.flush(),
]);
const auditFlushFailure = auditFlushResults.find(
  (result): result is PromiseRejectedResult => result.status === "rejected",
);
if (auditFlushFailure) {
  const code = safeRuntimeError(auditFlushFailure.reason);
  executionJournal.record("runtime.operational-audit-flush-failed", { code });
  stamp(`OPERATIONAL_AUDIT_FLUSH_FAILED error=${code}`);
}
const stateFlushResults = await Promise.allSettled([
  explorerStateStore.flush(),
  fixedPriceCycleStateStore.flush(),
  exitTemplateStateStore.flush(),
]);
const stateFlushFailure = stateFlushResults.find(
  (result): result is PromiseRejectedResult => result.status === "rejected",
);
if (stateFlushFailure) {
  const code = safeRuntimeError(stateFlushFailure.reason);
  executionJournal.record("runtime.state-flush-failed", { code });
  stamp(`RUNTIME_STATE_FLUSH_FAILED error=${code}`);
}
await writeRuntimeState("stopped", stopReason);
executionJournal.record("run.stopped", { reason: stopReason });
await executionJournal.flush();
if (auditFlushFailure) {
  throw new Error("OPERATIONAL_AUDIT_PERSISTENCE_FAILED", { cause: auditFlushFailure.reason });
}
if (stateFlushFailure) {
  throw new Error("RUNTIME_STATE_PERSISTENCE_FAILED", { cause: stateFlushFailure.reason });
}

} finally {
  unbindRuntimeAbortSignal();
  unbindRuntimeProcessHandlers();
  runtimeLock.release();
}
}
