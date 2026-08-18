import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export type DurableJsonlOptions = Readonly<{
  failureCode: string;
  directoryMode?: number;
  fileMode?: number;
  onFailure?: (error: unknown) => void;
}>;

/**
 * Serialize JSONL appends and acknowledge them only after file fsync. On POSIX
 * the parent directory is fsynced as well, covering first-file creation and
 * keeping the durability boundary consistent across process/host crashes.
 *
 * The first failed or unserializable record is sticky: later appends may be
 * attempted for diagnostics, but flush/assertHealthy continue to report the
 * historical audit gap.
 */
export class DurableJsonlWriter {
  readonly path: string;
  private readonly failureCode: string;
  private readonly directoryMode: number | undefined;
  private readonly fileMode: number;
  private readonly onFailure: ((error: unknown) => void) | undefined;
  private tail: Promise<void> = Promise.resolve();
  private persistenceFailure: unknown = null;

  constructor(path: string, options: DurableJsonlOptions) {
    this.path = path;
    this.failureCode = options.failureCode;
    this.directoryMode = options.directoryMode;
    this.fileMode = options.fileMode ?? 0o600;
    this.onFailure = options.onFailure;
  }

  append(value: unknown): Promise<void> {
    let line: string;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new TypeError("DURABLE_JSONL_SERIALIZATION_UNDEFINED");
      line = `${serialized}\n`;
    } catch (error) {
      this.noteFailure(error);
      return Promise.reject(this.failure(error));
    }

    const write = this.tail.then(() => this.writeDurably(line));
    this.tail = write.catch((error) => {
      this.noteFailure(error);
    });
    return write.catch((error) => {
      throw this.failure(error);
    });
  }

  get failed(): boolean {
    return this.persistenceFailure !== null;
  }

  assertHealthy(): void {
    if (this.persistenceFailure !== null) throw this.failure(this.persistenceFailure);
  }

  async flush(): Promise<void> {
    await this.tail;
    this.assertHealthy();
  }

  private async writeDurably(line: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, {
      recursive: true,
      ...(this.directoryMode === undefined ? {} : { mode: this.directoryMode }),
    });

    const handle = await open(this.path, "a", this.fileMode);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  }

  private noteFailure(error: unknown): void {
    if (this.persistenceFailure !== null) return;
    this.persistenceFailure = error;
    try {
      this.onFailure?.(error);
    } catch {
      // Preserve the original persistence fault even when reporting fails.
    }
  }

  private failure(cause: unknown): Error {
    return new Error(this.failureCode, { cause });
  }
}
