import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
import { completeNetDebitFill } from "./fill_price.ts";
import { MAX_ACTIVE_ORDERS, PriceExplorer, type ExplorerAction, type ExplorerSnapshot } from "./price_explorer.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const evidencePath = join(root, ".state", "send-evidence.jsonl");
const policyAlertPath = join(root, ".state", "policy-alerts.jsonl");
const explorerStatePath = join(root, ".state", "net-price-explorer.json");
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
let activityRestTimer: NodeJS.Timeout | null = null;
let activityRestRunning = false;
let lastIncompleteActivityAt = 0;
let lastActivityRestAt = 0;
let lastFillPollAt = 0;
const lastBuyFillAt = new Map<string, number>();
const inventoryByStrategy = new Map<string, number>();
const observedFillQuantities = new Map<string, number>();
let inventoryFillBaselineEstablished = false;
const unknownWrites = new Set<string>();
const sellDue = new Map<string, number>();
const sellSubmitDue = new Map<string, number>();
const cancelingSells = new Set<string>();
const previewRejectedUntil = new Map<string, number>();
const reportedPolicyAlerts = new Set<string>();
const explorer = await loadExplorer();
const explorerTemplates = new Map<string, Json>();
const reportedUnpricedFills = new Set<string>();
let explorerSavePending = Promise.resolve();
const normalExplorerActionPacer = new ExplorerActionPacer();

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
  if (info(payload)?.closing) sellDue.set(id, Date.now() + 5_000);
}

function applyLocalReplace(sourceId: string, payload: Json, replacementId: string): void {
  const source = orders.find((order) => orderId(order) === sourceId);
  if (source) source.status = "REPLACED";
  orders.push(localOrder(payload, replacementId));
  observedFillQuantities.set(replacementId, 0);
  if (info(payload)?.closing) sellDue.set(replacementId, Date.now() + 5_000);
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
  if (readOnly) return "READ_ONLY";
  const violation = orderPolicyViolation(payload, policy, newYorkDate());
  if (violation) {
    reportPolicyAlert("write-blocked", payload, violation.code, violation.message);
    throw new Error(`ORDER_POLICY_BLOCKED_${violation.code}`);
  }
  await requireWeeklyReauthorization();
  policy.requireExecutionWindow();
  const previewFingerprint = createHash("sha256")
    .update(`${path}\0${JSON.stringify(payload)}`)
    .digest("hex");
  if (priority > 1 && Date.now() < (previewRejectedUntil.get(previewFingerprint) ?? 0)) {
    throw new Error("CACHED_PREVIEW_REJECTED");
  }
  const preview = await api(
    `/trader/v1/accounts/${accountHash}/previewOrder`,
    { method: "POST", body: JSON.stringify(payload) },
    priority,
  );
  if (!previewAccepted(preview.body)) {
    if (priority > 1) previewRejectedUntil.set(previewFingerprint, Date.now() + 30_000);
    throw new Error(`SCHWAB_PREVIEW_REJECTED blockers=${previewBlockers(preview.body)}`);
  }
  previewRejectedUntil.delete(previewFingerprint);
  await evidence(key, method, path, payload);
  try {
    const result = await finalWriteGate.run(
      priority,
      async () => {
        await requireWeeklyReauthorization();
        policy.requireExecutionWindow();
        return api(path, { method, body: JSON.stringify(payload) }, 0);
      },
    );
    const brokerOrderId = result.headers.get("location")?.split("/").at(-1);
    if (!brokerOrderId) {
      unknownWrites.add(key);
      throw new Error("SCHWAB_WRITE_ACCEPTED_WITHOUT_LOCATION");
    }
    return brokerOrderId;
  } catch (error) {
    unknownWrites.add(key);
    throw error;
  }
}

async function cancelOrder(key: string, orderIdValue: string): Promise<void> {
  if (readOnly) return;
  await requireWeeklyReauthorization();
  policy.requireExecutionWindow();
  const path = `/trader/v1/accounts/${accountHash}/orders/${orderIdValue}`;
  await evidence(key, "DELETE", path, {});
  try {
    await finalWriteGate.run(2, async () => {
      await requireWeeklyReauthorization();
      policy.requireExecutionWindow();
      return api(path, { method: "DELETE" }, 2);
    });
    const source = orders.find((order) => orderId(order) === orderIdValue);
    if (source) source.status = "CANCELED";
  } catch (error) {
    unknownWrites.add(key);
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
      lastFullOrderPollAt = Date.now();
      reportWorkingOrderPolicyViolations();
      if (!readOnly && policy.isExecutionWindowOpen()) detectExplorerFills();
      reconcileExplorerSnapshot();
      stamp(`完整当前订单同步 orders=${orders.length}`);
    } else {
      const merged = new Map(orders.map((order) => [orderId(order), order]));
      for (const order of incoming) merged.set(orderId(order), order);
      orders = [...merged.values()];
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

function reconcileExplorerSnapshot(): void {
  const liveByGroup = new Map<string, Set<string>>();
  for (const order of orders) {
    const meta = managedOpening(order);
    if (!meta) continue;
    explorerTemplates.set(meta.key, order);
    if (!working.has(String(order.status))) continue;
    explorer.registerWorkingOrder(meta.key, orderId(order), Math.round(Number(order.price) * 100), eventTime(order));
    const ids = liveByGroup.get(meta.key) ?? new Set<string>();
    ids.add(orderId(order));
    liveByGroup.set(meta.key, ids);
  }
  for (const groupKey of explorer.groupKeys()) explorer.reconcileWorkingBrokerOrders(groupKey, liveByGroup.get(groupKey) ?? new Set());
  persistExplorer();
}

function queueExplorerActions(groupKey: string, actions: ExplorerAction[]): void {
  for (const action of actions) {
    writer.enqueue({
      key: `price-explorer:${groupKey}:${action.generation}:${action.dueAt}:${action.logicalId}:${action.kind}`,
      priority: 0,
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

async function executeExplorerAction(groupKey: string, action: ExplorerAction): Promise<void> {
  if (stopping || readOnly || !policy.isExecutionWindowOpen() || !explorer.isCurrentGeneration(groupKey, action.generation)) return;
  if (action.kind === "resolve-three") {
    const followups = explorer.resolveThree(groupKey, action.generation, Date.now());
    persistExplorer();
    queueExplorerActions(groupKey, followups);
    return;
  }
  if (action.binding === false) await normalExplorerActionPacer.admit();
  const complete = (): void => {
    explorer.acknowledge(groupKey, action);
    persistExplorer();
  };
  const logical = explorer.order(groupKey, action.logicalId);
  if (!logical || logical.filled) {
    complete();
    return;
  }
  const desiredPrice = action.priceCents === undefined ? logical.priceCents : explorer.setPrice(groupKey, logical.id, action.priceCents);
  const current = logical.brokerOrderId === null ? null : orders.find((order) => orderId(order) === logical.brokerOrderId && working.has(String(order.status)));
  if (current) {
    if (action.kind === "ensure" && Math.round(Number(current.price) * 100) === desiredPrice) {
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
    } finally {
      complete();
    }
    return;
  }
  if (logical.brokerOrderId !== null || action.kind === "refresh") {
    complete();
    return;
  }
  const template = explorerTemplates.get(groupKey);
  if (!template) {
    stamp(`PRICE_EXPLORER_TEMPLATE_MISSING group=${groupKey} logical=${logical.id}`);
    complete();
    return;
  }
  if (activeOpeningOrders(groupKey).length >= MAX_ACTIVE_ORDERS) {
    stamp(`PRICE_EXPLORER_SLOT_FULL group=${groupKey} logical=${logical.id} active=${MAX_ACTIVE_ORDERS}`);
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
  } finally {
    complete();
  }
}

function detectExplorerFills(): void {
  const now = Date.now();
  for (const order of orders) {
    const meta = managedOpening(order);
    if (!meta || order.status !== "FILLED") continue;
    const fill = completeNetDebitFill(order);
    if (!fill) {
      const id = orderId(order);
      if (!reportedUnpricedFills.has(id)) {
        reportedUnpricedFills.add(id);
        stamp(`PRICE_EXPLORER_FILL_PRICE_UNAVAILABLE order=${id}; no exploration action sent`);
      }
      continue;
    }
    if (fill.priceCents < policy.entryNotionalMin || fill.priceCents > policy.entryNotionalMax) {
      stamp(`PRICE_EXPLORER_FILL_PRICE_OUT_OF_RANGE order=${orderId(order)} actualPrice=${(fill.priceCents / 100).toFixed(2)}; no exploration action sent`);
      continue;
    }
    if (now - fill.filledAt > 10_000) continue;
    const transition = explorer.recordCompleteFill(meta.key, orderId(order), fill.priceCents, fill.filledAt);
    persistExplorer();
    if (transition.actions.length > 0) queueExplorerActions(meta.key, transition.actions);
    if (transition.triggered) {
      stamp(`PRICE_EXPLORER_PAIR group=${meta.key} actualPrice=${(fill.priceCents / 100).toFixed(2)} generation=${transition.generation}`);
    }
  }
}

async function explorerTick(): Promise<void> {
  if (stopping || readOnly || !policy.isExecutionWindowOpen()) return;
  for (const groupKey of explorer.groupKeys()) {
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
      if (explorer.hasPendingActions(groupKey)) continue;
      const actions = explorer.planRoundRecovery(groupKey, Date.now());
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
    if (meta.opening) lastBuyFillAt.set(meta.key, Date.now());
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
    if (!sellDue.has(orderId(order))) sellDue.set(orderId(order), Date.now());
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
  const templates = new Map<string, Json>();
  for (const order of orders) {
    const meta = info(order);
    if (
      !meta || meta.expiration !== newYorkDate()
      || !policy.underlyings.has(meta.underlying)
    ) continue;
    if (!templates.has(meta.key) || meta.opening) templates.set(meta.key, order);
  }
  for (const [strategy, template] of templates) {
    inventoryByStrategy.set(strategy, availableFor(template, current));
  }
  lastPositionReconciledAt = Date.now();
  if (announce) stamp(`订单与持仓完整对账完成 strategies=${templates.size}；后台仍保留 110s 兜底对账`);
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
    const observedFillAt = eventTime(order);
    if (observedFillAt > (lastBuyFillAt.get(meta.key) ?? 0)) lastBuyFillAt.set(meta.key, observedFillAt);
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
  return latest;
}

async function evaluateExitStrategy(strategy: string, template: Json, forceStartup: boolean): Promise<void> {
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
  if (forceStartup) {
    stamp(`启动独立卖出 worker strategy=${strategy} inventory=${inventory} activeSells=${active.length}`);
  }
  const unitSells = active.filter((order) => quantity(order) === 1 && remaining(order) === 1);
  if (unitSells.length !== active.length) {
    return;
  }
  for (const excess of unitSells.slice(inventory)) {
    const id = orderId(excess);
    if (cancelingSells.has(id)) continue;
    cancelingSells.add(id);
    writer.enqueue({
      key: `sell-cancel-excess:${id}`, priority: 2,
      run: async () => cancelOrder(`sell-cancel-excess:${id}`, id),
    });
  }
  for (const sell of unitSells.slice(0, inventory)) {
    const id = orderId(sell);
    const due = sellDue.get(id) ?? 0;
    if (Date.now() < due && Number(sell.price) === EXIT_ORDER_PRICE) continue;
    sellDue.set(id, Date.now() + 5_000);
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
  const deficit = Math.max(0, inventory - unitSells.length);
  if (deficit === 0) return;
  const nextSubmitAt = sellSubmitDue.get(strategy) ?? 0;
  if (Date.now() < nextSubmitAt) return;
  if (Date.now() - lastFullOrderPollAt >= 5_000 && !await ensureFreshOrdersForExit()) return;
  sellSubmitDue.set(strategy, Date.now() + 5_000);
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

function evaluateExits(forceStartup = false): void {
  if (stopping || readOnly || !policy.isExecutionWindowOpen()) return;
  for (const [strategy, template] of exitTemplates()) {
    if (evaluatingExitStrategies.has(strategy)) continue;
    evaluatingExitStrategies.add(strategy);
    void evaluateExitStrategy(strategy, template, forceStartup)
      .catch((error) => stamp(`独立卖出 worker 失败 strategy=${strategy} error=${String(error)}`))
      .finally(() => evaluatingExitStrategies.delete(strategy));
  }
}

let activityStream: SchwabActivityStream | null = null;

function stop(): void { stopping = true; }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (!readOnly) await requireWeeklyReauthorization();
stamp(readOnly ? "Node 直连 Schwab 只读启动" : `Node 直连 Schwab 启动 underlyings=${[...policy.underlyings].join(",")} strikes=${policy.strikeMin}-${policy.strikeMax} executionWindow=${policy.executionStart}-${policy.executionEnd} ET orderCooldown=${policy.orderCooldownMs}ms roundCooldown=${policy.roundCooldownMs}ms`);
await bootstrap();
await poll(true);
if (!once) {
  activityStream = new SchwabActivityStream({
    loadContext: loadActivityStreamContext,
    onActivity: handleAccountActivity,
    onState: stamp,
  });
  activityStream.start();
  if (!readOnly) void explorerRoundLoop();
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
  setInterval(() => {
    const fallbackDue = Date.now() - lastFillPollAt >= 30_000;
    if (!activityStream?.ready || fallbackDue) void poll(false);
  }, 2_000);
  setInterval(() => void explorerTick(), 200);
  setInterval(() => void evaluateExits(), 500);
  setInterval(() => void reconcileAll(), 110_000);
}
while (!stopping) await wait(250);
await activityStream?.stop();
