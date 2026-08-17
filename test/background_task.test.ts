import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundTaskFailureCode,
  superviseBackgroundTask,
} from "../src/automation/backgroundTask.ts";

async function settleBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("background task failure codes preserve only stable runtime codes", () => {
  assert.equal(backgroundTaskFailureCode(new Error("SCHWAB_HTTP_503")), "SCHWAB_HTTP_503");
  assert.equal(backgroundTaskFailureCode(new Error("REFRESH_QUOTA_HEADROOM")), "REFRESH_QUOTA_HEADROOM");
  assert.equal(
    backgroundTaskFailureCode(new Error("access_token=secret socket reset")),
    "RUNTIME_BACKGROUND_TASK_FAILED",
  );
  assert.equal(backgroundTaskFailureCode("raw token value"), "RUNTIME_BACKGROUND_TASK_FAILED");
});

test("supervisor consumes asynchronous task rejection and reports a sanitized code", async () => {
  const failures: Array<{ task: string; code: string }> = [];
  superviseBackgroundTask(
    "full-order-poll",
    async () => { throw new Error("SCHWAB_HTTP_503"); },
    (task, _error, code) => failures.push({ task, code }),
  );
  await settleBackgroundWork();
  assert.deepEqual(failures, [{ task: "full-order-poll", code: "SCHWAB_HTTP_503" }]);
});

test("supervisor consumes synchronous throw and isolates reporter failure", async () => {
  let reports = 0;
  superviseBackgroundTask(
    "explorer-round-loop",
    () => { throw new Error("secret=unsafe"); },
    (_task, _error, code) => {
      reports += 1;
      assert.equal(code, "RUNTIME_BACKGROUND_TASK_FAILED");
      throw new Error("reporter failed");
    },
  );
  await settleBackgroundWork();
  assert.equal(reports, 1);
});

test("successful detached task does not call failure reporter", async () => {
  let reports = 0;
  superviseBackgroundTask("explorer-tick", async () => undefined, () => { reports += 1; });
  await settleBackgroundWork();
  assert.equal(reports, 0);
});
