import assert from "node:assert/strict";
import test from "node:test";
import { ExplorerActionPacer } from "../src/automation/scheduling/explorerActionPacer.ts";

test("explorer action pacer serializes concurrent admissions at the configured cadence", async () => {
  let now = 10_000;
  const sleeps: number[] = [];
  const pacer = new ExplorerActionPacer({
    cooldownMs: 700,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  await Promise.all([pacer.admit(), pacer.admit(), pacer.admit()]);
  assert.deepEqual(sleeps, [700, 700]);
  assert.equal(now, 11_400);
});

test("explorer action pacer rejects invalid cooldown configuration", () => {
  assert.throws(
    () => new ExplorerActionPacer({ cooldownMs: -1 }),
    /EXPLORER_ACTION_COOLDOWN_INVALID/,
  );
});
