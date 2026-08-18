import type {
  UnknownWriteFailure,
  UnknownWriteOperation,
  UnknownWriteRecord,
} from "../state/unknownWriteReconciliation.ts";

export type BrokerWriteMethod = "POST" | "PUT" | "DELETE";
export type BrokerWritePriority = 0 | 1 | 2 | 3;

export type BrokerWriteResponse = Readonly<{
  status: number;
  headers: Headers | Readonly<Record<string, string | undefined>>;
}>;

export type BrokerWriteRequest = Readonly<{
  key: string;
  method: BrokerWriteMethod;
  operation: UnknownWriteOperation;
  path: string;
  payload?: unknown;
  baselineOrderIds?: readonly string[] | (() => readonly string[]);
  targetOrderId?: string;
  targetOrder?: Record<string, unknown> | (() => Record<string, unknown> | undefined);
  validateFinal?: () => void | Promise<void>;
  priority?: BrokerWritePriority;
  /** Optional request-budget priority; final mutation writes may use a
   * different priority from the local gate queue. */
  transportPriority?: BrokerWritePriority;
}>;

export type BrokerWriteResult = Readonly<{
  status: number;
  orderId: string | null;
  response: BrokerWriteResponse;
}>;

export interface BrokerWriteLedger {
  beginWrite(failure: UnknownWriteFailure): Promise<UnknownWriteRecord>;
  completeWrite(id: string): Promise<void>;
  /** Remove an intent that is durably known to have never reached transport. */
  discardWrite(id: string): Promise<void>;
  settleWrite(
    id: string,
    outcome: Pick<UnknownWriteFailure, "status" | "reason">,
  ): Promise<UnknownWriteRecord | null>;
}

export interface BrokerWriteTransport {
  send(request: BrokerWriteRequest): Promise<BrokerWriteResponse>;
}

export interface BrokerWriteGate {
  run<T>(priority: BrokerWritePriority, operation: () => Promise<T>): Promise<T>;
}

export type BrokerWriteGuards = Readonly<{
  assertReady: (request: BrokerWriteRequest) => void | Promise<void>;
  beforeFinalWrite?: (request: BrokerWriteRequest) => void | Promise<void>;
  /**
   * Re-check non-blocking runtime invariants after WAL fsync and immediately
   * before transport. The current intent is supplied so callers can exclude it
   * from their own unknown-write blocker while still rejecting every other
   * unresolved intent.
   */
  beforeTransportSend?: (
    request: BrokerWriteRequest,
    intent: UnknownWriteRecord,
  ) => void | Promise<void>;
  isStopping?: () => boolean;
  isReadOnly?: () => boolean;
  onPersistenceFault?: (error: unknown) => void;
}>;

export type BrokerWriteEvent = Readonly<{
  event:
    | "blocked"
    | "intent-persisted"
    | "accepted"
    | "rejected"
    | "unknown"
    | "persistence-fault";
  request: BrokerWriteRequest;
  status?: number;
  ledgerId?: string;
  reason?: string;
}>;

export type BrokerWriteCoordinatorOptions = Readonly<{
  ledger: BrokerWriteLedger;
  transport: BrokerWriteTransport;
  guards: BrokerWriteGuards;
  gate?: BrokerWriteGate;
  now?: () => string;
  emit?: (event: BrokerWriteEvent) => void;
}>;

export class BrokerWriteError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly method: BrokerWriteMethod;
  readonly operation: UnknownWriteOperation;
  readonly path: string;
  readonly key: string;

  constructor(
    code: string,
    request: BrokerWriteRequest,
    message: string,
    status: number | null = null,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.method = request.method;
    this.operation = request.operation;
    this.path = request.path;
    this.key = request.key;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      method: this.method,
      operation: this.operation,
      key: this.key,
      path: redactPath(this.path),
    };
  }
}

export class BrokerWriteRejectedError extends BrokerWriteError {
  constructor(request: BrokerWriteRequest, status: number) {
    super(
      "BROKER_WRITE_REJECTED",
      request,
      `Broker rejected ${request.method} ${request.path} with HTTP ${status}`,
      status,
    );
  }
}

export class UnknownOutcomeError extends BrokerWriteError {
  readonly ledgerId: string;

  constructor(
    request: BrokerWriteRequest,
    ledgerId: string,
    reason: string,
    status: number | null = null,
    cause?: unknown,
  ) {
    super(
      "BROKER_WRITE_UNKNOWN_OUTCOME",
      request,
      `Broker write outcome is unknown (${reason})`,
      status,
      cause === undefined ? {} : { cause },
    );
    this.ledgerId = ledgerId;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), ledgerId: this.ledgerId, outcome: "UNKNOWN" };
  }
}

export class BrokerWritePersistenceError extends BrokerWriteError {
  constructor(request: BrokerWriteRequest, cause: unknown) {
    super(
      "BROKER_WRITE_PERSISTENCE_FAILED",
      request,
      "Unknown-write state persistence failed; broker writes are blocked",
      null,
      { cause },
    );
  }
}

export class BrokerWriteStoppingError extends BrokerWriteError {
  constructor(request: BrokerWriteRequest) {
    super("RUNTIME_STOPPING", request, "Runtime is stopping");
  }
}

export class BrokerWriteCoordinator {
  private readonly ledger: BrokerWriteLedger;
  private readonly transport: BrokerWriteTransport;
  private readonly guards: BrokerWriteGuards;
  private readonly gate: BrokerWriteGate;
  private readonly now: () => string;
  private readonly emit?: (event: BrokerWriteEvent) => void;

  constructor(options: BrokerWriteCoordinatorOptions) {
    this.ledger = options.ledger;
    this.transport = options.transport;
    this.guards = options.guards;
    this.gate = options.gate ?? new SerialBrokerWriteGate();
    this.now = options.now ?? (() => new Date().toISOString());
    this.emit = options.emit;
  }

  async execute(request: BrokerWriteRequest): Promise<BrokerWriteResult> {
    if (this.guards.isReadOnly?.()) {
      return {
        status: 0,
        orderId: null,
        response: { status: 0, headers: new Headers() },
      };
    }
    const priority = request.priority ?? 0;
    return this.gate.run(priority, async () => this.executeInGate(request));
  }

  private async executeInGate(request: BrokerWriteRequest): Promise<BrokerWriteResult> {
    if (this.guards.isStopping?.()) {
      this.emitEvent({ event: "blocked", request, reason: "runtime-stopping" });
      throw new BrokerWriteStoppingError(request);
    }
    try {
      await this.guards.beforeFinalWrite?.(request);
      await request.validateFinal?.();
      await this.guards.assertReady(request);
    } catch (error) {
      this.emitEvent({ event: "blocked", request, reason: String(error) });
      throw error;
    }
    if (this.guards.isStopping?.()) {
      this.emitEvent({ event: "blocked", request, reason: "runtime-stopping" });
      throw new BrokerWriteStoppingError(request);
    }

    const intent = await this.persistIntent(request);
    this.emitEvent({ event: "intent-persisted", request, ledgerId: intent.id });

    try {
      if (this.guards.isStopping?.()) throw new BrokerWriteStoppingError(request);
      await this.guards.beforeTransportSend?.(request, intent);
      // Request-specific validation is intentionally repeated after WAL fsync:
      // broker/order state may change while the durable intent is being written.
      await request.validateFinal?.();
      if (this.guards.isStopping?.()) throw new BrokerWriteStoppingError(request);
    } catch (error) {
      await this.discardIntentBeforeSend(request, intent.id);
      this.emitEvent({ event: "blocked", request, ledgerId: intent.id, reason: String(error) });
      throw error;
    }

    let response: BrokerWriteResponse;
    try {
      // This is deliberately the only transport invocation in this primitive.
      // Retry policy belongs outside this coordinator and must not replay a
      // mutation after WAL persistence has succeeded.
      response = await this.transport.send(request);
    } catch (error) {
      const status = statusOf(error);
      const reason = reasonOf(error, status);
      if (status !== null && isExplicitRejection(status)) {
        await this.clearIntent(request, intent.id, status, "explicit-4xx");
        this.emitEvent({ event: "rejected", request, ledgerId: intent.id, status });
        throw new BrokerWriteRejectedError(request, status);
      }
      await this.persistUnknown(request, intent.id, status, reason);
      this.emitEvent({ event: "unknown", request, ledgerId: intent.id, status: status ?? undefined, reason });
      throw new UnknownOutcomeError(request, intent.id, reason, status, error);
    }

    if (isExplicitRejection(response.status)) {
      await this.clearIntent(request, intent.id, response.status, "explicit-4xx");
      this.emitEvent({ event: "rejected", request, ledgerId: intent.id, status: response.status });
      throw new BrokerWriteRejectedError(request, response.status);
    }

    if (response.status < 200 || response.status >= 300) {
      const reason = response.status >= 500 ? "server-error" : "unknown-error";
      await this.persistUnknown(request, intent.id, response.status, reason);
      this.emitEvent({ event: "unknown", request, ledgerId: intent.id, status: response.status, reason });
      throw new UnknownOutcomeError(request, intent.id, reason, response.status);
    }

    if (request.method === "DELETE") {
      await this.completeIntent(request, intent.id);
      this.emitEvent({ event: "accepted", request, ledgerId: intent.id, status: response.status });
      return { status: response.status, orderId: null, response };
    }

    const brokerOrderId = locationOrderId(response.headers);
    if (!brokerOrderId) {
      await this.persistUnknown(request, intent.id, response.status, "missing-location");
      this.emitEvent({ event: "unknown", request, ledgerId: intent.id, status: response.status, reason: "missing-location" });
      throw new UnknownOutcomeError(request, intent.id, "missing-location", response.status);
    }
    await this.completeIntent(request, intent.id);
    this.emitEvent({ event: "accepted", request, ledgerId: intent.id, status: response.status });
    return { status: response.status, orderId: brokerOrderId, response };
  }

  private async persistIntent(request: BrokerWriteRequest): Promise<UnknownWriteRecord> {
    try {
      const baseline = typeof request.baselineOrderIds === "function"
        ? request.baselineOrderIds()
        : request.baselineOrderIds ?? [];
      const targetOrder = typeof request.targetOrder === "function"
        ? request.targetOrder()
        : request.targetOrder;
      const record = await this.ledger.beginWrite({
        operation: request.operation,
        method: request.method,
        key: request.key,
        path: request.path,
        payload: request.payload,
        baselineOrderIds: baseline,
        targetOrderId: request.targetOrderId,
        targetOrder,
        preSendAt: this.now(),
      });
      return record;
    } catch (error) {
      this.markPersistenceFault(error, request);
      throw new BrokerWritePersistenceError(request, error);
    }
  }

  private async completeIntent(request: BrokerWriteRequest, id: string): Promise<void> {
    try {
      await this.ledger.completeWrite(id);
    } catch (error) {
      this.markPersistenceFault(error, request);
      throw new BrokerWritePersistenceError(request, error);
    }
  }

  private async discardIntentBeforeSend(request: BrokerWriteRequest, id: string): Promise<void> {
    try {
      await this.ledger.discardWrite(id);
    } catch (error) {
      this.markPersistenceFault(error, request);
      throw new BrokerWritePersistenceError(request, error);
    }
  }

  private async clearIntent(
    request: BrokerWriteRequest,
    id: string,
    status: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.ledger.settleWrite(id, { status, reason });
    } catch (error) {
      this.markPersistenceFault(error, request);
      throw new BrokerWritePersistenceError(request, error);
    }
  }

  private async persistUnknown(
    request: BrokerWriteRequest,
    id: string,
    status: number | null,
    reason: string,
  ): Promise<void> {
    try {
      await this.ledger.settleWrite(id, { status: status ?? undefined, reason });
    } catch (error) {
      this.markPersistenceFault(error, request);
      throw new BrokerWritePersistenceError(request, error);
    }
  }

  private markPersistenceFault(error: unknown, request: BrokerWriteRequest): void {
    this.guards.onPersistenceFault?.(error);
    this.emitEvent({ event: "persistence-fault", request, reason: String(error) });
  }

  private emitEvent(event: BrokerWriteEvent): void {
    try {
      this.emit?.(event);
    } catch {
      // Observability must never alter the write outcome or cause a replay.
    }
  }
}

export class SerialBrokerWriteGate implements BrokerWriteGate {
  private tail: Promise<void> = Promise.resolve();

  run<T>(_priority: BrokerWritePriority, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(operation).finally(release);
  }
}

function isExplicitRejection(status: number): boolean {
  return status >= 400 && status < 500;
}

function statusOf(error: unknown): number | null {
  const value = (error as { status?: unknown })?.status;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reasonOf(error: unknown, status: number | null): string {
  if (status !== null && status >= 500) return "server-error";
  if ((error as { isNetworkError?: unknown })?.isNetworkError === true || status === 0) return "network-error";
  const message = String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("abort")) return "timeout";
  if (message.includes("network") || message.includes("socket") || message.includes("fetch")) return "network-error";
  return "unknown-error";
}

function locationOrderId(headers: BrokerWriteResponse["headers"]): string | null {
  const raw = headers instanceof Headers
    ? headers.get("location")
    : Object.entries(headers).find(([key]) => key.toLowerCase() === "location")?.[1] ?? null;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim(), "https://api.schwabapi.com");
    const segments = url.pathname.split("/").filter(Boolean);
    const id = segments.at(-1);
    const parent = segments.at(-2)?.toLowerCase();
    return id && parent === "orders" && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function redactPath(path: string): string {
  return path.replace(/\/accounts\/[^/]+(?=\/|$)/i, "/accounts/[REDACTED]");
}
