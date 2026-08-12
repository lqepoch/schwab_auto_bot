import { createHash, randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export type UnknownWritePhase = "IN_FLIGHT" | "PENDING";
export type UnknownWriteOperation = "PLACE_ORDER" | "REPLACE_ORDER" | "CANCEL_ORDER";
export type UnknownWriteMethod = "POST" | "PUT" | "DELETE";
export type UnknownWriteReason =
  | "network-error"
  | "timeout"
  | "server-error"
  | "missing-location"
  | "unknown-error";

export type BrokerOrderSnapshot = Record<string, any>;

export type UnknownWriteRecord = Readonly<{
  id: string;
  schemaVersion: 1;
  phase: UnknownWritePhase;
  operation: UnknownWriteOperation;
  method: UnknownWriteMethod;
  key: string;
  path: string;
  pathFingerprint: string;
  payloadFingerprint: string | null;
  baselineOrderIds: readonly string[];
  targetOrderId: string | null;
  targetFingerprint: string | null;
  preSendAt: string | null;
  createdAt: string;
  reason: UnknownWriteReason;
  status: number | null;
}>;

type PersistedState = Readonly<{
  schemaVersion: 1;
  accountFingerprint: string | null;
  pending: readonly UnknownWriteRecord[];
}>;

export type UnknownWriteFailure = Readonly<{
  operation: UnknownWriteOperation;
  method: UnknownWriteMethod;
  key: string;
  path: string;
  payload?: unknown;
  targetOrder?: BrokerOrderSnapshot;
  targetOrderId?: string;
  baselineOrderIds?: readonly string[];
  preSendAt?: string;
  status?: number;
  reason?: string;
}>;

export type ReconciliationResult = Readonly<{
  resolved: readonly UnknownWriteRecord[];
  pending: readonly Readonly<{
    record: UnknownWriteRecord;
    reason: "no-unique-match" | "target-not-canceled";
    matchingOrderCount: number;
  }>[];
}>;

const TERMINAL_CANCEL_STATUSES = new Set(["CANCELED", "CANCELLED"]);
const SAFE_PATH_SEGMENT = "/accounts/[REDACTED]";
const BROKER_CLOCK_SKEW_MS = 5_000;
const BROKER_MATCH_WINDOW_MS = 60_000;
const REPLACE_SOURCE_TERMINAL_STATUSES = new Set(["REPLACED"]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

/**
 * Broker responses contain execution metadata beside the order intent. The
 * metadata must not participate in reconciliation fingerprints because it is
 * assigned or changed by Schwab after the mutation. All other fields are
 * retained, including future execution fields, so a newly introduced broker
 * field cannot silently collapse two different order intents into one.
 */
const BROKER_METADATA_KEYS = new Set([
  "orderId",
  "status",
  "statusDescription",
  "filledQuantity",
  "remainingQuantity",
  "cancelable",
  "editable",
  "enteredTime",
  "closeTime",
  "orderActivityCollection",
  "accountNumber",
  "replacingOrderCollection",
  "legId",
  "cusip",
  "description",
  "instrumentId",
  "netChange",
  "type",
  "replacingOrder",
  "replacedBy",
]);

const NUMERIC_EXECUTION_KEYS = new Set([
  "price",
  "quantity",
  "stopPrice",
  "activationPrice",
  "stopPriceOffset",
  "orderValue",
  "taxLotQuantity",
]);

function normalizeExecutionValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeExecutionValue(entry));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(object)
        .filter(([entryKey, entryValue]) => !BROKER_METADATA_KEYS.has(entryKey) && entryValue !== undefined)
        .map(([entryKey, entryValue]) => [entryKey, normalizeExecutionValue(entryValue, entryKey)]),
    );
  }
  if (typeof value === "string" && key && NUMERIC_EXECUTION_KEYS.has(key)) {
    const trimmed = value.trim();
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
      const number = Number(trimmed);
      if (Number.isFinite(number)) return number;
    }
  }
  return value;
}

function normalizedOrder(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return normalizeExecutionValue(value) as Record<string, unknown>;
}

export function safePath(path: string): string {
  return path.replace(/\/accounts\/[^/]+(?=\/|$)/i, SAFE_PATH_SEGMENT);
}

export function fingerprintPayload(value: unknown): string {
  return sha256(canonical(normalizedOrder(value)));
}

export function fingerprintOrder(value: unknown): string {
  return fingerprintPayload(value);
}

export function classifyUnknownReason(failure: Pick<UnknownWriteFailure, "status" | "reason">): UnknownWriteReason | null {
  const status = failure.status;
  if (status !== undefined && status >= 400 && status < 500) return null;
  const reason = String(failure.reason ?? "").toLowerCase();
  if (reason.includes("missing-location")) return "missing-location";
  if (reason.includes("timeout") || reason.includes("aborted")) return "timeout";
  if (reason.includes("network") || status === 0) return "network-error";
  if (status !== undefined && status >= 500) return "server-error";
  return "unknown-error";
}

function validRecord(value: unknown): value is UnknownWriteRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<UnknownWriteRecord>;
  const operation = String(record.operation);
  const method = String(record.method);
  const pairing = (operation === "PLACE_ORDER" && method === "POST")
    || (operation === "REPLACE_ORDER" && method === "PUT")
    || (operation === "CANCEL_ORDER" && method === "DELETE");
  const targetInvariant = operation === "CANCEL_ORDER"
    ? typeof record.targetOrderId === "string" && record.targetOrderId.length > 0
    : operation === "REPLACE_ORDER"
    ? typeof record.targetOrderId === "string" && record.targetOrderId.length > 0 && typeof record.payloadFingerprint === "string" && typeof record.targetFingerprint === "string"
    : record.targetOrderId === null && record.targetFingerprint === null;
  return record.schemaVersion === 1
    && ["IN_FLIGHT", "PENDING"].includes(String(record.phase))
    && typeof record.id === "string" && record.id.length > 0
    && ["PLACE_ORDER", "REPLACE_ORDER", "CANCEL_ORDER"].includes(String(record.operation))
    && ["POST", "PUT", "DELETE"].includes(String(record.method))
    && pairing
    && typeof record.key === "string" && typeof record.path === "string"
    && typeof record.pathFingerprint === "string"
    && (record.payloadFingerprint === null || typeof record.payloadFingerprint === "string")
    && Array.isArray(record.baselineOrderIds) && record.baselineOrderIds.every((id) => typeof id === "string")
    && (record.targetOrderId === null || typeof record.targetOrderId === "string")
    && (record.targetFingerprint === null || typeof record.targetFingerprint === "string")
    && targetInvariant
    && (record.preSendAt === null || typeof record.preSendAt === "string")
    && typeof record.createdAt === "string"
    && ["network-error", "timeout", "server-error", "missing-location", "unknown-error"].includes(String(record.reason))
    && (record.status === null || typeof record.status === "number");
}

export class UnknownWriteReconciliation {
  private readonly statePath: string;
  private pendingRecords: UnknownWriteRecord[] = [];
  private accountFingerprint: string | null = null;
  private loaded = false;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    statePath: string,
    options: { now?: () => string; idFactory?: () => string } = {},
  ) {
    this.statePath = statePath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async load(): Promise<void> {
    await this.locked(async () => {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<PersistedState>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.pending) || parsed.pending.some((record) => !validRecord(record))
        || (parsed.accountFingerprint !== undefined && parsed.accountFingerprint !== null && typeof parsed.accountFingerprint !== "string")) {
        throw new Error("UNKNOWN_WRITE_STATE_INVALID");
      }
      this.accountFingerprint = typeof parsed.accountFingerprint === "string" ? parsed.accountFingerprint : null;
      const recoveredInFlight = parsed.pending.some((record) => record.phase === "IN_FLIGHT");
      const recovered = parsed.pending.map((record) => record.phase === "IN_FLIGHT" ? { ...record, phase: "PENDING" as const } : record);
      this.pendingRecords = [...recovered];
      this.loaded = true;
      if (recoveredInFlight) await this.persist(this.pendingRecords);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.pendingRecords = [];
    }
    this.loaded = true;
    });
  }

  async bindAccount(accountHash: string): Promise<void> {
    await this.locked(async () => {
    this.requireLoaded();
    const fingerprint = sha256(accountHash);
    if (this.accountFingerprint !== null && this.accountFingerprint !== fingerprint) {
      throw new Error("UNKNOWN_WRITE_ACCOUNT_MISMATCH");
    }
    if (this.accountFingerprint === null && this.pendingRecords.length > 0) {
      throw new Error("UNKNOWN_WRITE_ACCOUNT_UNBOUND");
    }
    if (this.accountFingerprint === fingerprint) return;
    this.accountFingerprint = fingerprint;
    await this.persist(this.pendingRecords);
    });
  }

  hasPending(): boolean {
    this.requireLoaded();
    return this.pendingRecords.length > 0;
  }

  pending(): readonly UnknownWriteRecord[] {
    this.requireLoaded();
    return this.pendingRecords;
  }

  async beginWrite(failure: UnknownWriteFailure): Promise<UnknownWriteRecord> {
    return this.locked(async () => {
      this.requireLoaded();
      this.requireAccountBound();
      return (await this.recordFailureUnlocked(failure, "IN_FLIGHT"))!;
    });
  }

  async recordFailure(failure: UnknownWriteFailure, phase: UnknownWritePhase = "PENDING"): Promise<UnknownWriteRecord | null> {
    return this.locked(async () => {
      this.requireLoaded();
      return this.recordFailureUnlocked(failure, phase);
    });
  }

  private async recordFailureUnlocked(
    failure: UnknownWriteFailure,
    phase: UnknownWritePhase,
  ): Promise<UnknownWriteRecord | null> {
    const reason = phase === "IN_FLIGHT" ? "unknown-error" : classifyUnknownReason(failure);
    if (!reason) return null;
    const record: UnknownWriteRecord = {
      id: this.idFactory(),
      schemaVersion: 1,
      phase,
      operation: failure.operation,
      method: failure.method,
      key: failure.key,
      path: safePath(failure.path),
      pathFingerprint: sha256(safePath(failure.path)),
      payloadFingerprint: failure.payload === undefined ? null : fingerprintPayload(failure.payload),
      baselineOrderIds: [...new Set(failure.baselineOrderIds ?? [])],
      targetOrderId: failure.targetOrderId ?? null,
      targetFingerprint: failure.targetOrder === undefined ? null : fingerprintOrder(failure.targetOrder),
      preSendAt: failure.preSendAt ?? this.now(),
      createdAt: this.now(),
      reason,
      status: failure.status ?? null,
    };
    const nextPending = [...this.pendingRecords, record];
    await this.persist(nextPending);
    this.pendingRecords = nextPending;
    return record;
  }

  async settleWrite(id: string, outcome: Pick<UnknownWriteFailure, "status" | "reason">): Promise<UnknownWriteRecord | null> {
    return this.locked(async () => {
    this.requireLoaded();
    const current = this.pendingRecords.find((record) => record.id === id);
    if (!current) throw new Error("UNKNOWN_WRITE_RECORD_NOT_FOUND");
    const reason = classifyUnknownReason(outcome);
    if (!reason) {
      await this.completeWriteUnlocked(id);
      return null;
    }
    const updated: UnknownWriteRecord = { ...current, phase: "PENDING", reason, status: outcome.status ?? null };
    const nextPending = this.pendingRecords.map((record) => record.id === id ? updated : record);
    await this.persist(nextPending);
    this.pendingRecords = nextPending;
    return updated;
    });
  }

  async completeWrite(id: string): Promise<void> {
    return this.locked(async () => this.completeWriteUnlocked(id));
  }

  private async completeWriteUnlocked(id: string): Promise<void> {
    this.requireLoaded();
    if (!this.pendingRecords.some((record) => record.id === id)) throw new Error("UNKNOWN_WRITE_RECORD_NOT_FOUND");
    const nextPending = this.pendingRecords.filter((record) => record.id !== id);
    await this.persist(nextPending);
    this.pendingRecords = nextPending;
  }

  async reconcile(orders: readonly BrokerOrderSnapshot[]): Promise<ReconciliationResult> {
    return this.locked(async () => {
    this.requireLoaded();
    const resolved: UnknownWriteRecord[] = [];
    const pending: Array<{
      record: UnknownWriteRecord;
      reason: "no-unique-match" | "target-not-canceled";
      matchingOrderCount: number;
    }> = [];
    // Build all candidate sets before resolving anything. A broker order is a
    // single piece of evidence and may prove at most one unknown write. The
    // conservative rule below deliberately leaves every record pending when a
    // candidate is shared; guessing an assignment would permit a duplicate
    // mutation after a process restart.
    const candidates = new Map<string, readonly BrokerOrderSnapshot[]>();
    const pendingReason = new Map<string, "no-unique-match" | "target-not-canceled">();
    for (const record of this.pendingRecords) {
      if (record.phase === "IN_FLIGHT") continue;
      if (record.operation === "CANCEL_ORDER") {
        const targetMatches = orders.filter((order) => String(order.orderId ?? "") === record.targetOrderId);
        const canceled = targetMatches.filter((order) => TERMINAL_CANCEL_STATUSES.has(String(order.status ?? "").toUpperCase()));
        if (targetMatches.length === 1 && canceled.length === 1) {
          candidates.set(record.id, canceled);
        } else {
          candidates.set(record.id, []);
          pendingReason.set(record.id, "target-not-canceled");
        }
        continue;
      }
      if (record.operation === "REPLACE_ORDER") {
        const sourceMatches = orders.filter((order) => String(order.orderId ?? "") === record.targetOrderId);
        const source = sourceMatches.length === 1 ? sourceMatches[0] : undefined;
        const sourceStatus = String(source?.status ?? "").toUpperCase();
        if (!source || !REPLACE_SOURCE_TERMINAL_STATUSES.has(sourceStatus) || record.targetFingerprint === null || fingerprintOrder(source) !== record.targetFingerprint) {
          candidates.set(record.id, []);
          pendingReason.set(record.id, "no-unique-match");
          continue;
        }
      }
      const matches = orders.filter((order) => {
        const orderId = String(order.orderId ?? "");
        if (!orderId || record.payloadFingerprint === null || fingerprintOrder(order) !== record.payloadFingerprint) return false;
        if (record.baselineOrderIds.includes(orderId)) return false;
        if (record.operation === "REPLACE_ORDER" && orderId === record.targetOrderId) return false;
        const preSendAt = parseBrokerTimestamp(record.preSendAt);
        const enteredTime = parseBrokerTimestamp(order.enteredTime);
        // Schwab's broker clock may lag the client slightly; a small lower bound
        // allowance is safe only together with baseline exclusion, uniqueness,
        // and a short post-send window that prevents old manual orders from
        // resolving a later unknown write.
        return preSendAt !== null && enteredTime !== null
          && enteredTime >= preSendAt - BROKER_CLOCK_SKEW_MS
          && enteredTime <= preSendAt + BROKER_MATCH_WINDOW_MS;
      });
      candidates.set(record.id, matches);
    }

    const owners = new Map<string, string[]>();
    for (const [recordId, matches] of candidates) {
      for (const order of matches) {
        const orderId = String(order.orderId ?? "");
        const recordOwners = owners.get(orderId) ?? [];
        recordOwners.push(recordId);
        owners.set(orderId, recordOwners);
      }
    }

    for (const record of this.pendingRecords) {
      const matches = candidates.get(record.id);
      if (!matches) continue;
      const uniqueIds = new Set(matches.map((order) => String(order.orderId ?? "")));
      const hasSharedCandidate = [...uniqueIds].some((orderId) => (owners.get(orderId)?.length ?? 0) > 1);
      if (matches.length === 1 && uniqueIds.size === 1 && !hasSharedCandidate) {
        resolved.push(record);
      } else {
        pending.push({
          record,
          reason: pendingReason.get(record.id) ?? "no-unique-match",
          matchingOrderCount: matches.length,
        });
      }
    }
    if (resolved.length > 0) {
      const resolvedIds = new Set(resolved.map((record) => record.id));
      const nextPending = this.pendingRecords.filter((record) => !resolvedIds.has(record.id));
      await this.persist(nextPending);
      this.pendingRecords = nextPending;
    }
    return { resolved, pending };
    });
  }

  private requireAccountBound(): void {
    if (this.accountFingerprint === null) throw new Error("UNKNOWN_WRITE_ACCOUNT_UNBOUND");
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new Error("UNKNOWN_WRITE_STATE_NOT_LOADED");
  }

  private async persist(pending = this.pendingRecords): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.${this.idFactory()}.tmp`;
    const state: PersistedState = { schemaVersion: 1, accountFingerprint: this.accountFingerprint, pending };
    const file = await openFile(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(state, null, 2), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.statePath);
    const directory = await openFile(dirname(this.statePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
function parseBrokerTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
