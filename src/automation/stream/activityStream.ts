import type WebSocket from "ws";
import { StreamerClient } from "../../streamer/streamerClient.ts";
import type { StreamerDataPayload } from "../../types/streamer.ts";
import type { StreamerInfo } from "../../types/trader.ts";

export type StreamContext = {
  accessToken: string;
  socketUrl: string;
  customerId: string;
  correlationId: string;
  channel: string;
  functionId: string;
};

export type ActivityHint = {
  orderId: string;
  status: string;
  filledQuantity: number | null;
};

export type ActivityBatch = {
  hints: ActivityHint[];
  complete: boolean;
};

export type ActivityStreamOptions = {
  loadContext: () => Promise<StreamContext>;
  onActivity: (batch: ActivityBatch) => void;
  onState: (message: string) => void;
  createWebSocket?: (url: string, options: { handshakeTimeout: number; perMessageDeflate: boolean }) => WebSocket;
  openTimeoutMs?: number;
  ackTimeoutMs?: number;
  activityDebounceMs?: number;
  reconnectDelayMs?: number;
};

/**
 * Production account-activity adapter. StreamerClient owns socket lifecycle,
 * LOGIN/SUBS acknowledgements, canonical subscription state and reconnect replay.
 * This class retains only automation-specific batching and message interpretation.
 */
export class SchwabActivityStream {
  private readonly options: ActivityStreamOptions;
  private client: StreamerClient | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private subscribed = false;
  private activityTimer: NodeJS.Timeout | null = null;
  private queuedHints: ActivityHint[] = [];
  private queuedComplete = true;
  ready = false;

  constructor(options: ActivityStreamOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.starting) this.starting = this.startUntilConnected();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.subscribed = false;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    this.queuedHints = [];
    this.queuedComplete = true;
    this.client?.disconnect();
    await this.starting?.catch(() => undefined);
  }

  private async startUntilConnected(): Promise<void> {
    let delayMs = Math.max(1, this.options.reconnectDelayMs ?? 500);
    while (!this.stopping && !this.subscribed) {
      try {
        await this.connect();
        return;
      } catch (error) {
        this.ready = false;
        this.options.onState(`ACCT_ACTIVITY订阅断开 error=${safeError(error)} reconnectInMs=${delayMs}`);
        this.client?.disconnect();
        this.client = null;
        if (!this.stopping) await delay(delayMs);
        delayMs = Math.min(30_000, delayMs * 2);
      }
    }
  }

  private async connect(): Promise<void> {
    const context = await this.options.loadContext();
    const client = new StreamerClient({
      autoReconnect: true,
      reconnectDelayMs: this.options.reconnectDelayMs,
      commandAckTimeoutMs: this.options.ackTimeoutMs ?? 15_000,
      heartbeatCheckIntervalMs: 5_000,
      heartbeatTimeoutMs: 20_000,
      webSocketFactory: this.options.createWebSocket
        ? (url) => this.options.createWebSocket!(url, { handshakeTimeout: 15_000, perMessageDeflate: false })
        : undefined,
    });
    this.client = client;
    client.on("data", (payload) => this.onData(payload));
    client.on("close", (code) => {
      if (client !== this.client || this.stopping) return;
      this.ready = false;
      this.options.onState(`ACCT_ACTIVITY订阅断开 error=STREAM_CLOSED_${code}`);
    });
    client.on("reconnecting", ({ attempt, delayMs }) => {
      if (client !== this.client || this.stopping) return;
      this.options.onState(`ACCT_ACTIVITY准备重连 attempt=${attempt} reconnectInMs=${delayMs}`);
    });
    client.on("ready", () => {
      if (client === this.client && this.subscribed && !this.stopping) this.ready = true;
    });
    client.on("error", (error) => {
      if (client === this.client && !this.stopping) this.options.onState(`ACCT_ACTIVITY Streamer error=${safeError(error)}`);
    });
    const info: StreamerInfo = {
      streamerSocketUrl: context.socketUrl,
      schwabClientCustomerId: context.customerId,
      schwabClientCorrelId: context.correlationId,
      schwabClientChannel: context.channel,
      schwabClientFunctionId: context.functionId,
    };
    await client.connect(context.accessToken, info, async () => (await this.options.loadContext()).accessToken);
    if (client !== this.client || this.stopping) return;
    await client.subscribe({
      service: "ACCT_ACTIVITY",
      parameters: { keys: "Account Activity", fields: "0,1,2,3" },
    });
    if (client !== this.client || this.stopping) return;
    this.subscribed = true;
    this.ready = true;
    this.options.onState("ACCT_ACTIVITY WebSocket订阅已建立；账户活动将立即唤醒一次REST订单确认");
  }

  private onData(payload: StreamerDataPayload): void {
    if (payload.service !== "ACCT_ACTIVITY" || this.stopping) return;
    const batch = decodeActivityBatch(payload.content);
    this.queuedHints.push(...batch.hints);
    this.queuedComplete = this.queuedComplete && batch.complete;
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      const queued = { hints: this.queuedHints.splice(0), complete: this.queuedComplete };
      this.queuedComplete = true;
      if (!this.stopping) this.options.onActivity(queued);
    }, this.options.activityDebounceMs ?? 50);
  }
}

function decodeActivityBatch(rows: Array<Record<string, unknown> & { key?: string }>): ActivityBatch {
  const hints: ActivityHint[] = [];
  let messages = 0;
  for (const content of rows) {
    messages += 1;
    const message = content["3"] ?? content.messageData;
    const decoded = decodeMessageData(message);
    if (decoded) hints.push(decoded);
  }
  return { hints, complete: messages > 0 && hints.length === messages };
}

function decodeMessageData(message: unknown): ActivityHint | null {
  if (message && typeof message === "object") return decodeStructured(message as Record<string, unknown>);
  if (typeof message !== "string" || message.length > 200_000) return null;
  const trimmed = message.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        const decoded = decodeStructured(parsed as Record<string, unknown>);
        if (decoded) return decoded;
      }
    } catch {
      // Schwab account activity may use XML.
    }
  }
  const orderId = xmlValue(trimmed, ["OrderId", "OrderID", "OrderKey", "OrderNumber"]);
  const status = xmlValue(trimmed, ["OrderStatus", "Status"]);
  if (!orderId || !status) return null;
  const filled = xmlValue(trimmed, ["FilledQuantity", "QuantityFilled", "FilledQty", "CumulativeQuantity"]);
  const filledQuantity = filled === null ? null : Number(filled);
  return {
    orderId,
    status: status.toUpperCase().replaceAll(" ", "_"),
    filledQuantity: Number.isFinite(filledQuantity) ? filledQuantity : null,
  };
}

function decodeStructured(value: Record<string, unknown>): ActivityHint | null {
  const flattened = flattenObject(value);
  const orderId = firstString(flattened, ["orderid", "orderkey", "ordernumber"]);
  const status = firstString(flattened, ["orderstatus", "status"]);
  if (!orderId || !status) return null;
  const filled = firstString(flattened, ["filledquantity", "quantityfilled", "filledqty", "cumulativequantity"]);
  const filledQuantity = filled === null ? null : Number(filled);
  return {
    orderId,
    status: status.toUpperCase().replaceAll(" ", "_"),
    filledQuantity: Number.isFinite(filledQuantity) ? filledQuantity : null,
  };
}

function flattenObject(value: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (typeof child === "string" || typeof child === "number") result.set(normalized, String(child));
      else visit(child);
    }
  };
  visit(value);
  return result;
}

function firstString(values: Map<string, string>, names: string[]): string | null {
  for (const name of names) {
    const value = values.get(name);
    if (value) return value;
  }
  return null;
}

function xmlValue(source: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tag = source.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([^<]+)</${escaped}>`, "i"));
    if (tag?.[1]) return decodeXml(tag[1].trim());
    const attribute = source.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']+)["']`, "i"));
    if (attribute?.[1]) return decodeXml(attribute[1].trim());
  }
  return null;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Z0-9_=-]/gi, "_").slice(0, 120) || "UNKNOWN";
}
