import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionJournal } from "../src/execution_journal.ts";

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
