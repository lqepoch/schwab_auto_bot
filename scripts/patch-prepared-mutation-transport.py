from pathlib import Path

coordinator_path = Path("src/automation/broker/writeCoordinator.ts")
text = coordinator_path.read_text()

old_transport = '''export interface BrokerWriteTransport {
  send(request: BrokerWriteRequest): Promise<BrokerWriteResponse>;
}
'''
new_transport = '''export interface PreparedBrokerWriteTransport {
  /**
   * Start the physical mutation request immediately. All quota waits, token
   * refreshes, or other asynchronous admission work must complete in prepare().
   */
  send(): Promise<BrokerWriteResponse>;
}

export interface BrokerWriteTransport {
  /**
   * Complete every potentially blocking pre-send dependency before WAL fsync.
   * This keeps the post-WAL path to the physical transport attempt await-free
   * after its final stop/state validation.
   */
  prepare(request: BrokerWriteRequest): Promise<PreparedBrokerWriteTransport>;
}
'''
if text.count(old_transport) != 1:
    raise SystemExit("transport interface patch point missing")
text = text.replace(old_transport, new_transport)

old_preflight = '''    try {
      await this.guards.beforeFinalWrite?.(request);
      await request.validateFinal?.();
      await this.guards.assertReady(request);
    } catch (error) {
      this.emitEvent({ event: "blocked", request, reason: String(error) });
      throw error;
    }
    if (this.guards.isStopping?.()) {
      this.emitEvent({ event: "blocked", request, reason: "runtime-stopping" });
      throw new BrokerWriteStoppingError(request);
    }

    const intent = await this.persistIntent(request);
'''
new_preflight = '''    let preparedTransport: PreparedBrokerWriteTransport;
    try {
      await this.guards.beforeFinalWrite?.(request);
      await request.validateFinal?.();
      await this.guards.assertReady(request);
      preparedTransport = await this.transport.prepare(request);
      if (this.guards.isStopping?.()) throw new BrokerWriteStoppingError(request);
      // Admission/token preparation can wait. Revalidate once more before
      // creating durable intent state so the WAL describes a current request.
      await request.validateFinal?.();
      await this.guards.assertReady(request);
    } catch (error) {
      this.emitEvent({ event: "blocked", request, reason: String(error) });
      throw error;
    }
    if (this.guards.isStopping?.()) {
      this.emitEvent({ event: "blocked", request, reason: "runtime-stopping" });
      throw new BrokerWriteStoppingError(request);
    }

    const intent = await this.persistIntent(request);
'''
if text.count(old_preflight) != 1:
    raise SystemExit("preflight/prepare patch point missing")
text = text.replace(old_preflight, new_preflight)

old_send = '''      response = await this.transport.send(request);
'''
new_send = '''      response = await preparedTransport.send();
'''
if text.count(old_send) != 1:
    raise SystemExit("physical send patch point missing")
text = text.replace(old_send, new_send)
coordinator_path.write_text(text)

runtime_path = Path("src/automation/runtimeOrchestrator.ts")
text = runtime_path.read_text()

old_api = '''async function api(
  path: string,
  init: RequestInit = {},
  priority: Priority = 0,
): Promise<{ body: any; headers: Headers; status: number }> {
  await budget.admit(priority);
  const token = await tokens.get();
  try {
    const response = await client.request<any>(path, init, token);
    latestBrokerRateLimit = brokerRateLimitFromHeaders(response.headers);
    return response;
  } catch (error) {
    if (error instanceof SchwabApiError) {
      latestBrokerRateLimit = brokerRateLimitFromHeaders(error.headers);
      if (error.status === 429) budget.rateLimited(error.headers["retry-after"] ?? null);
      if (error.status === 401 && unauthorizedRefresh.schedule()) {
        executionJournal.record("auth.background-refresh-scheduled", { source: "broker-401" });
      }
      throw Object.assign(new Error(`SCHWAB_HTTP_${error.status}`), {
        status: error.status,
        statusText: error.statusText,
        headers: { ...error.headers },
        requestId: error.requestId,
        method: error.method ?? init.method ?? "GET",
        path,
        isNetworkError: error.isNetworkError === true,
        cause: error,
      });
    }
    throw error;
  }
}
'''
new_api = '''async function apiWithToken(
  path: string,
  init: RequestInit,
  token: string,
): Promise<{ body: any; headers: Headers; status: number }> {
  try {
    const response = await client.request<any>(path, init, token);
    latestBrokerRateLimit = brokerRateLimitFromHeaders(response.headers);
    return response;
  } catch (error) {
    if (error instanceof SchwabApiError) {
      latestBrokerRateLimit = brokerRateLimitFromHeaders(error.headers);
      if (error.status === 429) budget.rateLimited(error.headers["retry-after"] ?? null);
      if (error.status === 401 && unauthorizedRefresh.schedule()) {
        executionJournal.record("auth.background-refresh-scheduled", { source: "broker-401" });
      }
      throw Object.assign(new Error(`SCHWAB_HTTP_${error.status}`), {
        status: error.status,
        statusText: error.statusText,
        headers: { ...error.headers },
        requestId: error.requestId,
        method: error.method ?? init.method ?? "GET",
        path,
        isNetworkError: error.isNetworkError === true,
        cause: error,
      });
    }
    throw error;
  }
}

async function api(
  path: string,
  init: RequestInit = {},
  priority: Priority = 0,
): Promise<{ body: any; headers: Headers; status: number }> {
  await budget.admit(priority);
  const token = await tokens.get();
  return apiWithToken(path, init, token);
}
'''
if text.count(old_api) != 1:
    raise SystemExit("runtime api patch point missing")
text = text.replace(old_api, new_api)

old_transport_adapter = '''  transport: {
    send: async (request) => {
      const body = request.payload === undefined ? undefined : JSON.stringify(request.payload);
      const response = await api(request.path, {
        method: request.method,
        ...(body === undefined ? {} : { body }),
      }, request.transportPriority ?? 0);
      return { status: response.status, headers: response.headers };
    },
  },
'''
new_transport_adapter = '''  transport: {
    prepare: async (request) => {
      // Reserve quota and obtain a token before WAL fsync. Conservative unused
      // reservations are acceptable; waiting after WAL would reopen a stop/
      // state-change race before the actual network request starts.
      await budget.admit(request.transportPriority ?? 0);
      const token = await tokens.get();
      const body = request.payload === undefined ? undefined : JSON.stringify(request.payload);
      const init: RequestInit = {
        method: request.method,
        ...(body === undefined ? {} : { body }),
      };
      return {
        send: async () => {
          const response = await apiWithToken(request.path, init, token);
          return { status: response.status, headers: response.headers };
        },
      };
    },
  },
'''
if text.count(old_transport_adapter) != 1:
    raise SystemExit("runtime transport adapter patch point missing")
text = text.replace(old_transport_adapter, new_transport_adapter)
runtime_path.write_text(text)

# Existing broker coordinator unit-test transport adapter.
test_path = Path("test/broker_write_coordinator.test.ts")
text = test_path.read_text()
old_fake_transport = '''class FakeTransport {
  attempts = 0;
  private readonly outcomes: Outcome[];

  constructor(outcomes: Outcome[]) {
    this.outcomes = outcomes;
  }

  async send(_request: BrokerWriteRequest): Promise<BrokerWriteResponse> {
    this.attempts += 1;
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error("no outcome configured");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}
'''
new_fake_transport = '''class FakeTransport {
  attempts = 0;
  preparations = 0;
  private readonly outcomes: Outcome[];

  constructor(outcomes: Outcome[]) {
    this.outcomes = outcomes;
  }

  async prepare(_request: BrokerWriteRequest) {
    this.preparations += 1;
    return {
      send: async (): Promise<BrokerWriteResponse> => {
        this.attempts += 1;
        const outcome = this.outcomes.shift();
        if (!outcome) throw new Error("no outcome configured");
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
  }
}
'''
if text.count(old_fake_transport) != 1:
    raise SystemExit("FakeTransport patch point missing")
text = text.replace(old_fake_transport, new_fake_transport)
test_path.write_text(text)

post_test_path = Path("test/broker_write_post_intent_guard.test.ts")
text = post_test_path.read_text()
old_counting = '''class CountingTransport {
  attempts = 0;

  async send(_request: BrokerWriteRequest): Promise<BrokerWriteResponse> {
    this.attempts += 1;
    return {
      status: 201,
      headers: new Headers({ location: "/trader/v1/accounts/hash/orders/12345" }),
    };
  }
}
'''
new_counting = '''class CountingTransport {
  attempts = 0;
  preparations = 0;
  prepareWait: Promise<void> | null = null;

  async prepare(_request: BrokerWriteRequest) {
    this.preparations += 1;
    if (this.prepareWait) await this.prepareWait;
    return {
      send: async (): Promise<BrokerWriteResponse> => {
        this.attempts += 1;
        return {
          status: 201,
          headers: new Headers({ location: "/trader/v1/accounts/hash/orders/12345" }),
        };
      },
    };
  }
}
'''
if text.count(old_counting) != 1:
    raise SystemExit("CountingTransport patch point missing")
text = text.replace(old_counting, new_counting)

append_tests = '''

test("a stop arriving during quota/token preparation prevents WAL creation and broker transport", async () => {
  const ledger = new DeferredLedger();
  const transport = new CountingTransport();
  const state = { stopping: false };
  let releasePrepare!: () => void;
  transport.prepareWait = new Promise<void>((resolve) => { releasePrepare = resolve; });

  const pending = coordinator(ledger, transport, state).execute(request());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(transport.preparations, 1);
  state.stopping = true;
  releasePrepare();

  await assert.rejects(pending, BrokerWriteStoppingError);
  assert.equal(transport.attempts, 0);
  assert.equal(ledger.records.size, 0);
  assert.equal(ledger.discardCount, 0);
});

test("request validation is refreshed after transport preparation before WAL persistence", async () => {
  const ledger = new DeferredLedger();
  const transport = new CountingTransport();
  const state = { stopping: false };
  let releasePrepare!: () => void;
  transport.prepareWait = new Promise<void>((resolve) => { releasePrepare = resolve; });
  let targetWorking = true;
  let validations = 0;

  const pending = coordinator(ledger, transport, state).execute(request({
    validateFinal: () => {
      validations += 1;
      if (!targetWorking) throw new Error("TARGET_CHANGED_DURING_TRANSPORT_PREPARE");
    },
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  targetWorking = false;
  releasePrepare();

  await assert.rejects(pending, /TARGET_CHANGED_DURING_TRANSPORT_PREPARE/);
  assert.equal(validations, 2);
  assert.equal(transport.attempts, 0);
  assert.equal(ledger.records.size, 0);
});
'''
if 'TARGET_CHANGED_DURING_TRANSPORT_PREPARE' not in text:
    text += append_tests
post_test_path.write_text(text)
