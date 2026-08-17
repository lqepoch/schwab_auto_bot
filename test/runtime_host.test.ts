import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { RuntimeProcessEvents } from "../src/automation/runtimeProcess.ts";
import { resolveAutomationRuntimeHost } from "../src/automation/runtimeHost.ts";

const fakeEvents: RuntimeProcessEvents = {
  on: () => undefined,
  once: () => undefined,
  off: () => undefined,
};

const fakeStderr = { write: (_chunk: string | Uint8Array) => true };
const defaultWorkspaceRoot = resolve("runtime-host-default-workspace");
const defaultEntryPath = resolve("runtime-host-default", "src", "main.ts");

function defaults() {
  return {
    entryPath: defaultEntryPath,
    workspaceRoot: defaultWorkspaceRoot,
  };
}

test("runtime host accepts explicit process-independent invocation state", () => {
  const reauthorizeInteractively = async () => undefined;
  const controller = new AbortController();
  const workspaceRoot = resolve("runtime-host-explicit-workspace");
  const host = resolveAutomationRuntimeHost({
    argv: ["node", "embedded", "--read-only", "--once"],
    env: { SCHWAB_APP_KEY: "test-key" },
    pid: 1234,
    execPath: resolve("runtime-host-bin", "node"),
    entryPath: resolve("runtime-host-dist", "main.js"),
    workspaceRoot,
    stderr: fakeStderr,
    processEvents: fakeEvents,
    reauthorizeInteractively,
    signal: controller.signal,
  }, defaults());

  assert.deepEqual(host.argv, ["node", "embedded", "--read-only", "--once"]);
  assert.equal(host.env.SCHWAB_APP_KEY, "test-key");
  assert.equal(host.pid, 1234);
  assert.equal(host.workspaceRoot, workspaceRoot);
  assert.equal(host.stderr, fakeStderr);
  assert.equal(host.processEvents, fakeEvents);
  assert.equal(host.reauthorizeInteractively, reauthorizeInteractively);
  assert.equal(host.signal, controller.signal);
});

test("runtime host inherits supplied defaults without reading mutable caller options", () => {
  const suppliedDefaults = {
    entryPath: defaultEntryPath,
    workspaceRoot: defaultWorkspaceRoot,
    argv: ["node", "main.ts", "--read-only"] as const,
    env: { MODE: "test" },
    pid: 77,
    execPath: resolve("runtime-host-node"),
    stderr: fakeStderr,
    processEvents: fakeEvents,
  };
  const host = resolveAutomationRuntimeHost({}, suppliedDefaults);
  assert.equal(host.argv, suppliedDefaults.argv);
  assert.equal(host.env, suppliedDefaults.env);
  assert.equal(host.pid, 77);
  assert.equal(host.entryPath, defaultEntryPath);
  assert.equal(host.workspaceRoot, defaultWorkspaceRoot);
  assert.equal(host.reauthorizeInteractively, undefined);
  assert.equal(host.signal, undefined);
});

test("runtime host rejects malformed injectable process metadata", () => {
  assert.throws(
    () => resolveAutomationRuntimeHost({ pid: 0 }, defaults()),
    /AUTOMATION_RUNTIME_PID_INVALID/,
  );
  assert.throws(
    () => resolveAutomationRuntimeHost({ execPath: "" }, defaults()),
    /AUTOMATION_RUNTIME_EXEC_PATH_INVALID/,
  );
  assert.throws(
    () => resolveAutomationRuntimeHost({ entryPath: "" }, defaults()),
    /AUTOMATION_RUNTIME_ENTRY_PATH_INVALID/,
  );
  assert.throws(
    () => resolveAutomationRuntimeHost({ workspaceRoot: "relative/workspace" }, defaults()),
    /AUTOMATION_RUNTIME_WORKSPACE_ROOT_INVALID/,
  );
  assert.throws(
    () => resolveAutomationRuntimeHost(
      { reauthorizeInteractively: "invalid" as unknown as () => Promise<void> },
      defaults(),
    ),
    /AUTOMATION_RUNTIME_REAUTH_CALLBACK_INVALID/,
  );
  assert.throws(
    () => resolveAutomationRuntimeHost(
      { signal: { aborted: false } as AbortSignal },
      defaults(),
    ),
    /AUTOMATION_RUNTIME_ABORT_SIGNAL_INVALID/,
  );
});
