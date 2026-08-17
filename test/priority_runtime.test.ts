import assert from "node:assert/strict";
import test from "node:test";
import { PriorityGate, PriorityWriter, type Job, type Priority } from "../src/automation/scheduling/priorityRuntime.ts";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function job(key: string, priority: Priority, run: () => Promise<void>, done?: () => void): Job {
  return { key, priority, run, done };
}

test("PriorityWriter preserves FIFO within a priority and runs higher priority first", async () => {
  const events: string[] = [];
  const writer = new PriorityWriter((message) => events.push(`error:${message}`));
  writer.enqueue(job("low-1", 2, async () => { events.push("low-1"); }));
  writer.enqueue(job("low-2", 2, async () => { events.push("low-2"); }));
  writer.enqueue(job("high", 0, async () => { events.push("high"); }));
  await writer.waitIdle();

  assert.deepEqual(events, ["low-1", "low-2", "high"]);
});

test("PriorityWriter de-duplicates a key until the first job is released", async () => {
  const gate = deferred<void>();
  const events: string[] = [];
  let doneCalls = 0;
  const writer = new PriorityWriter(() => undefined);
  writer.enqueue(job("same", 1, async () => {
    events.push("first-start");
    await gate.promise;
    events.push("first-end");
  }));
  const duplicate = writer.enqueueAndWait(job("same", 0, async () => {
    events.push("duplicate");
  }, () => { doneCalls += 1; }));
  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  gate.resolve();
  await writer.waitIdle();
  await duplicate;
  assert.deepEqual(events, ["first-start", "first-end"]);
  assert.equal(doneCalls, 0);

  const afterRelease = writer.enqueueAndWait(job("same", 0, async () => { events.push("after-release"); }));
  await afterRelease;
  assert.deepEqual(events, ["first-start", "first-end", "after-release"]);
});

test("PriorityWriter respects the follow-up and non-critical concurrency caps", async () => {
  const blockers = Array.from({ length: 12 }, () => deferred<void>());
  const started: string[] = [];
  const writer = new PriorityWriter(() => undefined);
  for (let index = 0; index < blockers.length; index += 1) {
    const priority: Priority = index < 6 ? 1 : 2;
    writer.enqueue(job(`job-${index}`, priority, async () => {
      started.push(`job-${index}`);
      await blockers[index].promise;
    }));
  }
  await Promise.resolve();
  assert.equal(started.length, 6);
  assert.equal(started.filter((key) => Number(key.split("-")[1]) < 6).length, 2);
  assert.equal(started.filter((key) => Number(key.split("-")[1]) >= 6).length, 4);

  for (let index = 0; index < 6; index += 1) blockers[index].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 10);
  assert.equal(started.filter((key) => Number(key.split("-")[1]) < 6).length, 6);
  assert.equal(started.filter((key) => Number(key.split("-")[1]) >= 6).length, 4);
  for (const blocker of blockers) blocker.resolve();
  await writer.waitIdle();
});

test("PriorityWriter releases a failed key, decrements capacity, and reports non-quota errors", async () => {
  const errors: string[] = [];
  const writer = new PriorityWriter((message) => errors.push(message));
  writer.enqueue(job("fails", 0, async () => { throw new Error("boom"); }));
  await writer.waitIdle();
  assert.deepEqual(errors, ["任务失败 key=fails error=Error: boom"]);

  const rerun = writer.enqueueAndWait(job("fails", 0, async () => undefined));
  await rerun;
  assert.deepEqual(errors, ["任务失败 key=fails error=Error: boom"]);
});

test("PriorityWriter does not starve a lower-priority queue behind a continuing high-priority stream", async () => {
  const started: string[] = [];
  const writer = new PriorityWriter(() => undefined);
  const low = deferred<void>();
  const highJobs: Promise<void>[] = [];
  let nextHigh = 0;
  const enqueueHigh = (): void => {
    const index = nextHigh;
    nextHigh += 1;
    const promise = new Promise<void>((resolve) => {
      writer.enqueue(job(`high-${index}`, 0, async () => {
        started.push(`high-${index}`);
        if (index < 20) enqueueHigh();
        resolve();
      }));
    });
    highJobs.push(promise);
  };

  for (let index = 0; index < 8; index += 1) enqueueHigh();
  writer.enqueue(job("low", 2, async () => {
    started.push("low");
    low.resolve();
  }));
  await Promise.race([
    low.promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("LOW_PRIORITY_STARVED")), 500)),
  ]);
  assert.ok(started.indexOf("low") >= 0);
  await Promise.all(highJobs);
  await writer.waitIdle();
});

test("PriorityGate serializes operations, preserves same-priority FIFO, and propagates failures", async () => {
  const gate = new PriorityGate();
  const events: string[] = [];
  const first = deferred<void>();
  const firstResult = gate.run(2, async () => {
    events.push("first-start");
    await first.promise;
    events.push("first-end");
    return "first";
  });
  const second = gate.run(2, async () => { events.push("second"); return "second"; });
  const urgent = gate.run(0, async () => { events.push("urgent"); return "urgent"; });
  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  first.resolve();
  assert.equal(await firstResult, "first");
  assert.equal(await urgent, "urgent");
  assert.equal(await second, "second");
  assert.deepEqual(events, ["first-start", "first-end", "urgent", "second"]);

  const failure = gate.run(1, async () => { throw new Error("gate-failure"); });
  await assert.rejects(failure, /gate-failure/);
  const afterFailure = gate.run(1, async () => "after");
  assert.equal(await afterFailure, "after");
});

test("PriorityGate eventually serves lower priorities while urgent work keeps arriving", async () => {
  const gate = new PriorityGate();
  const events: string[] = [];
  const first = deferred<void>();
  const initial = gate.run(0, async () => {
    events.push("initial-high");
    await first.promise;
  });
  const low = gate.run(2, async () => { events.push("low"); return "low"; });
  const chainPromises: Promise<void>[] = [];
  for (let index = 0; index < 12; index += 1) {
    chainPromises.push(gate.run(0, async () => { events.push(`high-${index}`); }));
  }
  first.resolve();
  await initial;
  await low;
  assert.ok(events.indexOf("low") >= 0);
  await Promise.all(chainPromises);
});
