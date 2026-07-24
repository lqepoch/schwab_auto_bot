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
 */
export class ExecutionJournal {
  readonly path: string;
  readonly runId: string;
  private tail = Promise.resolve();
  private readonly onFailure: (error: unknown) => void;

  constructor(root: string, runId: string, onFailure: (error: unknown) => void) {
    this.runId = runId;
    this.onFailure = onFailure;
    const day = new Date().toISOString().slice(0, 10);
    this.path = join(root, ".state", "executions", day, `${runId}.jsonl`);
  }

  record(event: string, data: Record<string, unknown> = {}): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), runId: this.runId, event, data } satisfies ExecutionEvent)}\n`;
    const write = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, "utf8");
    });
    this.tail = write.catch((error) => {
      this.onFailure(error);
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}
