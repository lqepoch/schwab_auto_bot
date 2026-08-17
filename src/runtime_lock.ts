import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

type RuntimeLockRecord = {
  schemaVersion: 1;
  pid: number;
  runId: string;
  acquiredAt: string;
  ownerId: string;
};

export type RuntimeLock = {
  release: () => void;
};

export function acquireRuntimeLock(path: string, runId: string, pid = process.pid): RuntimeLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record: RuntimeLockRecord = {
    schemaVersion: 1,
    pid,
    runId,
    acquiredAt: new Date().toISOString(),
    ownerId: randomUUID(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(record), "utf8");
        fsyncSync(descriptor);
      } finally {
        // Closing the descriptor makes the lock record visible before another
        // process can use it for diagnostics.
        closeSync(descriptor);
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            const current = readLock(path);
            if (current?.runId === runId && current.pid === pid && current.ownerId === record.ownerId) unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const current = readLock(path);
    if (!current) throw new Error("RUNTIME_LOCK_INVALID");
    if (isProcessAlive(current.pid)) {
      throw new Error(`RUNTIME_INSTANCE_ACTIVE pid=${current.pid} runId=${current.runId}`);
    }
    try {
      renameSync(path, `${path}.stale.${current.pid}.${safeFileToken(current.runId)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("RUNTIME_LOCK_ACQUISITION_RACE");
}

function readLock(path: string): RuntimeLockRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeLockRecord>;
    if (
      value.schemaVersion !== 1
      || typeof value.pid !== "number"
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || typeof value.runId !== "string"
      || !value.runId
      || typeof value.acquiredAt !== "string"
      || !Number.isFinite(Date.parse(value.acquiredAt))
      || Date.parse(value.acquiredAt) > Date.now() + 5_000
    ) {
      return null;
    }
    return value as RuntimeLockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function safeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission failures are intentionally treated as active: we must never
    // take over a lock merely because this account cannot inspect its owner.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
