import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeProcessEvents } from "../src/automation/runtimeProcess.ts";
import { resolveAutomationRuntimeHost } from "../src/automation/runtimeHost.ts";

const fakeEvents: RuntimeProcessEvents = {
  on: () => undefined,
  once: () => undefined,
  off: () => undefined,
};

const fakeStderr = { write: (_chunk: string | Uint8Array) => true };

test("runtime host accepts explicit process-independent invocation state", () => {
  const host = resolveAutomationRuntimeHost({
    argv: ["node", "embedded", "--read-only", "--once"],
    env: { SCHWAB_APP_KEY: "test-key" },
    pid: 1234,
    execPath: "/opt/node/bin/node",
    entryPath: "/srv/bot/dist/main.js",
    stderr: fakeStderr,
    processEvents: fakeEvents,
  }, { entryPath: "/unused/main.ts" });

  assert.deepEqual(host.argv, ["node", "embedded", "--read-only", "--once"]);
  assert.equal(host.env.SCHWAB_APP_KEY, "test-key");
  assert.equal(host.pid, 1234);
  assert.equal(host.execPath, "/opt/node/bin/node");
  assert.equal(host.entryPath, "/srv/bot/dist/main.js");
  assert.equal(host.stderr, fakeStderr);
  assert.equal(host.processEvents, fakeEvents);
});

test("runtime host inherits supplied defaults without reading mutable caller options", () => {
  const defaults = {
    entryPath: "/repo/src/main.ts",
    argv: ["node", "main.ts", "--read-only"] as const,
    env: { MODE: "test" },
    pid: 77,
    execPath: "/node",
    stderr: fakeStderr,
    processEvents: fakeEvents,
  };
  const host = resolveAutomationRuntimeHost({}, defaults);
  assert.equal(host.argv, defaults.argv);
  assert.equal(host.env, defaults.env);
  assert.equal(host.pid, 77);
  assert.equal(host.entryPath, "/repo/src/main.ts");
});

test("runtime host rejects malformed injectable process metadata", () => {
  assert.throws(
    () => resolveAutomationRuntimeHost({ pid: 0 }, { entryPath: "/repo/src/main.ts" }),
    /AUTOMATION_RUNTIME_PID_INVALID/,
  );
  assert.throws(
    () => resolveAutomationRuntimeHost({ execPath: "" }, { entryPath: "/repo/src/main.ts" }),
    /AUTOMATION_RUNTIME_EXEC_PATH_INVALID/,
  );
  assert.throws(
    () => resolveAutomationRuntimeHost({ entryPath: "" }, { entryPath: "/repo/src/main.ts" }),
    /AUTOMATION_RUNTIME_ENTRY_PATH_INVALID/,
  );
});
