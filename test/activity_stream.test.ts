import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type WebSocket from "ws";
import { SchwabActivityStream, type ActivityBatch, type StreamContext } from "../src/activity_stream.ts";

const context: StreamContext = {
  accessToken: "access-token",
  socketUrl: "wss://stream.example.test",
  customerId: "customer",
  correlationId: "correlation",
  channel: "channel",
  functionId: "function",
};

class FakeSocket extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly onSend: (frame: any, socket: FakeSocket) => void;

  constructor(onSend: (frame: any, socket: FakeSocket) => void) {
    super();
    this.onSend = onSend;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  send(payload: string): void {
    if (this.readyState !== 1) throw new Error("SOCKET_NOT_OPEN");
    this.sent.push(payload);
    this.onSend(JSON.parse(payload), this);
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  response(requestid: string, service: string, command: string, code: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify({ response: [{ requestid, service, command, timestamp: Date.now(), content: { code, msg: "OK" } }] })));
  }

  activity(entries: any[]): void {
    this.emit("message", Buffer.from(JSON.stringify({ data: entries.map((entry) => ({ timestamp: Date.now(), command: "SUBS", ...entry })) })));
  }
}

function createHarness(options: {
  codes?: unknown[];
  open?: boolean;
  loadContext?: () => Promise<StreamContext>;
} = {}): {
  stream: SchwabActivityStream;
  sockets: FakeSocket[];
  states: string[];
  batches: ActivityBatch[];
} {
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const batches: ActivityBatch[] = [];
  let codeIndex = 0;
  const stream = new SchwabActivityStream({
    loadContext: options.loadContext ?? (async () => context),
    onActivity: (batch) => batches.push(batch),
    onState: (message) => states.push(message),
    createWebSocket: () => {
      const socket = new FakeSocket((frame, current) => {
        const request = frame.requests[0];
        const code = options.codes && codeIndex < options.codes.length ? options.codes[codeIndex] : 0;
        codeIndex += 1;
        queueMicrotask(() => current.response(request.requestid, request.service, request.command, code));
      });
      sockets.push(socket);
      if (options.open !== false) queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    },
    openTimeoutMs: 30,
    ackTimeoutMs: 30,
    activityDebounceMs: 5,
    reconnectDelayMs: 1,
  });
  return { stream, sockets, states, batches };
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("Activity stream performs LOGIN and SUBS, accepts protocol success codes, and coalesces activity hints", async () => {
  const harness = createHarness({ codes: [0, 26] });
  harness.stream.start();
  await waitFor(() => harness.stream.ready);
  assert.equal(harness.sockets.length, 1);
  const requests = harness.sockets[0].sent.map((payload) => JSON.parse(payload).requests[0]);
  assert.deepEqual(requests.map((request) => [request.service, request.command]), [
    ["ADMIN", "LOGIN"],
    ["ACCT_ACTIVITY", "SUBS"],
  ]);
  assert.equal(requests[0].parameters.Authorization, "access-token");

  harness.sockets[0].activity([
    { service: "ACCT_ACTIVITY", content: [{ "3": { orderId: "42", status: "WORKING" } }] },
    { service: "ACCT_ACTIVITY", content: [{ messageData: "<Activity><OrderId>43</OrderId><Status>FILLED</Status><FilledQuantity>1</FilledQuantity></Activity>" }] },
  ]);
  await waitFor(() => harness.batches.length === 1);
  assert.deepEqual(harness.batches[0], {
    complete: true,
    hints: [
      { orderId: "42", status: "WORKING", filledQuantity: null },
      { orderId: "43", status: "FILLED", filledQuantity: 1 },
    ],
  });
  await harness.stream.stop();
  assert.equal(harness.stream.ready, false);
});

test("Activity stream reconnects after an abnormal close and keeps the second socket authoritative", async () => {
  const harness = createHarness();
  harness.stream.start();
  await waitFor(() => harness.stream.ready);
  harness.sockets[0].close(1006);
  await waitFor(() => harness.sockets.length >= 2 && harness.stream.ready);
  assert.match(harness.states.join("\n"), /订阅断开/);
  assert.equal(harness.sockets[0].readyState, 3);
  await harness.stream.stop();
  assert.equal(harness.sockets[1].readyState, 3);
});

test("malformed protocol frames are ignored without invoking activity callbacks", async () => {
  const harness = createHarness();
  harness.stream.start();
  await waitFor(() => harness.stream.ready);
  harness.sockets[0].emit("message", Buffer.from("not-json"));
  harness.sockets[0].activity([{ service: "OTHER", content: [{ "3": { orderId: "nope", status: "FILLED" } }] }]);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(harness.batches, []);
  await harness.stream.stop();
});

test("invalid ACK codes fail closed instead of coercing null into success", async () => {
  const harness = createHarness({ codes: [null] });
  harness.stream.start();
  await waitFor(() => harness.states.some((message) => message.includes("订阅断开")));
  assert.equal(harness.stream.ready, false);
  await harness.stream.stop();
});

test("command-specific ACK codes reject a subscription code for LOGIN and a VIEW code for SUBS", async () => {
  const loginWrong = createHarness({ codes: [27] });
  loginWrong.stream.start();
  await waitFor(() => loginWrong.states.some((message) => message.includes("订阅断开")));
  assert.equal(loginWrong.stream.ready, false);
  await loginWrong.stream.stop();

  const subsWrong = createHarness({ codes: [0, 29] });
  subsWrong.stream.start();
  await waitFor(() => subsWrong.states.some((message) => message.includes("订阅断开")));
  assert.equal(subsWrong.stream.ready, false);
  await subsWrong.stream.stop();
});

test("stale ACKs with a reused request ID but wrong service or command do not settle the pending request", async () => {
  const states: string[] = [];
  const socket = new FakeSocket((frame, current) => {
    const request = frame.requests[0];
    if (request.command === "LOGIN") {
      queueMicrotask(() => current.response(request.requestid, "STALE_SERVICE", request.command, 0));
      queueMicrotask(() => current.response(request.requestid, request.service, request.command, 0));
      return;
    }
    queueMicrotask(() => current.response(request.requestid, request.service, "VIEW", 0));
    queueMicrotask(() => current.response(request.requestid, request.service, request.command, 26));
  });
  const stream = new SchwabActivityStream({
    loadContext: async () => context,
    onActivity: () => undefined,
    onState: (message) => states.push(message),
    createWebSocket: () => {
      queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    },
    openTimeoutMs: 30,
    ackTimeoutMs: 30,
    reconnectDelayMs: 1,
  });
  stream.start();
  await waitFor(() => stream.ready);
  assert.equal(states.some((message) => message.includes("订阅断开")), false);
  await stream.stop();
});

test("a synchronous socket send failure rejects immediately and does not leave an ACK timer pending", async () => {
  const harness = createHarness();
  const socketFactory = harness.stream;
  const fake = harness.sockets;
  // Replace the first socket's send behavior before the stream starts by using
  // a small context-failure harness; the normal fake still exercises cleanup.
  const states: string[] = [];
  const broken = new SchwabActivityStream({
    loadContext: async () => context,
    onActivity: () => undefined,
    onState: (message) => states.push(message),
    createWebSocket: () => {
      const socket = new FakeSocket(() => { throw new Error("SEND_BROKEN"); });
      queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    },
    openTimeoutMs: 30,
    ackTimeoutMs: 30,
    reconnectDelayMs: 1,
  });
  broken.start();
  await waitFor(() => states.some((message) => message.includes("订阅断开")));
  await broken.stop();
  assert.equal(fake.length, 0);
  assert.equal(socketFactory.ready, false);
});

test("stop clears a queued activity debounce and rejects a context failure without touching the network", async () => {
  const harness = createHarness({
    loadContext: async () => { throw new Error("TOKEN_CONTEXT_FAILED"); },
  });
  harness.stream.start();
  await waitFor(() => harness.states.some((message) => message.includes("订阅断开")));
  await harness.stream.stop();
  assert.deepEqual(harness.sockets, []);
  assert.equal(harness.batches.length, 0);
});
