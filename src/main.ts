import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { SchwabActivityStream, type ActivityBatch } from "./activity_stream.ts";
import { requireWeeklyReauthorization, SchwabTokenProvider } from "./auth.ts";
import { PriorityGate, PriorityWriter, type Priority } from "./priority_runtime.ts";
import { SchwabRestClient } from "./schwab_client.ts";
import { SchwabApiError } from "../vendor/schwab-api-nodejs/src/utils/errors.ts";
import { parseRuntimePolicy } from "./runtime_policy.ts";
import { EXIT_ORDER_PRICE, orderInfo, orderPolicyViolation, type Json } from "./order_policy.ts";
import { completeNetDebitFill, completeOrderLimitFill } from "./fill_price.ts";
import { MAX_ACTIVE_ORDERS, PriceExplorer, type ExplorerAction, type ExplorerSnapshot } from "./price_explorer.ts";
import { ExecutionJournal } from "./execution_journal.ts";
import { EXIT_IDLE_BUY_FILL_DELAY_MS, EXIT_REFRESH_MS, LIQUIDITY_EXIT_DELAY_MS, LIQUIDITY_EXIT_REFRESH_MS, LIQUIDITY_EXIT_REFRESH_ROUNDS, exitEligibility } from "./exit_policy.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const evidencePath = join(root, ".state", "send-evidence.jsonl");
const policyAlertPath = join(root, ".state", "policy-alerts.jsonl");
const explorerStatePath = join(root, ".state", "net-price-explorer.json");
const fixedPriceCycleStatePath = join(root, ".state", "fixed-price-cycle.json");
const exitTemplateStatePath = join(root, ".state", "exit-templates.json");
const runtimeStatePath = join(root, ".state", "runtime", "active-run.json");
const runtimeControlPath = join(root, ".state", "runtime", "control-request.json");
const runId = randomUUID();
const executionJournal = new ExecutionJournal(root, runId, (error) => {
  process.stderr.write(`${new Date().toISOString()} [node-vertical] EXECUTION_JOURNAL_WRITE_FAILED error=${String(error)}\n`);
});
const working = new Set(["PENDING_ACTIVATION", "QUEUED", "WORKING", "PARTIALLY_FILLED", "AWAITING_PARENT_ORDER"]);
const readOnly = process.argv.includes("--read-only");
const once = process.argv.includes("--once");
const confirmIndex = process.argv.indexOf("--confirm-live");
const confirmedLive = confirmIndex >= 0 && process.argv[confirmIndex + 1] === "I_UNDERSTAND";
if (!readOnly && !confirmedLive) {
  throw new Error("真实写入必须显式传入 --confirm-live I_UNDERSTAND");
}
const policy = parseRuntimePolicy(process.argv);

function stamp(message: string): void {
  const value = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Singapore", dateStyle: "short", timeStyle: "medium", hour12: false,
  }).format(new Date());
  process.stderr.write(`${value} [node-vertical] ${message}\n`);
  executionJournal.record("console", { message });
}

async function writeRuntimeState(state: "running" | "stopping" | "stopped", reason?: string): Promise<void> {
  const value = {
    schemaVersion: 1,
    state,
    reason: reason ?? null,
    runId,
    pid: process.pid,
    workspaceRoot: root,
    nodePath: process.execPath,
    entryPath: fileURLToPath(import.meta.url),
    buildId: process.env.SCHWAB_BOT_BUILD_ID ?? null,
    args: process.argv.slice(2),
    journalPath: executionJournal.path,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(runtimeStatePath), { recursive: true });
  const temporary = `${runtimeStatePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), "utf8");
  await rename(temporary, runtimeStatePath);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadExplorer(): Promise<PriceExplorer> {
  try {
    const value = JSON.parse(await readFile(explorerStatePath, "utf8")) as ExplorerSnapshot;
    if (!value || typeof value !== "object" || !value.groups || typeof value.groups !== "object") {
      throw new Error("EXPLORER_STATE_INVALID");
    }
    return new PriceExplorer(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new PriceExplorer();
    throw error;
  }
}

async function loadFixedPriceCycle(): Promise<Set<string>> {
  try {
    const value = JSON.parse(await readFile(fixedPriceCycleStatePath, "utf8")) as unknown;
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new Error("FIXED_PRICE_CYCLE_STATE_INVALID");
    return new Set(value.slice(-1_000));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

function persistExplorer(): void {
  if (readOnly) return;
  const snapshot = explorer.snapshot();
  explorerSavePending = explorerSavePending.then(async () => {
    await mkdir(dirname(explorerStatePath), { recursive: true });
    const temporary = `${explorerStatePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), "utf8");
    await rename(temporary, explorerStatePath);
  }).catch((error) => stamp(`PRICE_EXPLORER_STATE_SAVE_FAILED error=${String(error)}`));
}

function persistFixedPriceCycle(): void {
  if (readOnly) return;
  const snapshot = [...fixedPriceCycleConsumedFills].slice(-1_000);
  fixedPriceCycleSavePending = fixedPriceCycleSavePending.then(async () => {
    await mkdir(dirname(fixedPriceCycleStatePath), { recursive: true });
    const temporary = `${fixedPriceCycleStatePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), "utf8");
    await rename(temporary, fixedPriceCycleStatePath);
  }).catch((error) => stamp(`FIXED_PRICE_CYCLE_STATE_SAVE_FAILED error=${String(error)}`));
}

class ExplorerActionPacer {
  private tail = Promise.resolve();
  private lastNormalActionAt = 0;

  async admit(): Promise<void> {
    const next = this.tail.then(async () => {
      const delay = policy.orderCooldownMs - (Date.now() - this.lastNormalActionAt);
      if (delay > 0) await wait(delay);
      this.lastNormalActionAt = Date.now();
    });
    this.tail = next.catch(() => undefined);
    await next;
  }
}

class RequestBudget {
  private attempts: number[] = [];
  private blockedUntil = 0;
  private lastHeadroomLogAt = 0;
  private lastPriorityActivityAt = Date.now();

  async admit(priority: Priority): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.attempts = this.attempts.filter((value) => now - value < 60_000);
      if (now < this.blockedUntil) {
        await wait(Math.min(1_000, this.blockedUntil - now));
        continue;
      }
      const ceiling = priority === 0 ? 110 : priority === 3 ? (now - this.lastPriorityActivityAt >= 2_000 ? 110 : 105) : 108;
      if (this.attempts.length < ceiling) {
        this.attempts.push(now);
        if (priority < 3) this.lastPriorityActivityAt = now;
        return;
      }
      if (priority === 3) {
        if (now - this.lastHeadroomLogAt >= 5_000) {
          this.lastHeadroomLogAt = now;
          stamp(`整体刷新等待滚动配额释放 usedLast60s=${this.attempts.length} refreshCeiling=${ceiling}`);
        }
        await wait(Math.max(100, 60_000 - (now - this.attempts[0])));
        continue;
      }
      if (priority === 2) throw new Error("SELL_QUOTA_EXHAUSTED");
      if (priority === 1) throw new Error("FOLLOWUP_QUOTA_HEADROOM");
      await wait(Math.max(100, 60_000 - (now - this.attempts[0])));
    }
  }

  rateLimited(retryAfter: string | null): void {
    const seconds = Math.max(30, Math.min(300, Number(retryAfter) || 30));
    this.blockedUntil = Date.now() + seconds * 1_000;
    stamp(`Schwab 429，全局退避 ${seconds}s`);
  }
}

const tokens = new SchwabTokenProvider(stamp);
const budget = new RequestBudget();
const client = new SchwabRestClient();

async function api(
  path: string,
  init: RequestInit = {},
  priority: Priority = 0,
): Promise<{ body: any; headers: Headers }> {
  await budget.admit(priority);
  const token = await tokens.get();
  try {
    return await client.request<any>(path, init, token);
  } catch (error) {
    if (error instanceof SchwabApiError) {
      if (error.status === 429) budget.rateLimited(error.headers["retry-after"] ?? null);
      if (error.status === 401) void tokens.get(true);
      throw new Error(`SCHWAB_HTTP_${error.status}`);
    }
    throw error;
  }
}

const writer = new PriorityWriter(stamp);
const finalWriteGate = new PriorityGate();
let accountHash = "";
let orders: Json[] = [];
let polling = false;
const evaluatingExitStrategies = new Set<string>();
let reconciling = false;
let lastFullOrderPollAt = 0;
let lastPositionReconciledAt = 0;
let positionRefreshPending: Promise<void> | null = null;
let stopping = false;
let stopReason = "normal";
let controlCheckRunning = false;
let activityRestTimer: NodeJS.Timeout | null = null;
const runtimeIntervals: NodeJS.Timeout[] = [];
let activityRestRunning = false;
let lastIncompleteActivityAt = 0;
let lastActivityRestAt = 0;
let lastFillPollAt = 0;
const openingFillLots = new Map<string, Map<string, number>>();
const lastOpeningFillAt = new Map<string, number>();
const inventoryObservedAt = new Map<string, number>();
const inventoryByStrategy = new Map<string, number>();
const observedFillQuantities = new Map<string, number>();
let inventoryFillBaselineEstablished = false;
const unknownWrites = new Set<string>();
const sellDue = new Map<string, number>();
const sellSubmitDue = new Map<string, number>();
const cancelingSells = new Set<string>();
const exitGateStates = new Map<string, string>();
const liquidityExitRefreshes = new Map<string, { sellAt: number; remainingRefreshes: number; nextAt: number }>();
const exitWorkerTimers = new Map<string, { dueAt: number; timer: NodeJS.Timeout }>();
let exitPositionSnapshot: { at: number; positions: Map<string, { long: number; short: number }> } | null = null;
let exitPositionSnapshotPending: Promise<Map<string, { long: number; short: number }>> | null = null;
const previewRejectedUntil = new Map<string, number>();
const reportedPolicyAlerts = new Set<string>();
const explorer = await loadExplorer();
const fixedPriceCycleConsumedFills = await loadFixedPriceCycle();
const explorerTemplates = new Map<string, Json>();
const exitTemplatesByStrategy = await loadExitTemplates();
const reportedUnpricedFills = new Set<string>();
let explorerSavePending = Promise.resolve();
let fixedPriceCycleSavePending = Promise.resolve();
let exitTemplateSavePending = Promise.resolve();
const normalExplorerActionPacer = new ExplorerActionPacer();
const observedOrderStates = new Map<string, { status: string; filledQuantity: number; price: string; closeTime: string | null }>();
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

async function loadExitTemplates(): Promise<Map<string, Json>> {
  try {
    const value = JSON.parse(await readFile(exitTemplateStatePath, "utf8")) as Record<string, Json>;
    if (!value || typeof value !== "object") throw new Error("EXIT_TEMPLATE_STATE_INVALID");
    return new Map(Object.entries(value).filter(([, template]) => Array.isArray(template?.orderLegCollection)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

function recordOpeningFillLot(strategy: string, order: Json): void {
  const filledAt = eventTime(order);
  if (!Number.isFinite(filledAt)) return;
  const lots = openingFillLots.get(strategy) ?? new Map<string, number>();
  const firstObserved = !lots.has(orderId(order));
  lots.set(orderId(order), filledAt);
  openingFillLots.set(strategy, lots);
  lastOpeningFillAt.set(strategy, Math.max(lastOpeningFillAt.get(strategy) ?? 0, filledAt));
  rememberExitTemplate(strategy, order);
  if (firstObserved && !readOnly) {
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

function recordOrderTransitions(source: "full" | "fills", values: readonly Json[]): void {
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
}
function newYorkDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
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

function previewReportsInsufficientFunds(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /(insufficient\s+(funds|cash|buying power)|buying power.{0,40}insufficient|cash available.{0,40}insufficient|not enough.{0,40}(funds|cash|buying power))/i.test(text);
}

function requestLiquidityExit(payload: Json): void {
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
    .catch((error) => stamp(`LIQUIDITY_EXIT_POSITION_REFRESH_FAILED strategy=${meta.key} error=${String(error)}`))
    .finally(() => evaluateExits());
}

async function evidence(key: string, method: string, path: string, payload: Json): Promise<void> {
  await mkdir(dirname(evidencePath), { recursive: true });
  await appendFile(evidencePath, `${JSON.stringify({
    at: new Date().toISOString(), key, method, endpoint: path,
    payloadShape: { orderType: payload.orderType, price: payload.price, quantity: payload.quantity },
  })}\n`);
}

function reportPolicyAlert(source: string, order: Json, code: string, message: string): void {
  const id = String(order.orderId ?? "PENDING");
  const key = `${source}:${id}:${code}:${String(order.price)}`;
  if (reportedPolicyAlerts.has(key)) return;
  reportedPolicyAlerts.add(key);
  const record = {
    at: new Date().toISOString(), source, orderId: id, code, price: order.price ?? null, message,
  };
  stamp(`POLICY_ALERT code=${code} source=${source} order=${id} price=${String(order.price ?? "unknown")} detail=${message}`);
  void mkdir(dirname(policyAlertPath), { recursive: true })
    .then(() => appendFile(policyAlertPath, `${JSON.stringify(record)}\n`))
    .catch((error) => stamp(`POLICY_ALERT_AUDIT_FAILED error=${String(error)}`));
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

async function writeOrder(key: string, method: "POST" | "PUT", path: string, payload: Json, priority: Priority): Promise<string> {
  if (stopping) {
    executionJournal.record("broker.write.skipped", { key, reason: "runtime-stopping", method, path, order: payloadAuditData(payload) });
    throw new Error("RUNTIME_STOPPING");
  }
  if (readOnly) {
    executionJournal.record("broker.write.skipped", { key, reason: "read-only", method, path, order: payloadAuditData(payload) });
    return "READ_ONLY";
  }
  const violation = orderPolicyViolation(payload, policy, newYorkDate());
  if (violation) {
    executionJournal.record("broker.write.blocked", { key, method, path, code: violation.code, message: violation.message, order: payloadAuditData(payload) });
    reportPolicyAlert("write-blocked", payload, violation.code, violation.message);
    throw new Error(`ORDER_POLICY_BLOCKED_${violation.code}`);
  }
  await requireWeeklyReauthorization();
  policy.requireExecutionWindow();
  const previewFingerprint = createHash("sha256")
    .update(`${path}\0${JSON.stringify(payload)}`)
    .digest("hex");
  if (priority > 1 && Date.now() < (previewRejectedUntil.get(previewFingerprint) ?? 0)) {
    executionJournal.record("broker.preview.skipped", { key, reason: "cached-rejection", method, path, order: payloadAuditData(payload) });
    throw new Error("CACHED_PREVIEW_REJECTED");
  }
  executionJournal.record("broker.preview.requested", { key, method, path, priority, order: payloadAuditData(payload) });
  const preview = await api(
    `/trader/v1/accounts/${accountHash}/previewOrder`,
    { method: "POST", body: JSON.stringify(payload) },
    priority,
  );
  if (!previewAccepted(preview.body)) {
    if (priority > 1) previewRejectedUntil.set(previewFingerprint, Date.now() + 30_000);
    const blockers = previewBlockers(preview.body);
    const insufficientFunds = method === "POST" && previewReportsInsufficientFunds(preview.body);
    executionJournal.record("broker.preview.rejected", { key, method, path, blockers, insufficientFunds, order: payloadAuditData(payload) });
    if (insufficientFunds) {
      requestLiquidityExit(payload);
      throw new Error(`SCHWAB_PREVIEW_INSUFFICIENT_FUNDS blockers=${blockers}`);
    }
    throw new Error(`SCHWAB_PREVIEW_REJECTED blockers=${blockers}`);
  }
  previewRejectedUntil.delete(previewFingerprint);
  executionJournal.record("broker.preview.accepted", { key, method, path, order: payloadAuditData(payload) });
  await evidence(key, method, path, payload);
  try {
    executionJournal.record("broker.write.requested", { key, method, path, priority, order: payloadAuditData(payload) });
    const result = await finalWriteGate.run(
      priority,
      async () => {
        if (stopping) throw new Error("RUNTIME_STOPPING");
        await requireWeeklyReauthorization();
        policy.requireExecutionWindow();
        return api(path, { method, body: JSON.stringify(payload) }, 0);
      },
    );
    const brokerOrderId = result.headers.get("location")?.split("/").at(-1);
    if (!brokerOrderId) {
      unknownWrites.add(key);
      executionJournal.record("broker.write.unknown", { key, method, path, reason: "missing-location", order: payloadAuditData(payload) });
      throw new Error("SCHWAB_WRITE_ACCEPTED_WITHOUT_LOCATION");
    }
    executionJournal.record("broker.write.accepted", { key, method, path, brokerOrderId, order: payloadAuditData(payload) });
    return brokerOrderId;
  } catch (error) {
    if (String(error) === "Error: RUNTIME_STOPPING") {
      executionJournal.record("broker.write.skipped", { key, reason: "runtime-stopping-before-final-write", method, path, order: payloadAuditData(payload) });
    } else {
      unknownWrites.add(key);
      executionJournal.record("broker.write.unknown", { key, method, path, error: String(error), order: payloadAuditData(payload) });
    }
    throw error;
  }
}

async function cancelOrder(key: string, orderIdValue: string): Promise<void> {
  if (stopping) {
    executionJournal.record("broker.cancel.skipped", { key, orderId: orderIdValue, reason: "runtime-stopping" });
    throw new Error("RUNTIME_STOPPING");
  }
  if (readOnly) {
    executionJournal.record("broker.cancel.skipped", { key, orderId: orderIdValue, reason: "read-only" });
    return;
  }
  await requireWeeklyReauthorization();
  policy.requireExecutionWindow();
  const path = `/trader/v1/accounts/${accountHash}/orders/${orderIdValue}`;
  await evidence(key, "DELETE", path, {});
  try {
    executionJournal.record("broker.cancel.requested", { key, orderId: orderIdValue, path });
    await finalWriteGate.run(2, async () => {
      if (stopping) throw new Error("RUNTIME_STOPPING");
      await requireWeeklyReauthorization();
      policy.requireExecutionWindow();
      return api(path, { method: "DELETE" }, 2);
    });
    const source = orders.find((order) => orderId(order) === orderIdValue);
    if (source) source.status = "CANCELED";
    executionJournal.record("broker.cancel.accepted", { key, orderId: orderIdValue, path });
  } catch (error) {
    if (String(error) === "Error: RUNTIME_STOPPING") {
      executionJournal.record("broker.cancel.skipped", { key, orderId: orderIdValue, reason: "runtime-stopping-before-final-write" });
    } else {
      unknownWrites.add(key);
      executionJournal.record("broker.cancel.unknown", { key, orderId: orderIdValue, path, error: String(error) });
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const linked = await api("/trader/v1/accounts/accountNumbers");
  if (!Array.isArray(linked.body) || linked.body.length !== 1 || typeof linked.body[0]?.hashValue !== "string") {
    throw new Error("需要且仅允许一个 Schwab linked account");
  }
  accountHash = linked.body[0].hashValue;
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
  if (polling || stopping) return false;
  polling = true;
  try {
    const now = new Date();
    const lookbackMs = full ? 60 * 60_000 : 5 * 60_000;
    const from = new Date(now.getTime() - lookbackMs);
    const query = new URLSearchParams({
      fromEnteredTime: from.toISOString(),
      toEnteredTime: now.toISOString(),
      maxResults: "3000",
    });
    if (!full) query.set("status", "FILLED");
    const response = await api(`/trader/v1/accounts/${accountHash}/orders?${query}`, {}, priority);
    if (!Array.isArray(response.body)) throw new Error("订单快照不是数组");
    const incoming = flatten(response.body);
    if (full) {
      orders = incoming;
      recordOrderTransitions("full", orders);
      lastFullOrderPollAt = Date.now();
      reportWorkingOrderPolicyViolations();
      if (!readOnly && policy.isExecutionWindowOpen()) detectExplorerFills();
      reconcileExplorerSnapshot();
      stamp(`完整当前订单同步 orders=${orders.length}`);
    } else {
      const merged = new Map(orders.map((order) => [orderId(order), order]));
      for (const order of incoming) merged.set(orderId(order), order);
      orders = [...merged.values()];
      recordOrderTransitions("fills", incoming);
      stamp(`轻量成交同步 fills=${incoming.length}`);
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
  } catch (error) {
    if (!String(error).includes("REFRESH_QUOTA_HEADROOM")) {
      stamp(`订单快照失败 full=${full} error=${String(error)}`);
    }
    return false;
  } finally {
    polling = false;
  }
}

function handleAccountActivity(batch: ActivityBatch): void {
  // Stream payloads are hints only. The REST order snapshot remains the sole
  // authority for fills, terminal state, and any later broker write.
  stamp(`ACCT_ACTIVITY signal received hints=${batch.hints.length} complete=${batch.complete}; scheduling REST reconciliation`);
  scheduleActivityRestConfirmation();
}

function scheduleActivityRestConfirmation(): void {
  lastIncompleteActivityAt = Date.now();
  armActivityRestConfirmation();
}

function armActivityRestConfirmation(): void {
  if (activityRestTimer || activityRestRunning || stopping) return;
  const dueAt = Math.max(Date.now() + 2_000, lastActivityRestAt + 2_000);
  activityRestTimer = setTimeout(() => {
    activityRestTimer = null;
    void runActivityRestConfirmation();
  }, Math.max(0, dueAt - Date.now()));
}

async function runActivityRestConfirmation(): Promise<void> {
  if (stopping) return;
  if (lastFillPollAt >= lastIncompleteActivityAt) return;
  activityRestRunning = true;
  const confirmingThrough = lastIncompleteActivityAt;
  while (polling && !stopping) await wait(25);
  let confirmed = false;
  const coveredByOtherPoll = lastFillPollAt >= confirmingThrough;
  if (!stopping && !coveredByOtherPoll) {
    stamp("ACCT_ACTIVITY信息不足；2秒窗口内事件已合并，读取一次最近5分钟成交订单");
    confirmed = await poll(false, 0);
    if (confirmed) lastActivityRestAt = Date.now();
  }
  activityRestRunning = false;
  if ((!confirmed && !coveredByOtherPoll) || lastIncompleteActivityAt > confirmingThrough) {
    armActivityRestConfirmation();
  }
}

function managedOpening(order: Json): Json | null {
  const meta = info(order);
  if (
    !meta?.opening || meta.expiration !== newYorkDate() || !policy.underlyings.has(meta.underlying)
    || quantity(order) !== 1 || orderPolicyViolation(order, policy, newYorkDate())
  ) return null;
  return meta;
}

function rememberExitTemplate(strategy: string, order: Json): void {
  const current = exitTemplatesByStrategy.get(strategy);
  if (current && orderId(current) === orderId(order)) return;
  exitTemplatesByStrategy.set(strategy, structuredClone(order));
  if (readOnly) return;
  exitTemplateSavePending = exitTemplateSavePending.then(async () => {
    await mkdir(dirname(exitTemplateStatePath), { recursive: true });
    const temporary = `${exitTemplateStatePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(exitTemplatesByStrategy)), "utf8");
    await rename(temporary, exitTemplateStatePath);
  }).catch((error) => stamp(`EXIT_TEMPLATE_STATE_SAVE_FAILED error=${String(error)}`));
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
  return orders.filter((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.opening && meta.key === groupKey
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  }).sort((left, right) => Number(left.price) - Number(right.price) || eventTime(left) - eventTime(right) || orderId(left).localeCompare(orderId(right)));
}

function hasExitPriority(groupKey: string): boolean {
  if (liquidityExitRefreshes.has(groupKey)) return true;
  return orders.some((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === groupKey
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  });
}

function isConfiguredExplorerGroup(groupKey: string): boolean {
  const [underlying, expiration] = groupKey.split(":");
  return policy.underlyings.has(underlying) && expiration === newYorkDate();
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
    if (now - fill.filledAt > 10_000) {
      executionJournal.record("explorer.fill.ignored", { order: orderAuditData(order), fillPriceSource, priceCents: fill.priceCents, filledAt: new Date(fill.filledAt).toISOString(), reason: "outside-ten-second-window" });
      continue;
    }
    if (policy.repeatBuyAtOrderPrice) {
      queueFixedPriceReplenishment(meta.key, order, fill.priceCents);
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
  writer.enqueue({
    key: `fixed-price-cycle:${filledOrderId}`,
    priority: 1,
    run: async () => {
      if (stopping || hasExitPriority(groupKey)) {
        executionJournal.record("fixed-price-cycle.deferred", { groupKey, filledOrderId, reason: stopping ? "runtime-stopping" : "exit-priority-active" });
        return;
      }
      if (activeOpeningOrders(groupKey).length >= MAX_ACTIVE_ORDERS) {
        executionJournal.record("fixed-price-cycle.deferred", { groupKey, filledOrderId, reason: "active-order-cap" });
        return;
      }
      const payload = payloadFrom(filledOrder, 1, false, priceCents);
      try {
        const brokerOrderId = await writeOrder(`fixed-price-cycle:${filledOrderId}:${Date.now()}`, "POST", `/trader/v1/accounts/${accountHash}/orders`, payload, 1);
        applyLocalSubmit(payload, brokerOrderId);
        fixedPriceCycleConsumedFills.add(filledOrderId);
        persistFixedPriceCycle();
        stamp(`FIXED_PRICE_CYCLE_REBUY group=${groupKey} sourceOrder=${filledOrderId} price=${(priceCents / 100).toFixed(2)} order=${brokerOrderId}`);
        executionJournal.record("fixed-price-cycle.rebuy-submitted", { groupKey, filledOrderId, priceCents, brokerOrderId, order: payloadAuditData(payload) });
      } catch (error) {
        if (String(error).startsWith("Error: SCHWAB_PREVIEW_INSUFFICIENT_FUNDS")) return;
        throw error;
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
  persistExplorer();
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
    if (policy.repeatBuyAtOrderPrice) {
      await wait(policy.roundCooldownMs);
      continue;
    }
    if (!policy.isExecutionWindowOpen()) {
      await wait(60_000);
      continue;
    }
    while (polling && !stopping) await wait(50);
    if (stopping || !await poll(true, 0)) {
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
    await wait(policy.roundCooldownMs);
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
    if (meta.opening) {
      recordOpeningFillLot(meta.key, order);
      inventoryObservedAt.set(meta.key, Date.now());
    }
    stamp(`内存库存更新 strategy=${meta.key} delta=${direction * delta} inventory=${inventoryByStrategy.get(meta.key)}`);
  }
  inventoryFillBaselineEstablished = true;
}

function adoptSells(): void {
  const active = new Set<string>();
  for (const order of orders) {
    const meta = info(order);
    if (
      !meta?.closing || !working.has(String(order.status))
      || meta.expiration !== newYorkDate() || !policy.underlyings.has(meta.underlying)
    ) continue;
    active.add(orderId(order));
    if (!sellDue.has(orderId(order))) sellDue.set(orderId(order), Date.now() + EXIT_REFRESH_MS);
  }
  for (const id of sellDue.keys()) {
    if (!active.has(id)) {
      sellDue.delete(id);
      cancelingSells.delete(id);
    }
  }
}

async function positions(): Promise<Map<string, { long: number; short: number }>> {
  const response = await api(`/trader/v1/accounts/${accountHash}?fields=positions`, {}, 2);
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
  lastPositionReconciledAt = Date.now();
  if (announce) stamp(`订单与持仓完整对账完成 strategies=${templates.size}；后台仍保留 110s 兜底对账`);
}

/**
 * Exit workers are independent per vertical, but the account-level positions
 * endpoint is coalesced for one second.  This gives every worker a fresh
 * authoritative inventory without multiplying identical Schwab reads.
 */
async function freshExitPositions(): Promise<Map<string, { long: number; short: number }>> {
  if (exitPositionSnapshot && Date.now() - exitPositionSnapshot.at < 1_000) return exitPositionSnapshot.positions;
  if (!exitPositionSnapshotPending) {
    exitPositionSnapshotPending = positions().then((current) => {
      exitPositionSnapshot = { at: Date.now(), positions: current };
      return current;
    }).finally(() => {
      exitPositionSnapshotPending = null;
    });
  }
  return exitPositionSnapshotPending;
}

async function refreshExitInventory(strategy: string, template: Json): Promise<number> {
  const current = await freshExitPositions();
  const inventory = availableFor(template, current);
  const previous = inventoryByStrategy.get(strategy) ?? 0;
  inventoryByStrategy.set(strategy, inventory);
  if (inventory > 0 && previous <= 0) inventoryObservedAt.set(strategy, Date.now());
  if (inventory <= 0) inventoryObservedAt.delete(strategy);
  executionJournal.record("exit.inventory.reconciled", { strategy, inventory, source: "independent-worker" });
  return inventory;
}

async function ensureFreshPositions(): Promise<void> {
  if (Date.now() - lastPositionReconciledAt < 110_000) return;
  if (!positionRefreshPending) {
    positionRefreshPending = reconcilePositions(false).finally(() => {
      positionRefreshPending = null;
    });
  }
  await positionRefreshPending;
}

async function ensureFreshOrdersForExit(): Promise<boolean> {
  if (Date.now() - lastFullOrderPollAt < 5_000) return true;
  while (polling && !stopping) await wait(50);
  if (stopping) return false;
  if (Date.now() - lastFullOrderPollAt < 5_000) return true;
  return poll(true, 2);
}

async function reconcileAll(): Promise<void> {
  if (reconciling || stopping || readOnly) return;
  reconciling = true;
  try {
    while (polling && !stopping) await wait(100);
    await ensureFreshPositions();
  } catch (error) {
    stamp(`订单与持仓完整对账失败 error=${String(error)}`);
  } finally {
    reconciling = false;
  }
}

function exitTemplates(): Map<string, Json> {
  const latest = new Map<string, Json>();
  for (const order of orders) {
    const meta = info(order);
    if (
      order.status !== "FILLED" || !meta?.opening
      || !policy.underlyings.has(meta.underlying)
      || meta.expiration !== newYorkDate()
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
      && (inventoryByStrategy.get(meta.key) ?? 0) > 0
      && !latest.has(meta.key)
    ) latest.set(meta.key, order);
  }
  for (const [strategy, template] of exitTemplatesByStrategy) {
    if ((inventoryByStrategy.get(strategy) ?? 0) > 0 && !latest.has(strategy)) latest.set(strategy, template);
  }
  return latest;
}

function nextExitWorkerDue(strategy: string): number {
  const now = Date.now();
  const liquidity = liquidityExitRefreshes.get(strategy);
  if (liquidity) return Math.max(now, liquidity.nextAt);
  const nextIdleDeadline = (lastOpeningFillAt.get(strategy) ?? inventoryObservedAt.get(strategy) ?? now) + EXIT_IDLE_BUY_FILL_DELAY_MS;
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

function scheduleExitWorker(strategy: string, template: Json, dueAt: number, reason: string): void {
  if (stopping || readOnly) return;
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
  if (stopping || readOnly) return;
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
    stamp(`独立卖出 worker 失败 strategy=${strategy} error=${String(error)}`);
    executionJournal.record("exit.worker.failed", { strategy, reason, error: String(error) });
  } finally {
    evaluatingExitStrategies.delete(strategy);
    if (!stopping) scheduleExitWorker(strategy, template, nextExitWorkerDue(strategy), "worker-next-round");
  }
}

async function evaluateExitStrategyLegacy(strategy: string, template: Json, forceStartup: boolean): Promise<void> {
  const inventory = inventoryByStrategy.get(strategy) ?? 0;
  const active = orders.filter((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === strategy
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  }).sort((left, right) => eventTime(left) - eventTime(right) || orderId(left).localeCompare(orderId(right)));
  if (inventory <= 0) {
    for (const staleSell of active) {
      const staleId = orderId(staleSell);
      if (cancelingSells.has(staleId)) continue;
      cancelingSells.add(staleId);
      writer.enqueue({
        key: `sell-cancel-empty:${staleId}`,
        priority: 2,
        run: async () => {
          await cancelOrder(`sell-cancel-empty:${staleId}`, staleId);
          sellDue.delete(staleId);
          stamp(`库存为零，残留卖单已取消 strategy=${strategy} order=${staleId}`);
        },
      });
    }
    return;
  }
  const knownFillLots = openingFillLots.get(strategy)?.size ?? 0;
  const maturedFills = maturedOpeningFillCount(strategy);
  const unattributedInventory = Math.max(0, inventory - knownFillLots);
  const observedAt = inventoryObservedAt.get(strategy) ?? Date.now();
  const eligibility = exitEligibility(inventory, maturedFills, unattributedInventory, observedAt);
  const liquidityRefresh = liquidityExitRefreshes.get(strategy);
  const targetUnitSells = liquidityRefresh ? inventory : eligibility.targetUnitSells;
  const gateState = `${inventory}:${targetUnitSells}:${eligibility.reason}:${liquidityRefresh?.remainingRounds ?? 0}`;
  if (exitGateStates.get(strategy) !== gateState) {
    exitGateStates.set(strategy, gateState);
    executionJournal.record("exit.gate", {
      strategy,
      inventory,
      knownFillLots,
      maturedFills,
      unattributedInventory,
      unattributedObservedAt: new Date(observedAt).toISOString(),
      liquidityRefresh: liquidityRefresh ?? null,
      ...eligibility,
      targetUnitSells,
    });
  }
  if (forceStartup) {
    stamp(`启动独立卖出 worker strategy=${strategy} inventory=${inventory} activeSells=${active.length}`);
  }
  const unitSells = active.filter((order) => quantity(order) === 1 && remaining(order) === 1);
  if (unitSells.length !== active.length) {
    return;
  }
  for (const excess of unitSells.slice(targetUnitSells)) {
    const id = orderId(excess);
    if (cancelingSells.has(id)) continue;
    cancelingSells.add(id);
    writer.enqueue({
      key: `sell-cancel-excess:${id}`, priority: 2,
      run: async () => cancelOrder(`sell-cancel-excess:${id}`, id),
    });
  }
  const liquidityRefreshDue = liquidityRefresh !== undefined && Date.now() >= liquidityRefresh.nextAt
    && unitSells.length >= targetUnitSells && targetUnitSells > 0;
  let forcedRefreshCount = 0;
  for (const sell of unitSells.slice(0, targetUnitSells)) {
    const id = orderId(sell);
    const due = sellDue.get(id) ?? 0;
    if (!liquidityRefreshDue && Date.now() < due && Number(sell.price) === EXIT_ORDER_PRICE) continue;
    const nextDelay = liquidityRefreshDue && liquidityRefresh.remainingRounds === 1
      ? EXIT_REFRESH_MS : liquidityRefreshDue ? LIQUIDITY_EXIT_REFRESH_MS : EXIT_REFRESH_MS;
    sellDue.set(id, Date.now() + nextDelay);
    if (liquidityRefreshDue) forcedRefreshCount += 1;
    writer.enqueue({
      key: `sell-refresh:${id}`, priority: 2,
      run: async () => {
        const liveSell = orders.find((order) => orderId(order) === id);
        if (!liveSell || !working.has(String(liveSell.status)) || quantity(liveSell) !== 1) return;
        const payload = payloadFrom(template, 1, true);
        const replacement = await writeOrder(
          `sell-refresh:${id}:${Date.now()}`, "PUT",
          `/trader/v1/accounts/${accountHash}/orders/${id}`, payload, 2,
        );
        applyLocalReplace(id, payload, replacement);
        stamp(`卖单 Replace strategy=${strategy} quantity=1 replacement=${replacement}`);
      },
    });
  }
  if (liquidityRefreshDue && forcedRefreshCount > 0 && liquidityRefresh) {
    liquidityRefresh.remainingRounds -= 1;
    if (liquidityRefresh.remainingRounds <= 0) {
      liquidityExitRefreshes.delete(strategy);
      executionJournal.record("exit.liquidity-refresh-complete", { strategy, refreshedOrders: forcedRefreshCount });
    } else {
      liquidityRefresh.nextAt = Date.now() + LIQUIDITY_EXIT_REFRESH_MS;
      executionJournal.record("exit.liquidity-refresh-round", { strategy, refreshedOrders: forcedRefreshCount, remainingRounds: liquidityRefresh.remainingRounds, nextAt: new Date(liquidityRefresh.nextAt).toISOString() });
    }
  }
  const deficit = Math.max(0, targetUnitSells - unitSells.length);
  if (deficit === 0) return;
  const nextSubmitAt = sellSubmitDue.get(strategy) ?? 0;
  if (Date.now() < nextSubmitAt && eligibility.reason !== "inventory-threshold" && !liquidityRefresh) return;
  if (Date.now() - lastFullOrderPollAt >= 5_000 && !await ensureFreshOrdersForExit()) return;
  sellSubmitDue.set(strategy, Date.now() + EXIT_REFRESH_MS);
  for (let index = 0; index < deficit; index += 1) {
    writer.enqueue({
      key: `sell-submit:${strategy}:${index}`, priority: 2,
      run: async () => {
        if ((inventoryByStrategy.get(strategy) ?? 0) <= 0) return;
        const payload = payloadFrom(template, 1, true);
        const newId = await writeOrder(
          `sell-submit:${strategy}:${index}:${Date.now()}`, "POST",
          `/trader/v1/accounts/${accountHash}/orders`, payload, 2,
        );
        applyLocalSubmit(payload, newId);
        stamp(`自动卖出 strategy=${strategy} quantity=1 newOrder=${newId}`);
      },
    });
  }
}

async function evaluateExitStrategy(strategy: string, template: Json, forceStartup: boolean): Promise<void> {
  const now = Date.now();
  const inventory = inventoryByStrategy.get(strategy) ?? 0;
  const active = orders.filter((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === strategy
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  }).sort((left, right) => eventTime(left) - eventTime(right) || orderId(left).localeCompare(orderId(right)));
  if (inventory <= 0) {
    for (const sell of active) queueSellCancel(strategy, sell, "empty-inventory");
    return;
  }
  const idleSince = lastOpeningFillAt.get(strategy) ?? inventoryObservedAt.get(strategy) ?? now;
  const eligibility = exitEligibility(inventory, idleSince, now);
  const liquidity = liquidityExitRefreshes.get(strategy);
  const liquidityReady = liquidity !== undefined && now >= liquidity.sellAt;
  const targetQuantity = liquidityReady ? inventory : eligibility.targetQuantity;
  const gateState = `${inventory}:${targetQuantity}:${eligibility.reason}:${liquidity?.remainingRefreshes ?? 0}:${liquidityReady}`;
  if (exitGateStates.get(strategy) !== gateState) {
    exitGateStates.set(strategy, gateState);
    executionJournal.record("exit.gate", {
      strategy,
      inventory,
      lastOpeningFillAt: new Date(idleSince).toISOString(),
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
    const id = orderId(sell);
    const due = sellDue.get(id) ?? 0;
    const needsQuantityUpdate = quantity(sell) !== targetQuantity || remaining(sell) !== targetQuantity;
    if (!liquidityRefreshDue && !needsQuantityUpdate && now < due && Number(sell.price) === EXIT_ORDER_PRICE) return;
    if (liquidityRefreshDue && liquidity) advanceLiquidityRefresh(strategy, liquidity, id, now);
    sellDue.set(id, now + (liquidityRefreshDue ? LIQUIDITY_EXIT_REFRESH_MS : EXIT_REFRESH_MS));
    writer.enqueue({
      key: `sell-refresh:${id}`, priority: 0,
      run: async () => {
        const liveSell = orders.find((order) => orderId(order) === id);
        if (!liveSell || !working.has(String(liveSell.status))) return;
        const payload = payloadFrom(template, targetQuantity, true);
        const replacement = await writeOrder(`sell-refresh:${id}:${Date.now()}`, "PUT", `/trader/v1/accounts/${accountHash}/orders/${id}`, payload, 0);
        applyLocalReplace(id, payload, replacement);
        stamp(`卖单 Replace strategy=${strategy} quantity=${targetQuantity} replacement=${replacement}`);
      },
    });
    return;
  }
  if (now < (sellSubmitDue.get(strategy) ?? 0)) return;
  if (Date.now() - lastFullOrderPollAt >= 5_000 && !await ensureFreshOrdersForExit()) return;
  sellSubmitDue.set(strategy, now + (liquidityReady ? LIQUIDITY_EXIT_REFRESH_MS : EXIT_REFRESH_MS));
  if (liquidityReady && liquidity) liquidity.nextAt = now + LIQUIDITY_EXIT_REFRESH_MS;
  writer.enqueue({
    key: `sell-submit:${strategy}`, priority: 0,
    run: async () => {
      if ((inventoryByStrategy.get(strategy) ?? 0) <= 0) return;
      const payload = payloadFrom(template, targetQuantity, true);
      const newId = await writeOrder(`sell-submit:${strategy}:${Date.now()}`, "POST", `/trader/v1/accounts/${accountHash}/orders`, payload, 0);
      applyLocalSubmit(payload, newId);
      stamp(`自动卖出 strategy=${strategy} quantity=${targetQuantity} newOrder=${newId}`);
    },
  });
}

function queueSellCancel(strategy: string, sell: Json, reason: string): void {
  const id = orderId(sell);
  if (cancelingSells.has(id)) return;
  cancelingSells.add(id);
  writer.enqueue({
    key: `sell-cancel:${reason}:${id}`, priority: 0,
    run: async () => {
      await cancelOrder(`sell-cancel:${reason}:${id}`, id);
      sellDue.delete(id);
      stamp(`卖单取消 strategy=${strategy} order=${id} reason=${reason}`);
    },
  });
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
  if (stopping || readOnly || !policy.isExecutionWindowOpen()) return;
  for (const [strategy, template] of exitTemplates()) {
    scheduleExitWorker(strategy, template, Date.now(), forceStartup ? "startup-recovery" : "discovery-round");
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
    stopReason = String(request.command);
    stopping = true;
    executionJournal.record("run.control-requested", { command: request.command, requestId: request.requestId });
    stamp(`RUNTIME_CONTROL_ACCEPTED command=${request.command} requestId=${request.requestId}`);
    await writeRuntimeState("stopping", stopReason);
    await unlink(runtimeControlPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      stamp(`RUNTIME_CONTROL_READ_FAILED error=${String(error)}`);
    }
  } finally {
    controlCheckRunning = false;
  }
}

function stop(): void {
  if (stopping) return;
  stopReason = "signal";
  stopping = true;
  executionJournal.record("run.signal-received", { signal: "SIGINT_OR_SIGTERM" });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (!readOnly) await requireWeeklyReauthorization();
await writeRuntimeState("running");
executionJournal.record("run.started", {
  readOnly,
  once,
  underlyings: [...policy.underlyings],
  strikeMin: policy.strikeMin,
  strikeMax: policy.strikeMax,
  executionWindow: `${policy.executionStart}-${policy.executionEnd}`,
  repeatBuyAtOrderPrice: policy.repeatBuyAtOrderPrice,
  buildId: process.env.SCHWAB_BOT_BUILD_ID ?? null,
});
stamp(readOnly ? "Node 直连 Schwab 只读启动" : `Node 直连 Schwab 启动 underlyings=${[...policy.underlyings].join(",")} strikes=${policy.strikeMin}-${policy.strikeMax} executionWindow=${policy.executionStart}-${policy.executionEnd} ET orderCooldown=${policy.orderCooldownMs}ms roundCooldown=${policy.roundCooldownMs}ms`);
if (!readOnly) stamp(policy.repeatBuyAtOrderPrice ? "FIXED_PRICE_CYCLE_ENABLED source=orderLimit exploration=disabled" : "PRICE_EXPLORER_FILL_PRICE_SOURCE source=actualNet");
await bootstrap();
await poll(true);
if (!once) {
  activityStream = new SchwabActivityStream({
    loadContext: loadActivityStreamContext,
    onActivity: handleAccountActivity,
    onState: stamp,
  });
  activityStream.start();
  if (!readOnly && !policy.repeatBuyAtOrderPrice) void explorerRoundLoop();
}
if (!readOnly) {
  await reconcilePositions();
  stamp("启动阶段：先处理全部可卖库存，再启动整体买单刷新");
  await evaluateExits(true);
  stamp("启动卖出评估已调度；成交监听、每策略卖单维护与整体刷新并行运行");
}
if (once) {
  stop();
} else {
  runtimeIntervals.push(setInterval(() => {
    const fallbackDue = Date.now() - lastFillPollAt >= 30_000;
    if (!activityStream?.ready || fallbackDue) void poll(false);
  }, 2_000));
  if (!policy.repeatBuyAtOrderPrice) runtimeIntervals.push(setInterval(() => void explorerTick(), 200));
  runtimeIntervals.push(setInterval(() => void evaluateExits(), policy.roundCooldownMs));
  runtimeIntervals.push(setInterval(() => void reconcileAll(), 110_000));
  runtimeIntervals.push(setInterval(() => void checkControlRequest(), 250));
}
while (!stopping) await wait(250);
for (const interval of runtimeIntervals) clearInterval(interval);
for (const { timer } of exitWorkerTimers.values()) clearTimeout(timer);
exitWorkerTimers.clear();
if (activityRestTimer) clearTimeout(activityRestTimer);
executionJournal.record("run.stopping", { reason: stopReason });
if (!readOnly) persistExplorer();
await activityStream?.stop();
await writer.waitIdle();
await explorerSavePending;
await fixedPriceCycleSavePending;
await exitTemplateSavePending;
await writeRuntimeState("stopped", stopReason);
executionJournal.record("run.stopped", { reason: stopReason });
await executionJournal.flush();
