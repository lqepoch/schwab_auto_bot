import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionJournal } from "../src/automation/observability/executionJournal.ts";

test("writes ordered JSONL records into a per-run state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-journal-"));
  try {
    const failures: unknown[] = [];
    const journal = new ExecutionJournal(root, "run-123", (error) => failures.push(error));
    journal.record("run.started", { mode: "read-only" });
    journal.record("order.fill", { orderId: "42", filledAt: "2026-07-24T14:00:00.000Z" });
    await journal.flush();
    const events = (await readFile(journal.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].runId, "run-123");
    assert.equal(events[0].event, "run.started");
    assert.equal(events[1].event, "order.fill");
    assert.deepEqual(failures, []);
    assert.equal(journal.failed, false);
    assert.doesNotThrow(() => journal.assertHealthy());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent records into complete, parseable JSONL lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-journal-"));
  try {
    const failures: unknown[] = [];
    const journal = new ExecutionJournal(root, "run-concurrent", (error) => failures.push(error));
    for (let index = 0; index < 250; index += 1) {
      journal.record("event", { index, payload: "x".repeat(80) });
    }
    await journal.flush();
    const lines = (await readFile(journal.path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 250);
    assert.deepEqual(lines.map((line) => JSON.parse(line).data.index), Array.from({ length: 250 }, (_, index) => index));
    assert.deepEqual(failures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redacts token, authorization, secret, and account identifiers at the journal boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-journal-"));
  try {
    const journal = new ExecutionJournal(root, "run-redaction", () => undefined);
    journal.record("sensitive", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      clientSecret: "client-secret",
      accountHash: "account-hash",
      tokenPresent: true,
      message: "Authorization: Bearer abcdefghijklmnop",
      nested: { authorization: "Bearer nested-secret" },
    });
    await journal.flush();
    const value = JSON.parse(await readFile(journal.path, "utf8"));
    assert.equal(value.data.accessToken, "[REDACTED]");
    assert.equal(value.data.refreshToken, "[REDACTED]");
    assert.equal(value.data.clientSecret, "[REDACTED]");
    assert.equal(value.data.accountHash, "[REDACTED]");
    assert.equal(value.data.tokenPresent, true);
    assert.equal(value.data.nested.authorization, "[REDACTED]");
    assert.match(value.data.message, /\[REDACTED\]/);
    const raw = await readFile(journal.path, "utf8");
    assert.equal(raw.includes("access-secret"), false);
    assert.equal(raw.includes("account-hash"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lost journal event is a sticky persistence fault even after later append recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-journal-"));
  try {
    const statePath = join(root, ".state");
    await writeFile(statePath, "not-a-directory", "utf8");
    const failures: unknown[] = [];
    const journal = new ExecutionJournal(root, "run-failure", (error) => failures.push(error));

    journal.record("will-fail", { value: 1 });
    await assert.rejects(journal.flush(), /EXECUTION_JOURNAL_PERSISTENCE_FAILED/);
    assert.equal(journal.failed, true);
    assert.throws(() => journal.assertHealthy(), /EXECUTION_JOURNAL_PERSISTENCE_FAILED/);
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof Error);

    await rm(statePath, { force: true });
    journal.record("recovered-append", { value: 2 });
    await assert.rejects(journal.flush(), /EXECUTION_JOURNAL_PERSISTENCE_FAILED/);

    const events = (await readFile(journal.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "recovered-append");
    assert.equal(events[0].data.value, 2);
    assert.equal(failures.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a synchronous serialization fault is sticky even when the failure reporter throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-journal-"));
  try {
    let failures = 0;
    const journal = new ExecutionJournal(root, "run-serialization-failure", () => {
      failures += 1;
      throw new Error("reporter-failed");
    });
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, "broken", {
      enumerable: true,
      get() {
        throw new Error("getter-exploded");
      },
    });

    assert.doesNotThrow(() => journal.record("bad-payload", data));
    assert.equal(journal.failed, true);
    assert.equal(failures, 1);
    assert.throws(() => journal.assertHealthy(), /EXECUTION_JOURNAL_PERSISTENCE_FAILED/);
    await assert.rejects(journal.flush(), /EXECUTION_JOURNAL_PERSISTENCE_FAILED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handles circular, bigint, and Date payloads without breaking the audit stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-journal-"));
  try {
    const journal = new ExecutionJournal(root, "run-values", () => undefined);
    const circular: Record<string, unknown> = { amount: 2n, at: new Date("2026-08-13T00:00:00.000Z") };
    circular.self = circular;
    journal.record("values", circular);
    await journal.flush();
    const value = JSON.parse(await readFile(journal.path, "utf8"));
    assert.equal(value.data.amount, "2n");
    assert.equal(value.data.at, "2026-08-13T00:00:00.000Z");
    assert.equal(value.data.self, "[Circular]");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
