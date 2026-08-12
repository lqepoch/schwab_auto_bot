import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRuntimeLock } from "../src/runtime_lock.ts";

test("rejects a second runtime while the first lock owner is alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-runtime-lock-"));
  const path = join(root, "runtime.lock");
  const lock = acquireRuntimeLock(path, "run-one");
  try {
    assert.throws(() => acquireRuntimeLock(path, "run-two"), /RUNTIME_INSTANCE_ACTIVE pid=/);
  } finally {
    lock.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("reclaims a lock whose owner process no longer exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-runtime-lock-"));
  const path = join(root, "runtime.lock");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, pid: 2147483647, runId: "stale", acquiredAt: "2026-07-24T00:00:00.000Z" }), "utf8");
  const lock = acquireRuntimeLock(path, "run-current");
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    assert.equal(value.runId, "run-current");
  } finally {
    lock.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed, incomplete, and future-dated lock records fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-runtime-lock-"));
  const path = join(root, "runtime.lock");
  try {
    for (const value of [
      "not-json",
      JSON.stringify({ schemaVersion: 1, pid: 123, runId: "" }),
      JSON.stringify({ schemaVersion: 1, pid: 123, runId: "future", acquiredAt: new Date(Date.now() + 60_000).toISOString() }),
    ]) {
      await writeFile(path, value, "utf8");
      assert.throws(() => acquireRuntimeLock(path, "replacement"), /RUNTIME_LOCK_INVALID/);
      await rm(path, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats EPERM while probing an owner PID as active", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-runtime-lock-"));
  const path = join(root, "runtime.lock");
  const originalKill = process.kill;
  try {
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      pid: 123,
      runId: "permission-owner",
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    }), "utf8");
    Object.defineProperty(process, "kill", {
      configurable: true,
      value: () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); },
    });
    assert.throws(() => acquireRuntimeLock(path, "replacement"), /RUNTIME_INSTANCE_ACTIVE pid=123/);
  } finally {
    Object.defineProperty(process, "kill", { configurable: true, value: originalKill });
    await rm(root, { recursive: true, force: true });
  }
});

test("writes a private lock and only its owner token can release it", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-runtime-lock-"));
  const path = join(root, "nested", "runtime.lock");
  const lock = acquireRuntimeLock(path, "run-owner");
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const record = JSON.parse(await readFile(path, "utf8"));
    assert.match(record.ownerId, /^[0-9a-f-]{36}$/);
    await writeFile(path, JSON.stringify({ ...record, ownerId: "different-owner" }), "utf8");
    lock.release();
    assert.equal((await stat(path)).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reclaims malicious run IDs without using path separators in the stale filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-runtime-lock-"));
  const path = join(root, "runtime.lock");
  const lockRunId = "../outside/../../run with spaces";
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    pid: 2147483647,
    runId: lockRunId,
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  }), "utf8");
  const lock = acquireRuntimeLock(path, "current");
  try {
    const names = await (await import("node:fs/promises")).readdir(root);
    assert.ok(names.every((name) => !name.includes("/")));
    await assert.rejects(stat(join(root, "outside")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(path, "utf8")).runId, "current");
  } finally {
    lock.release();
    await rm(root, { recursive: true, force: true });
  }
});
