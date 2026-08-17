import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundAuthFailureCode,
  UnauthorizedRefreshCoordinator,
} from "../src/automation/auth/unauthorizedRefresh.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("background auth failure codes preserve only stable AUTH codes", () => {
  assert.equal(backgroundAuthFailureCode(new Error("AUTH_LOGIN_REQUIRED")), "AUTH_LOGIN_REQUIRED");
  assert.equal(backgroundAuthFailureCode(new Error("AUTH_HTTP_401")), "AUTH_HTTP_401");
  assert.equal(
    backgroundAuthFailureCode(new Error("invalid_grant refresh_token=secret")),
    "AUTH_BACKGROUND_REFRESH_FAILED",
  );
  assert.equal(backgroundAuthFailureCode("access_token=secret"), "AUTH_BACKGROUND_REFRESH_FAILED");
});

test("401 background refresh coalesces, consumes failure, and can be scheduled again", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const pending = [first, second];
  const failures: string[] = [];
  let refreshCalls = 0;
  const coordinator = new UnauthorizedRefreshCoordinator({
    refresh: () => pending[refreshCalls++].promise,
    onFailure: (code) => failures.push(code),
  });

  assert.equal(coordinator.schedule(), true);
  assert.equal(coordinator.schedule(), false);
  await settleBackgroundWork();
  assert.equal(refreshCalls, 1);
  first.reject(new Error("AUTH_LOGIN_REQUIRED"));
  await settleBackgroundWork();
  assert.deepEqual(failures, ["AUTH_LOGIN_REQUIRED"]);

  assert.equal(coordinator.schedule(), true);
  await settleBackgroundWork();
  assert.equal(refreshCalls, 2);
  second.resolve(undefined);
  await settleBackgroundWork();
  assert.deepEqual(failures, ["AUTH_LOGIN_REQUIRED"]);
});

test("synchronous refresh and reporter failures stay contained", async () => {
  let refreshCalls = 0;
  let reporterCalls = 0;
  const coordinator = new UnauthorizedRefreshCoordinator({
    refresh: () => {
      refreshCalls += 1;
      throw new Error("raw oauth secret");
    },
    onFailure: (code) => {
      reporterCalls += 1;
      assert.equal(code, "AUTH_BACKGROUND_REFRESH_FAILED");
      throw new Error("reporter failed");
    },
  });

  assert.equal(coordinator.schedule(), true);
  await settleBackgroundWork();
  assert.equal(refreshCalls, 1);
  assert.equal(reporterCalls, 1);
  assert.equal(coordinator.schedule(), true);
});
