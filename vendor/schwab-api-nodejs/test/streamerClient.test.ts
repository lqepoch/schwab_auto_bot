import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamerClient } from '../dist/streamer/streamerClient.js';
import {
  StreamerCommandError,
  StreamerCommandNotSentError,
  StreamerCommandTimeoutError,
  StreamerConnectionError,
} from '../dist/streamer/streamerErrors.js';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = MockWebSocket.CONNECTING;
  deferTerminate = false;
  failNextSend = false;

  constructor(url: string) {
    super();
    this.url = url;
  }

  send(payload: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('socket send failed synchronously');
    }
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }

  respond(response: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify({ response: [response] })));
  }

  drop(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', code, Buffer.from('test disconnect'));
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', 1000, Buffer.from('closed'));
  }

  terminate(): void {
    if (this.deferTerminate) return;
    this.drop(1006);
  }

  ping(): void {}
}

function streamerInfo() {
  return {
    streamerSocketUrl: 'wss://streamer.test',
    schwabClientCustomerId: 'customer',
    schwabClientCorrelId: 'correlation',
    schwabClientChannel: 'channel',
    schwabClientFunctionId: 'function',
  };
}

function response(request: Record<string, unknown>, code = 0, msg = 'OK'): Record<string, unknown> {
  return {
    service: request.service,
    command: request.command,
    requestid: request.requestid,
    timestamp: Date.now(),
    content: { code, msg },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForSocket(sockets: MockWebSocket[], index: number): Promise<MockWebSocket> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const socket = sockets[index];
    if (socket) return socket;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Mock WebSocket ${index} was not created`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function connected(options: { timeoutMs?: number; autoReconnect?: boolean } = {}) {
  const sockets: MockWebSocket[] = [];
  const client = new StreamerClient({
    logger,
    autoReconnect: options.autoReconnect ?? false,
    reconnectDelayMs: 0,
    commandAckTimeoutMs: options.timeoutMs ?? 40,
    heartbeatCheckIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    clientPingIntervalMs: 0,
    webSocketFactory: (url) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket as never;
    },
  });

  const connectPromise = client.connect('access-token', streamerInfo());
  await settle();
  const socket = sockets[0];
  assert.ok(socket);
  socket.open();
  const login = (socket.sent[0]?.requests as Array<Record<string, unknown>> | undefined)?.[0];
  assert.ok(login);
  socket.respond(response(login));
  await connectPromise;
  return { client, sockets };
}

test('serializes SUBS and ADD, replays one complete SUBS per service, and ACKs unsubscribe', async () => {
  const { client, sockets } = await connected({ autoReconnect: true });
  const first = sockets[0]!;

  const sub = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'A', fields: '0' } });
  await settle();
  const subs = first.sent.at(-1)!;
  assert.equal(subs.requests && (subs.requests as Array<Record<string, unknown>>)[0]?.command, 'SUBS');
  first.respond(response((subs.requests as Array<Record<string, unknown>>)[0]!));
  await sub;

  const add = client.subscribe({ service: 'LEVELONE_OPTIONS', command: 'ADD', parameters: { keys: 'B' } });
  await settle();
  const addRequest = first.sent.at(-1)!;
  assert.equal((addRequest.requests as Array<Record<string, unknown>>)[0]?.command, 'ADD');
  first.respond(response((addRequest.requests as Array<Record<string, unknown>>)[0]!));
  await add;

  const unsubscribe = client.unsubscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'A' } });
  await settle();
  const unsubRequest = first.sent.at(-1)!;
  assert.equal((unsubRequest.requests as Array<Record<string, unknown>>)[0]?.command, 'UNSUBS');
  first.respond(response((unsubRequest.requests as Array<Record<string, unknown>>)[0]!));
  await unsubscribe;

  first.drop();
  const second = await waitForSocket(sockets, 1);
  second.open();
  const login = (second.sent[0]!.requests as Array<Record<string, unknown>>)[0]!;
  second.respond(response(login));
  await settle();
  let readyResolved = false;
  const ready = client.waitForReady({ timeoutMs: 40 }).then(() => {
    readyResolved = true;
  });
  await settle();
  assert.equal(readyResolved, false);

  const replayRequests = second.sent
    .flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .filter((request) => request.command === 'SUBS');
  assert.equal(replayRequests.length, 1);
  assert.deepEqual(replayRequests[0]?.parameters, { fields: '0', keys: 'B' });
  second.respond(response(replayRequests[0]!));
  await ready;
  client.disconnect();
});

test('holds a user subscription until the reconnect replay ACK completes', async () => {
  const { client, sockets } = await connected({ autoReconnect: true, timeoutMs: 200 });
  const first = sockets[0]!;
  const initial = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'A', fields: '0' } });
  await settle();
  const initialRequest = (first.sent.at(-1)!.requests as Array<Record<string, unknown>>)[0]!;
  first.respond(response(initialRequest));
  await initial;

  first.drop();
  const second = await waitForSocket(sockets, 1);
  second.open();
  const login = (second.sent[0]!.requests as Array<Record<string, unknown>>)[0]!;
  second.respond(response(login));
  await settle();
  const replay = second.sent.flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .find((request) => request.command === 'SUBS');
  assert.ok(replay);

  const add = client.subscribe({ service: 'LEVELONE_OPTIONS', command: 'ADD', parameters: { keys: 'B' } });
  await settle();
  assert.equal(second.sent.flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .filter((request) => request.command === 'ADD').length, 0);

  second.respond(response(replay));
  await settle();
  const addRequest = second.sent.flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .find((request) => request.command === 'ADD');
  assert.ok(addRequest);
  second.respond(response(addRequest));
  await add;
  client.disconnect();
});

test('replays one canonical SUBS after reconnect when a service queue is pending', async () => {
  const { client, sockets } = await connected({ autoReconnect: true, timeoutMs: 200 });
  const first = sockets[0]!;
  const initial = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'A', fields: '0' } });
  await settle();
  const initialRequest = (first.sent.at(-1)!.requests as Array<Record<string, unknown>>)[0]!;
  first.respond(response(initialRequest));
  await initial;

  first.drop();
  const second = await waitForSocket(sockets, 1);
  const pendingQueue = deferred();
  (client as unknown as { serviceQueues: Map<string, Promise<void>> }).serviceQueues
    .set('LEVELONE_OPTIONS', pendingQueue.promise);
  second.open();
  const login = (second.sent[0]!.requests as Array<Record<string, unknown>>)[0]!;
  const ready = client.waitForReady({ timeoutMs: 200 });
  second.respond(response(login));
  await settle();
  assert.equal(second.sent.flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .filter((request) => request.command === 'SUBS').length, 0);

  pendingQueue.resolve();
  await settle();
  const replays = second.sent.flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .filter((request) => request.command === 'SUBS');
  assert.equal(replays.length, 1);
  assert.deepEqual(replays[0]?.parameters, { fields: '0', keys: 'A' });
  second.respond(response(replays[0]!));
  await ready;
  client.disconnect();
});

test('rolls back explicit rejection but force-reconciles retained canonical state after ACK loss', async () => {
  const { client, sockets } = await connected({ timeoutMs: 15, autoReconnect: false });
  const socket = sockets[0]!;

  const rejected = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'A' } });
  await settle();
  const rejectedRequest = (socket.sent.at(-1)!.requests as Array<Record<string, unknown>>)[0]!;
  socket.respond(response(rejectedRequest, 22, 'already subscribed'));
  await assert.rejects(rejected, (error: unknown) => error instanceof StreamerCommandError && error.code === 22);

  const timedOut = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'B' } });
  await settle();
  const lostAckRequest = (socket.sent.at(-1)!.requests as Array<Record<string, unknown>>)[0]!;
  assert.equal(lostAckRequest.command, 'SUBS');
  await assert.rejects(timedOut, (error: unknown) => error instanceof StreamerCommandTimeoutError);
  const reconnect = await waitForSocket(sockets, 1);
  reconnect.open();
  const login = (reconnect.sent[0]!.requests as Array<Record<string, unknown>>)[0]!;
  const ready = client.waitForReady({ timeoutMs: 100 });
  reconnect.respond(response(login));
  await settle();
  const replays = reconnect.sent.flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .filter((request) => request.command === 'SUBS');
  assert.equal(replays.length, 1);
  assert.deepEqual(replays[0]?.parameters, { keys: 'B' });
  reconnect.respond(response(replays[0]!));
  await ready;
  client.disconnect();
});

test('does not send a queued user command before reconciling an unknown ACK outcome', async () => {
  const { client, sockets } = await connected({ timeoutMs: 15, autoReconnect: false });
  const socket = sockets[0]!;
  socket.deferTerminate = true;

  const first = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'A' } });
  await settle();
  const firstRequest = (socket.sent.at(-1)!.requests as Array<Record<string, unknown>>)[0]!;
  assert.equal(firstRequest.command, 'SUBS');

  const queued = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'B' } });
  await assert.rejects(first, (error: unknown) => error instanceof StreamerCommandTimeoutError);
  await assert.rejects(queued, (error: unknown) => error instanceof StreamerCommandNotSentError);
  const firstSocketSubscriptions = socket.sent
    .flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .filter((request) => request.service === 'LEVELONE_OPTIONS');
  assert.equal(firstSocketSubscriptions.length, 1);
  assert.deepEqual(firstSocketSubscriptions[0]?.parameters, { keys: 'A' });

  socket.drop();
  const reconnect = await waitForSocket(sockets, 1);
  reconnect.open();
  const login = (reconnect.sent[0]!.requests as Array<Record<string, unknown>>)[0]!;
  const ready = client.waitForReady({ timeoutMs: 100 });
  reconnect.respond(response(login));
  await settle();
  const replays = reconnect.sent.flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .filter((request) => request.command === 'SUBS');
  assert.equal(replays.length, 1);
  assert.deepEqual(replays[0]?.parameters, { keys: 'A' });
  reconnect.respond(response(replays[0]!));
  await ready;
  client.disconnect();
});

test('rejects pending command on socket close and does not become ready on login rejection', async () => {
  const { client, sockets } = await connected({ timeoutMs: 40 });
  const socket = sockets[0]!;
  const pending = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'A' } });
  await settle();
  socket.drop();
  await assert.rejects(pending, (error: unknown) => error instanceof StreamerConnectionError);
  client.disconnect();

  const loginSockets: MockWebSocket[] = [];
  const loginClient = new StreamerClient({
    logger,
    commandAckTimeoutMs: 40,
    heartbeatCheckIntervalMs: 60_000,
    clientPingIntervalMs: 0,
    webSocketFactory: (url) => {
      const mock = new MockWebSocket(url);
      loginSockets.push(mock);
      return mock as never;
    },
  });
  const connecting = loginClient.connect('access-token', streamerInfo());
  await settle();
  const loginSocket = loginSockets[0]!;
  loginSocket.open();
  const loginRequest = (loginSocket.sent[0]!.requests as Array<Record<string, unknown>>)[0]!;
  const ready = loginClient.waitForReady({ timeoutMs: 40 });
  loginSocket.respond(response(loginRequest, 3, 'invalid credentials'));
  await assert.rejects(connecting, /invalid credentials/);
  await assert.rejects(ready, /invalid credentials/);
  assert.equal(loginClient.status, 'disconnected');
  loginClient.disconnect();
});

test('wraps synchronous socket.send failures as NotSent and rolls back canonical state', async () => {
  const { client, sockets } = await connected({ timeoutMs: 40, autoReconnect: false });
  const socket = sockets[0]!;
  socket.failNextSend = true;

  const pending = client.subscribe({ service: 'LEVELONE_OPTIONS', parameters: { keys: 'NOT_SENT' } });
  await assert.rejects(pending, (error: unknown) => error instanceof StreamerCommandNotSentError);

  const states = (client as unknown as {
    subscriptionStates: Map<string, { keys: Set<string> }>;
  }).subscriptionStates;
  assert.equal(states.has('LEVELONE_OPTIONS'), false);
  assert.equal(socket.sent.flatMap((frame) => frame.requests as Array<Record<string, unknown>>)
    .some((request) => request.command === 'SUBS' && (request.parameters as Record<string, unknown>)?.keys === 'NOT_SENT'), false);
  client.disconnect();
});
