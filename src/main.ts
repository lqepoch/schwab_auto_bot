import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { SchwabActivityStream, type ActivityBatch } from "./activity_stream.ts";
import { SchwabTokenProvider } from "./auth.ts";
import { PriorityGate, PriorityWriter, type Priority } from "./priority_runtime.ts";
import { SchwabRestClient } from "./schwab_client.ts";
import { SchwabApiError } from "../vendor/schwab-api-nodejs/src/utils/errors.ts";
type Json = Record<string, any>;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const evidencePath = join(root, ".state", "send-evidence.jsonl");
const working = new Set(["PENDING_ACTIVATION", "QUEUED", "WORKING", "PARTIALLY_FILLED", "AWAITING_PARENT_ORDER"]);
const readOnly = process.argv.includes("--read-only");
const once = process.argv.includes("--once");
const confirmIndex = process.argv.indexOf("--confirm-live");
const confirmedLive = confirmIndex >= 0 && process.argv[confirmIndex + 1] === "I_UNDERSTAND";
if (!readOnly && !confirmedLive) {
  throw new Error("真实写入必须显式传入 --confirm-live I_UNDERSTAND");
}

function stamp(message: string): void {
  const value = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Singapore", dateStyle: "short", timeStyle: "medium", hour12: false,
  }).format(new Date());
  process.stderr.write(`${value} [node-vertical] ${message}\n`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
const startedAt = Date.now();
let fillWatchEstablished = false;
const handledFills = new Set<string>();
const watchedBuyFills = new Map<string, number>();
const lastBuyFillAt = new Map<string, number>();
const inventoryByStrategy = new Map<string, number>();
const observedFillQuantities = new Map<string, number>();
let inventoryFillBaselineEstablished = false;
const unknownWrites = new Set<string>();
const sellDue = new Map<string, number>();
const sellSubmitDue = new Map<string, number>();
const sellRefreshFailures = new Map<string, number>();
const cancelingSells = new Set<string>();
const previewRejectedUntil = new Map<string, number>();

function flatten(source: any[]): Json[] {
  const output: Json[] = [];
  const visit = (order: Json): void => {
    output.push(order);
    for (const child of order.childOrderStrategies ?? []) visit(child);
  };
  for (const order of source) visit(order);
  return output;
}

function parseOcc(symbol: string): Json | null {
  const match = symbol.trim().match(/^([A-Z.\-]{1,6})\s*(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, underlying, ymd, right, rawStrike] = match;
  return {
    underlying,
    expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    right,
    strike: Number(rawStrike) / 1_000,
  };
}

function info(order: Json): Json | null {
  const legs = order.orderLegCollection;
  if (!Array.isArray(legs) || legs.length !== 2) return null;
  const parsed = legs.map((leg: Json) => parseOcc(String(leg.instrument?.symbol ?? "")));
  if (parsed.some((value: Json | null) => value === null)) return null;
  if (parsed[0].underlying !== parsed[1].underlying || parsed[0].expiration !== parsed[1].expiration) return null;
  const instructions = legs.map((leg: Json) => String(leg.instruction ?? ""));
  const opening = instructions.every((value: string) => value.endsWith("_TO_OPEN"));
  const closing = instructions.every((value: string) => value.endsWith("_TO_CLOSE"));
  if (!opening && !closing) return null;
  const strikes = parsed.map((value: Json) => value.strike).sort((a: number, b: number) => a - b);
  return {
    key: `${parsed[0].underlying}:${parsed[0].expiration}:${parsed[0].right}:${strikes[0]}:${strikes[1]}`,
    underlying: parsed[0].underlying,
    expiration: parsed[0].expiration,
    lowerStrike: strikes[0],
    higherStrike: strikes[1],
    opening,
    closing,
    legs,
  };
}

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

function payloadFrom(order: Json, requestedQuantity = quantity(order), closing = false): Json {
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
    price: closing ? "0.99" : String(order.price),
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

async function writeOrder(key: string, method: "POST" | "PUT", path: string, payload: Json, priority: Priority): Promise<string> {
  if (readOnly) return "READ_ONLY";
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
      () => api(path, { method, body: JSON.stringify(payload) }, 0),
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
  const path = `/trader/v1/accounts/${accountHash}/orders/${orderIdValue}`;
  await evidence(key, "DELETE", path, {});
  try {
    await finalWriteGate.run(2, () => api(path, { method: "DELETE" }, 2));
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
      stamp(`完整当前订单同步 orders=${orders.length}`);
    } else {
      const merged = new Map(orders.map((order) => [orderId(order), order]));
      for (const order of incoming) merged.set(orderId(order), order);
      orders = [...merged.values()];
      stamp(`轻量成交同步 fills=${incoming.length}`);
    }
    if (!readOnly) {
      trackInventoryFillDeltas();
      detectFills();
      adoptSells();
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

function trackInventoryFillDeltas(): void {
  const today = newYorkDate();
  for (const order of orders) {
    const meta = info(order);
    if (!meta || meta.expiration !== today || !["QQQ", "SPY"].includes(meta.underlying)) continue;
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

function detectFills(): void {
  const today = newYorkDate();
  let watchedAtStartup = 0;
  for (const order of orders) {
    const meta = info(order);
    const id = orderId(order);
    const notional = Number(order.price) * quantity(order) * 100;
    const eligible = Boolean(
      meta?.opening && ["QQQ", "SPY"].includes(meta.underlying)
      && meta.expiration === today
      && quantity(order) <= 1 && notional >= 84 && notional <= 92
    );
    if (!eligible) continue;
    const filled = Number(order.filledQuantity ?? 0);
    if (!fillWatchEstablished) {
      if (working.has(String(order.status))) {
        watchedBuyFills.set(id, filled);
        watchedAtStartup += 1;
      }
      continue;
    }
    const previous = watchedBuyFills.get(id);
    const createdAfterStartup = Date.parse(order.enteredTime ?? 0) >= startedAt;
    const transitionedToFill = previous !== undefined && filled > previous;
    const instantlyFilledNewOrder = previous === undefined && createdAfterStartup && order.status === "FILLED";
    if ((transitionedToFill || instantlyFilledNewOrder) && !handledFills.has(id)) {
      lastBuyFillAt.set(meta.key, Date.now());
      writer.enqueue({ key: `buy:${id}`, priority: 0, run: () => replenish(order, meta) });
    }
    if (working.has(String(order.status))) watchedBuyFills.set(id, filled);
    else if (previous !== undefined) watchedBuyFills.delete(id);
  }
  if (!fillWatchEstablished) {
    fillWatchEstablished = true;
    stamp(`当前活动买单认领完成 watchedWorkingBuys=${watchedAtStartup}；历史成交未读取为补买事件`);
  }
}

async function replenish(source: Json, meta: Json): Promise<void> {
  const id = orderId(source);
  const same = orders.filter((order) => {
    const candidate = info(order);
    return working.has(String(order.status)) && candidate?.opening && candidate.key === meta.key
      && Number(order.price) === Number(source.price);
  }).sort((a, b) => eventTime(a) - eventTime(b));
  const activeQuantity = same.reduce((sum, order) => sum + remaining(order), 0);
  if (activeQuantity >= 3 && same[0]) {
    const target = same[0];
    const key = `buy-capacity-refresh:${id}:${orderId(target)}`;
    if (unknownWrites.has(key)) return;
    const payload = payloadFrom(target);
    const replacement = await writeOrder(
      key, "PUT",
      `/trader/v1/accounts/${accountHash}/orders/${orderId(target)}`,
      payload, 0,
    );
    applyLocalReplace(orderId(target), payload, replacement);
    handledFills.add(id);
    stamp(`成交补买容量已满，刷新最旧买单 strategy=${meta.key} source=${id} replacement=${replacement}`);
    return;
  }
  const key = `buy-submit:${id}`;
  if (unknownWrites.has(key)) return;
  const payload = payloadFrom(source, 1);
  const replacement = await writeOrder(
    key, "POST", `/trader/v1/accounts/${accountHash}/orders`, payload, 0,
  );
  applyLocalSubmit(payload, replacement);
  handledFills.add(id);
  stamp(`成交后立即补买 strategy=${meta.key} source=${id} newOrder=${replacement}`);
  void maintainReplenishmentOrder(replacement, payload, meta.key);
}
async function maintainReplenishmentOrder(
  initialOrderId: string,
  payload: Json,
  strategy: string,
): Promise<void> {
  let currentOrderId = initialOrderId;
  await wait(3_000);
  currentOrderId = await refreshReplenishmentStage(
    currentOrderId, payload, strategy, "3s",
  ) ?? "";
  if (!currentOrderId || stopping) return;
  await wait(5_000);
  await refreshReplenishmentStage(currentOrderId, payload, strategy, "3s+5s");
}
async function refreshReplenishmentStage(
  currentOrderId: string,
  payload: Json,
  strategy: string,
  stage: string,
): Promise<string | null> {
  const observed = orders.find((order) => orderId(order) === currentOrderId);
  if (!observed || !working.has(String(observed.status))) {
    stamp(
      `补买定时刷新跳过 stage=${stage} strategy=${strategy} order=${currentOrderId} `
      + `observedStatus=${String(observed?.status ?? "MISSING")}；未发送REST`,
    );
    return null;
  }
  let nextOrderId = currentOrderId;
  await writer.enqueueAndWait({
    key: `buy-followup-refresh:${stage}:${currentOrderId}`,
    priority: 1,
    run: async () => {
      const latest = orders.find((order) => orderId(order) === currentOrderId);
      if (!latest || !working.has(String(latest.status))) {
        nextOrderId = "";
        stamp(
          `补买定时刷新在写入前跳过 stage=${stage} strategy=${strategy} order=${currentOrderId} `
          + `observedStatus=${String(latest?.status ?? "MISSING")}；未发送REST`,
        );
        return;
      }
      try {
        const replacement = await writeOrder(
          `buy-followup-refresh:${stage}:${currentOrderId}:${Date.now()}`,
          "PUT",
          `/trader/v1/accounts/${accountHash}/orders/${currentOrderId}`,
          payload,
          1,
        );
        applyLocalReplace(currentOrderId, payload, replacement);
        nextOrderId = replacement;
        stamp(
          `补买定时刷新完成 stage=${stage} strategy=${strategy} `
          + `source=${currentOrderId} replacement=${replacement}`,
        );
      } catch (error) {
        stamp(
          `补买定时刷新未完成 stage=${stage} strategy=${strategy} `
          + `order=${currentOrderId} error=${String(error)}`,
        );
      }
    },
  });
  return nextOrderId || null;
}

function adoptSells(): void {
  const active = new Set<string>();
  for (const order of orders) {
    const meta = info(order);
    if (!meta?.closing || !working.has(String(order.status))) continue;
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
      || !["QQQ", "SPY"].includes(meta.underlying)
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
      || !["QQQ", "SPY"].includes(meta.underlying)
      || meta.expiration !== newYorkDate()
    ) continue;
    const previous = latest.get(meta.key);
    if (!previous || eventTime(order) > eventTime(previous)) latest.set(meta.key, order);
    const observedFillAt = eventTime(order);
    if (observedFillAt > (lastBuyFillAt.get(meta.key) ?? 0)) lastBuyFillAt.set(meta.key, observedFillAt);
  }
  for (const order of orders) {
    const meta = info(order);
    if (meta?.closing && working.has(String(order.status)) && !latest.has(meta.key)) {
      latest.set(meta.key, order);
    }
  }
  for (const order of orders) {
    const meta = info(order);
    if (
      meta?.opening && meta.expiration === newYorkDate()
      && ["QQQ", "SPY"].includes(meta.underlying)
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
    return working.has(String(order.status)) && meta?.closing && meta.key === strategy;
  }).sort((a, b) => remaining(b) - remaining(a) || eventTime(a) - eventTime(b));
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
          sellRefreshFailures.delete(staleId);
          stamp(`库存为零，残留卖单已取消 strategy=${strategy} order=${staleId}`);
        },
      });
    }
    return;
  }
  if (forceStartup) {
    stamp(`启动独立卖出 worker strategy=${strategy} inventory=${inventory} activeSells=${active.length}`);
  }
  if (active[0]) {
    sellSubmitDue.delete(strategy);
    for (const duplicate of active.slice(1)) {
      const duplicateId = orderId(duplicate);
      if (cancelingSells.has(duplicateId)) continue;
      cancelingSells.add(duplicateId);
      writer.enqueue({
        key: `sell-cancel-duplicate:${duplicateId}`,
        priority: 2,
        run: async () => {
          await cancelOrder(`sell-cancel-duplicate:${duplicateId}`, duplicateId);
          stamp(`重复卖单已取消 strategy=${strategy} order=${duplicateId}`);
        },
      });
    }
    const sell = active[0];
    const due = sellDue.get(orderId(sell)) ?? 0;
    if (Date.now() < due && remaining(sell) === inventory && Number(sell.price) === 0.99) return;
    sellDue.set(orderId(sell), Date.now() + 5_000);
    writer.enqueue({
      key: `sell-refresh:${orderId(sell)}`, priority: 2,
      run: async () => {
        const liveInventory = inventoryByStrategy.get(strategy) ?? 0;
        const liveSell = orders.find((order) => orderId(order) === orderId(sell));
        if (liveInventory <= 0 || !liveSell || !working.has(String(liveSell.status))) return;
        const payload = payloadFrom(template, liveInventory, true);
        try {
          const replacement = await writeOrder(
            `sell-refresh:${orderId(sell)}:${Date.now()}`, "PUT",
            `/trader/v1/accounts/${accountHash}/orders/${orderId(sell)}`,
            payload, 2,
          );
          sellRefreshFailures.delete(orderId(sell));
          applyLocalReplace(orderId(sell), payload, replacement);
          stamp(`卖单 Replace strategy=${strategy} quantity=${liveInventory} replacement=${replacement}`);
        } catch (error) {
          const failures = (sellRefreshFailures.get(orderId(sell)) ?? 0) + 1;
          sellRefreshFailures.set(orderId(sell), failures);
          const previewRejected = String(error).includes("SCHWAB_PREVIEW_REJECTED");
          if (previewRejected || (remaining(liveSell) !== liveInventory && failures >= 3)) {
            stamp(
              `卖单 Replace Preview 无法计入旧单占用，取消旧单后按最新库存重建 strategy=${strategy} `
              + `order=${orderId(sell)} oldQuantity=${remaining(liveSell)} inventory=${liveInventory}`,
            );
            await cancelOrder(`sell-rebuild-cancel:${orderId(sell)}`, orderId(sell));
            sellDue.delete(orderId(sell));
            sellRefreshFailures.delete(orderId(sell));
            return;
          }
          throw error;
        }
      },
    });
    return;
  }
  const mostRecentObservedBuyFill = lastBuyFillAt.get(strategy) ?? 0;
  if (inventory < 5 && Date.now() - mostRecentObservedBuyFill < 30_000) return;
  const nextSubmitAt = sellSubmitDue.get(strategy) ?? 0;
  if (Date.now() < nextSubmitAt) return;
  if (Date.now() - lastFullOrderPollAt >= 5_000 && !await ensureFreshOrdersForExit()) return;
  sellSubmitDue.set(strategy, Date.now() + 5_000);
  writer.enqueue({
    key: `sell-submit:${strategy}`, priority: 2,
    run: async () => {
      const liveInventory = inventoryByStrategy.get(strategy) ?? 0;
      if (liveInventory <= 0) return;
      const payload = payloadFrom(template, liveInventory, true);
      const newId = await writeOrder(
        `sell-submit:${strategy}:${Date.now()}`, "POST",
        `/trader/v1/accounts/${accountHash}/orders`,
        payload, 2,
      );
      applyLocalSubmit(payload, newId);
      stamp(`自动卖出 strategy=${strategy} quantity=${liveInventory} newOrder=${newId}`);
    },
  });
}

function evaluateExits(forceStartup = false): void {
  if (stopping || readOnly) return;
  for (const [strategy, template] of exitTemplates()) {
    if (evaluatingExitStrategies.has(strategy)) continue;
    evaluatingExitStrategies.add(strategy);
    void evaluateExitStrategy(strategy, template, forceStartup)
      .catch((error) => stamp(`独立卖出 worker 失败 strategy=${strategy} error=${String(error)}`))
      .finally(() => evaluatingExitStrategies.delete(strategy));
  }
}

async function refreshRoundLoop(): Promise<void> {
  while (!stopping && !readOnly) {
    while (polling && !stopping) await wait(50);
    if (stopping) return;
    const snapshotReady = Date.now() - lastFullOrderPollAt < 5_000 || await poll(true, 0);
    if (!snapshotReady) {
      stamp("整体刷新开轮快照未取得；本轮跳过，5s 后重试");
      await wait(5_000);
      continue;
    }
    const candidates = [...orders].filter((order) => {
      const meta = info(order);
      return working.has(String(order.status)) && meta?.opening && meta.underlying === "SPY"
        && meta.expiration === newYorkDate()
        && meta.lowerStrike >= 755 && meta.higherStrike <= 795
        && remaining(order) <= 1 && Number(order.price) * 100 <= 100;
    });
    stamp(`整体刷新轮次启动 candidates=${candidates.length}；本轮仅此一次完整订单GET，逐单失败直接跳过`);
    const roundJobs: Promise<void>[] = [];
    for (const candidate of candidates) {
      if (stopping) return;
      const id = orderId(candidate);
      roundJobs.push(writer.enqueueAndWait({
        key: `overall-refresh:${id}`,
        priority: 3,
        run: async () => {
          const latest = orders.find((order) => orderId(order) === id);
          if (!latest || !working.has(String(latest.status))) return;
          const payload = payloadFrom(latest);
          const replacement = await writeOrder(
            `overall-refresh:${id}:${randomUUID()}`,
            "PUT",
            `/trader/v1/accounts/${accountHash}/orders/${id}`,
            payload,
            3,
          );
          applyLocalReplace(id, payload, replacement);
          stamp(`整体刷新 order=${id} replacement=${replacement}`);
        },
      }));
      await wait(1_000);
    }
    await Promise.all(roundJobs);
    stamp("整体刷新轮次完成；等待 10s 后开始下一轮");
    await wait(10_000);
  }
}

let activityStream: SchwabActivityStream | null = null;

function stop(): void { stopping = true; }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

stamp(readOnly ? "Node 直连 Schwab 只读启动" : "Node 直连 Schwab 启动：成交补买 > 自动卖出；整体刷新独立持续");
await bootstrap();
await poll(true);
if (!once) {
  activityStream = new SchwabActivityStream({
    loadContext: loadActivityStreamContext,
    onActivity: handleAccountActivity,
    onState: stamp,
  });
  activityStream.start();
  if (!readOnly) void refreshRoundLoop();
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
  setInterval(() => void evaluateExits(), 500);
  setInterval(() => void reconcileAll(), 110_000);
}
while (!stopping) await wait(250);
await activityStream?.stop();
