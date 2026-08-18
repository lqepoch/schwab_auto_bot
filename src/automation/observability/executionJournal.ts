import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ExecutionEvent = {
  at: string;
  runId: string;
  event: string;
  data: Record<string, unknown>;
};

/**
 * A per-run append-only audit stream. Events are serialized so readers never see
 * interleaved JSON records even when stream reconciliation and writes overlap.
 *
 * Any serialization or persistence failure is sticky for the lifetime of the
 * journal: a later successful append cannot restore an audit event that was
 * already lost. flush() therefore remains fail-closed after the first gap.
 */
export class ExecutionJournal {
  readonly path: string;
  readonly runId: string;
  private tail = Promise.resolve();
  private directoryReady: Promise<void> | null = null;
  private readonly onFailure: (error: unknown) => void;
  private persistenceFailure: unknown = null;

  constructor(root: string, runId: string, onFailure: (error: unknown) => void) {
    this.runId = runId;
    this.onFailure = onFailure;
    const day = new Date().toISOString().slice(0, 10);
    this.path = join(root, ".state", "executions", day, `${runId}.jsonl`);
  }

  record(event: string, data: Record<string, unknown> = {}): void {
    let line: string;
    try {
      line = `${JSON.stringify({
        at: new Date().toISOString(),
        runId: this.runId,
        event,
        data: sanitizeJournalValue(data, "", new WeakSet<object>()) as Record<string, unknown>,
      } satisfies ExecutionEvent)}\n`;
    } catch (error) {
      this.noteFailure(error);
      return;
    }

    const write = this.tail.then(async () => {
      await this.ensureDirectory();
      await appendFile(this.path, line, "utf8");
    });
    this.tail = write.catch((error) => {
      this.noteFailure(error);
    });
  }

  private noteFailure(error: unknown): void {
    if (this.persistenceFailure !== null) return;
    this.persistenceFailure = error;
    try {
      this.onFailure(error);
    } catch {
      // Reporting a journal failure must not replace the original durability
      // fault or poison the serialized append tail.
    }
  }

  private ensureDirectory(): Promise<void> {
    if (!this.directoryReady) {
      const pending = mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
      this.directoryReady = pending;
      void pending.catch(() => {
        if (this.directoryReady === pending) this.directoryReady = null;
      });
    }
    return this.directoryReady;
  }

  get failed(): boolean {
    return this.persistenceFailure !== null;
  }

  assertHealthy(): void {
    if (this.persistenceFailure !== null) {
      throw new Error("EXECUTION_JOURNAL_PERSISTENCE_FAILED", { cause: this.persistenceFailure });
    }
  }

  async flush(): Promise<void> {
    await this.tail;
    this.assertHealthy();
  }
}

const sensitiveKeyPattern = /(?:access|refresh)?token|secret|authorization|account(?:hash|number)/i;

function sanitizeJournalValue(value: unknown, key: string, seen: WeakSet<object>): unknown {
  if (sensitiveKeyPattern.test(key) && (typeof value === "string" || (value && typeof value === "object"))) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return sanitizeJournalText(value);
  if (typeof value === "bigint") return `${value}n`;
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => sanitizeJournalValue(entry, "", seen));
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeJournalValue(childValue, childKey, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

function sanitizeJournalText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
