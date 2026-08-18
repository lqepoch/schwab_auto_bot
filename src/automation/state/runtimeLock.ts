import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

type RuntimeLockRecord = {
  schemaVersion: 1;
  pid: number;
  runId: string;
  acquiredAt: string;
  ownerId: string;
};

type RuntimeReclaimRecord = RuntimeLockRecord & {
  operation: "stale-lock-reclaim";
};

export type RuntimeLock = {
  release: () => void;
};

export function acquireRuntimeLock(path: string, runId: string, pid = process.pid): RuntimeLock {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record: RuntimeLockRecord = {
    schemaVersion: 1,
    pid,
    runId,
    acquiredAt: new Date().toISOString(),
    ownerId: randomUUID(),
  };

  // An abandoned reclaim gate is intentionally fail-closed. Automatically
  // deleting it would reintroduce ambiguity about whether another runtime is
  // between archiving a stale owner and creating the replacement lock.
  assertNoReclaimGate(path);

  const direct = tryCreateRuntimeLock(path, record);
  if (direct) return direct;

  const current = readLock(path);
  if (!current) throw new Error("RUNTIME_LOCK_INVALID");
  if (isProcessAlive(current.pid)) {
    throw new Error(`RUNTIME_INSTANCE_ACTIVE pid=${current.pid} runId=${current.runId}`);
  }

  return reclaimStaleRuntimeLock(path, record);
}

function tryCreateRuntimeLock(path: string, record: RuntimeLockRecord): RuntimeLock | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }

  try {
    writeFileSync(descriptor, JSON.stringify(record), "utf8");
    fsyncSync(descriptor);
  } finally {
    // If write/fsync throws, leave the exclusive file in place. A malformed or
    // uncertain lock is safer than deleting a path that another actor might
    // have replaced while the failure was being handled.
    closeSync(descriptor);
  }
  syncParentDirectory(path);
  return ownedRuntimeLock(path, record);
}

function reclaimStaleRuntimeLock(path: string, replacement: RuntimeLockRecord): RuntimeLock {
  const reclaimPath = `${path}.reclaim`;
  const reclaimRecord: RuntimeReclaimRecord = {
    ...replacement,
    operation: "stale-lock-reclaim",
  };

  let reclaimDescriptor: number;
  try {
    reclaimDescriptor = openSync(reclaimPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("RUNTIME_LOCK_RECLAIM_IN_PROGRESS");
    }
    throw error;
  }

  try {
    writeFileSync(reclaimDescriptor, JSON.stringify(reclaimRecord), "utf8");
    fsyncSync(reclaimDescriptor);
    syncParentDirectory(path);

    // Re-read while holding the exclusive reclaim gate. This closes the TOCTOU
    // window where two contenders could both observe an old dead owner, then
    // one contender could rename away the live lock just created by the other.
    const current = readLock(path);
    if (!current) throw new Error("RUNTIME_LOCK_INVALID");
    if (isProcessAlive(current.pid)) {
      throw new Error(`RUNTIME_INSTANCE_ACTIVE pid=${current.pid} runId=${current.runId}`);
    }

    const stalePath = `${path}.stale.${current.pid}.${safeFileToken(current.runId)}.${safeFileToken(current.ownerId)}.${randomUUID()}`;
    try {
      renameSync(path, stalePath);
      syncParentDirectory(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("RUNTIME_LOCK_ACQUISITION_RACE", { cause: error });
      }
      throw error;
    }

    // A brand-new contender may legitimately win the primary `wx` create after
    // the stale path was archived. Never rename that winner away; observe it
    // and fail closed instead.
    const acquired = tryCreateRuntimeLock(path, replacement);
    if (acquired) return acquired;

    const winner = readLock(path);
    if (winner && isProcessAlive(winner.pid)) {
      throw new Error(`RUNTIME_INSTANCE_ACTIVE pid=${winner.pid} runId=${winner.runId}`);
    }
    throw new Error("RUNTIME_LOCK_ACQUISITION_RACE");
  } finally {
    closeSync(reclaimDescriptor);
    releaseReclaimGate(reclaimPath, reclaimRecord.ownerId);
  }
}

function ownedRuntimeLock(path: string, record: RuntimeLockRecord): RuntimeLock {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        const current = readLock(path);
        if (
          current?.runId === record.runId
          && current.pid === record.pid
          && current.ownerId === record.ownerId
        ) {
          unlinkSync(path);
          syncParentDirectory(path);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function assertNoReclaimGate(path: string): void {
  try {
    readFileSync(`${path}.reclaim`, "utf8");
    throw new Error("RUNTIME_LOCK_RECLAIM_IN_PROGRESS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof Error && error.message === "RUNTIME_LOCK_RECLAIM_IN_PROGRESS") throw error;
    // Permission, malformed-object, and filesystem errors are all ambiguous.
    // Treat them as an existing reclaim operation.
    throw new Error("RUNTIME_LOCK_RECLAIM_IN_PROGRESS", { cause: error });
  }
}

function releaseReclaimGate(path: string, ownerId: string): void {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeReclaimRecord>;
    if (value.ownerId !== ownerId || value.operation !== "stale-lock-reclaim") return;
    unlinkSync(path);
    syncParentDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Leaving an uncertain reclaim gate behind is deliberately fail-closed.
      return;
    }
  }
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
      || typeof value.ownerId !== "string"
      || value.ownerId.length === 0
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

function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(dirname(path), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
