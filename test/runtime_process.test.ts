import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  bindRuntimeAbortSignal,
  bindRuntimeProcessHandlers,
  type RuntimeProcessEvents,
  type RuntimeSignal,
} from "../src/automation/runtimeProcess.ts";

function processEvents(emitter: EventEmitter): RuntimeProcessEvents {
  return {
    on: (event, listener) => emitter.on(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    off: (event, listener) => emitter.off(event, listener),
  };
}

test("runtime process bindings preserve the exact signal and clean up idempotently", () => {
  const emitter = new EventEmitter();
  const signals: RuntimeSignal[] = [];
  let exits = 0;
  const cleanup = bindRuntimeProcessHandlers(processEvents(emitter), {
    onSignal: (signal) => signals.push(signal),
    onExit: () => { exits += 1; },
  });

  emitter.emit("SIGINT");
  emitter.emit("SIGTERM");
  emitter.emit("exit");
  emitter.emit("exit");
  assert.deepEqual(signals, ["SIGINT", "SIGTERM"]);
  assert.equal(exits, 1);

  cleanup();
  cleanup();
  emitter.emit("SIGINT");
  emitter.emit("SIGTERM");
  emitter.emit("exit");
  assert.deepEqual(signals, ["SIGINT", "SIGTERM"]);
  assert.equal(exits, 1);
  assert.equal(emitter.listenerCount("SIGINT"), 0);
  assert.equal(emitter.listenerCount("SIGTERM"), 0);
  assert.equal(emitter.listenerCount("exit"), 0);
});

test("runtime abort binding handles one future abort and cleanup is idempotent", () => {
  const controller = new AbortController();
  let aborts = 0;
  const cleanup = bindRuntimeAbortSignal(controller.signal, () => { aborts += 1; });

  controller.abort();
  controller.abort();
  assert.equal(aborts, 1);

  cleanup();
  cleanup();
  assert.equal(aborts, 1);
});

test("an already-aborted signal requests shutdown immediately", () => {
  const controller = new AbortController();
  controller.abort();
  let aborts = 0;
  const cleanup = bindRuntimeAbortSignal(controller.signal, () => { aborts += 1; });
  assert.equal(aborts, 1);
  cleanup();
});

test("missing abort signal binds as a no-op", () => {
  let aborts = 0;
  const cleanup = bindRuntimeAbortSignal(undefined, () => { aborts += 1; });
  cleanup();
  cleanup();
  assert.equal(aborts, 0);
});
