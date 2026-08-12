import WebSocket, { type RawData } from "ws";

export type StreamContext = {
  accessToken: string;
  socketUrl: string;
  customerId: string;
  correlationId: string;
  channel: string;
  functionId: string;
};

export type ActivityStreamOptions = {
  loadContext: () => Promise<StreamContext>;
  onActivity: (batch: ActivityBatch) => void;
  onState: (message: string) => void;
  createWebSocket?: (url: string, options: {
    handshakeTimeout: number;
    perMessageDeflate: boolean;
  }) => WebSocket;
  openTimeoutMs?: number;
  ackTimeoutMs?: number;
  activityDebounceMs?: number;
  reconnectDelayMs?: number;
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

type PendingRequest = {
  service: string;
  command: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class SchwabActivityStream {
  private readonly options: ActivityStreamOptions;
  private socket: WebSocket | null = null;
  private stopping = false;
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private loop: Promise<void> | null = null;
  private activityQueued = false;
  private queuedHints: ActivityHint[] = [];
  private queuedComplete = true;
  private activityTimer: NodeJS.Timeout | null = null;
  ready = false;

  constructor(options: ActivityStreamOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.loop) this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    this.activityQueued = false;
    this.queuedHints = [];
    this.queuedComplete = true;
    this.rejectPending("STREAM_STOPPED");
    this.socket?.close(1000, "shutdown");
    await this.loop;
  }

  private async run(): Promise<void> {
    let backoffMs = 500;
    while (!this.stopping) {
      try {
        await this.connectOnce();
        backoffMs = 500;
      } catch (error) {
        if (!this.stopping) {
          this.options.onState(`ACCT_ACTIVITY订阅断开 error=${safeError(error)} reconnectInMs=${backoffMs}`);
          await delay(this.options.reconnectDelayMs ?? backoffMs);
          backoffMs = Math.min(30_000, backoffMs * 2);
        }
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const context = await this.options.loadContext();
    const socket = (this.options.createWebSocket ?? ((url, options) => new WebSocket(url, options)))
      (context.socketUrl, {
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on("message", (data) => this.onMessage(data));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("STREAM_OPEN_TIMEOUT")), this.options.openTimeoutMs ?? 15_000);
        socket.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      await this.request(context, "ADMIN", "LOGIN", {
        Authorization: context.accessToken,
        SchwabClientChannel: context.channel,
        SchwabClientFunctionId: context.functionId,
      });
      await this.request(context, "ACCT_ACTIVITY", "SUBS", {
        keys: "Account Activity",
        fields: "0,1,2,3",
      });

      this.ready = true;
      this.options.onState("ACCT_ACTIVITY WebSocket订阅已建立；账户活动将立即唤醒一次REST订单确认");

      await new Promise<void>((resolve, reject) => {
        socket.once("close", (code) => {
          if (this.stopping || code === 1000) resolve();
          else reject(new Error(`STREAM_CLOSED_${code}`));
        });
        socket.once("error", reject);
      });
    } finally {
      this.ready = false;
      this.rejectPending(this.stopping ? "STREAM_STOPPED" : "STREAM_CONNECTION_LOST");
      if (this.socket === socket) this.socket = null;
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  }

  private async request(
    context: StreamContext,
    service: string,
    command: string,
    parameters: Record<string, string>,
  ): Promise<void> {
    const requestid = String(++this.requestId);
    const frame = {
      requests: [{
        service,
        command,
        requestid,
        SchwabClientCustomerId: context.customerId,
        SchwabClientCorrelId: context.correlationId,
        parameters,
      }],
    };
    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestid);
        reject(new Error(`STREAM_ACK_TIMEOUT_${service}`));
      }, this.options.ackTimeoutMs ?? 15_000);
      this.pending.set(requestid, { service, command, resolve, reject, timer });
    });
    try {
      this.socket!.send(JSON.stringify(frame));
    } catch (error) {
      const pending = this.pending.get(requestid);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestid);
        pending.reject(new Error(`STREAM_SEND_FAILED_${service}_${safeError(error)}`));
      }
    }
    await acknowledgement;
  }

  private onMessage(raw: RawData): void {
    let frame: any;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    for (const response of Array.isArray(frame?.response) ? frame.response : []) {
      const requestid = String(response?.requestid ?? "");
      const pending = this.pending.get(requestid);
      if (!pending) continue;
      if (response?.service !== pending.service || response?.command !== pending.command) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestid);
      const code = responseCode(response?.content?.code);
      if (code !== null && isAcceptedResponse(String(response?.service ?? ""), String(response?.command ?? ""), code)) pending.resolve();
      else pending.reject(new Error(`STREAM_RESPONSE_${String(response?.service ?? "UNKNOWN")}_${code ?? "INVALID_CODE"}`));
    }
    const accountActivities = (Array.isArray(frame?.data) ? frame.data : [])
      .filter((entry: any) => entry?.service === "ACCT_ACTIVITY");
    if (accountActivities.length > 0) {
      const batch = decodeActivityBatch(accountActivities);
      this.queuedHints.push(...batch.hints);
      this.queuedComplete = this.queuedComplete && batch.complete;
      if (this.activityQueued) return;
      this.activityQueued = true;
      this.activityTimer = setTimeout(() => {
        this.activityTimer = null;
        this.activityQueued = false;
        const queued = {
          hints: this.queuedHints.splice(0),
          complete: this.queuedComplete,
        };
        this.queuedComplete = true;
        if (!this.stopping) this.options.onActivity(queued);
      }, this.options.activityDebounceMs ?? 50);
    }
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

function isAcceptedResponse(service: string, command: string, code: number): boolean {
  if (!Number.isInteger(code) || !Number.isFinite(code)) return false;
  if (code === 0) return true;
  if (service !== "ACCT_ACTIVITY") return false;
  switch (command) {
    case "SUBS": return code === 26;
    case "UNSUBS": return code === 27;
    case "ADD": return code === 28;
    case "VIEW": return code === 29;
    default: return false;
  }
}

function responseCode(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN";
  return error.message.replace(/[^A-Z0-9_=-]/gi, "_").slice(0, 120);
}

function decodeActivityBatch(entries: any[]): ActivityBatch {
  const hints: ActivityHint[] = [];
  let messages = 0;
  for (const entry of entries) {
    for (const content of Array.isArray(entry?.content) ? entry.content : []) {
      messages += 1;
      const message = content?.["3"] ?? content?.messageData;
      const decoded = decodeMessageData(message);
      if (decoded) hints.push(decoded);
    }
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
        const decoded = decodeStructured(parsed);
        if (decoded) return decoded;
      }
    } catch {
      // Some Schwab account activity messages are XML rather than JSON.
    }
  }
  const orderId = xmlValue(trimmed, ["OrderId", "OrderID", "OrderKey", "OrderNumber"]);
  const status = xmlValue(trimmed, ["OrderStatus", "Status"]);
  if (!orderId || !status) return null;
  const filled = xmlValue(trimmed, [
    "FilledQuantity", "QuantityFilled", "FilledQty", "CumulativeQuantity",
  ]);
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
  const filled = firstString(flattened, [
    "filledquantity", "quantityfilled", "filledqty", "cumulativequantity",
  ]);
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
