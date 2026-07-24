import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
