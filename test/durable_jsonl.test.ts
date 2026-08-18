import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DurableJsonlWriter } from "../src/automation/observability/durableJsonl.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "schwab-durable-jsonl-"));
}

test("serializes concurrent durable appends into complete ordered JSONL records", async () => {
  const root = await tempRoot();
  try {
    const writer = new DurableJsonlWriter(path.join(root, "audit", "events.jsonl"), {
      failureCode: "AUDIT_FAILED",
    });
    await Promise.all(Array.from({ length: 100 }, (_, index) => writer.append({ index })));
    await writer.flush();

    const records = (await readFile(writer.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.index), Array.from({ length: 100 }, (_, index) => index));
    assert.equal(writer.failed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable append failure is sticky even when a later physical append succeeds", async () => {
  const root = await tempRoot();
  const parentCollision = path.join(root, "audit");
  try {
    await writeFile(parentCollision, "not-a-directory", "utf8");
    let failures = 0;
    const writer = new DurableJsonlWriter(path.join(parentCollision, "events.jsonl"), {
      failureCode: "AUDIT_FAILED",
      onFailure: () => { failures += 1; },
    });

    await assert.rejects(writer.append({ index: 1 }), /AUDIT_FAILED/);
    await assert.rejects(writer.flush(), /AUDIT_FAILED/);
    assert.equal(writer.failed, true);
    assert.equal(failures, 1);

    await rm(parentCollision, { force: true });
    await writer.append({ index: 2 });
    await assert.rejects(writer.flush(), /AUDIT_FAILED/);
    const records = (await readFile(writer.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records, [{ index: 2 }]);
    assert.equal(failures, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serialization failures are fail-closed before touching disk", async () => {
  const root = await tempRoot();
  try {
    let failures = 0;
    const writer = new DurableJsonlWriter(path.join(root, "audit", "events.jsonl"), {
      failureCode: "AUDIT_FAILED",
      onFailure: () => { failures += 1; throw new Error("reporter-failed"); },
    });
    await assert.rejects(writer.append(undefined), /AUDIT_FAILED/);
    assert.equal(writer.failed, true);
    assert.equal(failures, 1);
    await assert.rejects(writer.flush(), /AUDIT_FAILED/);
    await assert.rejects(stat(writer.path), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new audit files honor owner-only modes without chmodding an existing parent", {
  skip: process.platform === "win32",
}, async () => {
  const root = await tempRoot();
  try {
    const parent = path.join(root, "shared");
    await (await import("node:fs/promises")).mkdir(parent, { mode: 0o755 });
    await chmod(parent, 0o755);
    const writer = new DurableJsonlWriter(path.join(parent, "events.jsonl"), {
      failureCode: "AUDIT_FAILED",
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    await writer.append({ ok: true });
    await writer.flush();
    assert.equal((await stat(parent)).mode & 0o777, 0o755);
    assert.equal((await stat(writer.path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
