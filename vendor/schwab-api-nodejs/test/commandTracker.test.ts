import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StreamerCommandTracker,
} from '../dist/streamer/commandTracker.js';
import {
  StreamerCommandError,
  StreamerCommandTimeoutError,
} from '../dist/streamer/streamerErrors.js';
import {
  StreamerCommandResponseSchema,
  isSuccessfulStreamerCommand,
} from '../dist/types/streamer.js';

function response(command: string, code: number, requestid = '1') {
  return {
    service: 'LEVELONE_OPTIONS',
    command,
    requestid,
    timestamp: 1,
    content: { code, msg: 'OK' },
  };
}

test('accepts generic and command-specific Streamer success codes only for their command', () => {
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'SUBS', 0), true);
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'SUBS', 26), true);
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'UNSUBS', 27), true);
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'ADD', 28), true);
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'VIEW', 29), true);
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'SUBS', 27), false);
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'UNKNOWN', 0), true);
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'SUBS', NaN), false);
  assert.equal(isSuccessfulStreamerCommand('LEVELONE_OPTIONS', 'SUBS', 1.5), false);
});

test('response schema preserves numeric wire strings but rejects null and malformed codes', () => {
  const numericString = StreamerCommandResponseSchema.safeParse(response('SUBS', '26' as unknown as number));
  assert.equal(numericString.success, true);
  assert.equal(numericString.success && numericString.data.content.code, 26);
  for (const code of [null, '', '1.5', 1.5, NaN]) {
    const result = StreamerCommandResponseSchema.safeParse(response('SUBS', code as number));
    assert.equal(result.success, false, `code ${String(code)} must be rejected`);
  }
});

test('tracker resolves SUBS with Schwab command-specific success code', async () => {
  const tracker = new StreamerCommandTracker(100);
  const pending = tracker.track({ requestid: '1', service: 'LEVELONE_OPTIONS', command: 'SUBS', generation: 4 });

  assert.equal(tracker.handle(response('SUBS', 26), 4), true);
  await assert.doesNotReject(pending);
  assert.equal(tracker.size, 0);
});

test('tracker rejects an ACK with the wrong command-specific code', async () => {
  const tracker = new StreamerCommandTracker(100);
  const pending = tracker.track({ requestid: '1', service: 'LEVELONE_OPTIONS', command: 'SUBS', generation: 4 });

  assert.equal(tracker.handle(response('SUBS', 27), 4), true);
  await assert.rejects(pending, (error: unknown) => error instanceof StreamerCommandError && error.code === 27);
  assert.equal(tracker.size, 0);
});

test('stale generation and mismatched request metadata cannot resolve the current request', async () => {
  const tracker = new StreamerCommandTracker(100);
  const pending = tracker.track({ requestid: '1', service: 'LEVELONE_OPTIONS', command: 'SUBS', generation: 4 });

  assert.equal(tracker.handle(response('SUBS', 26), 3), false);
  assert.equal(tracker.handle({ ...response('ADD', 28), requestid: '1' }, 4), false);
  assert.equal(tracker.size, 1);
  assert.equal(tracker.handle(response('SUBS', 26), 4), true);
  await assert.doesNotReject(pending);
});

test('timeout removes the pending entry and rejects with command details', async () => {
  const tracker = new StreamerCommandTracker(5);
  const pending = tracker.track({ requestid: 'timeout', service: 'LEVELONE_OPTIONS', command: 'SUBS', generation: 1 });
  await assert.rejects(pending, (error: unknown) => error instanceof StreamerCommandTimeoutError
    && error.requestid === 'timeout'
    && error.timeoutMs === 5);
  assert.equal(tracker.size, 0);
});
