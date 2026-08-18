from pathlib import Path

coordinator_path = Path("src/automation/broker/writeCoordinator.ts")
text = coordinator_path.read_text()

old_union = '''    | "intent-persisted"
    | "accepted"
    | "rejected"
'''
new_union = '''    | "intent-persisted"
    | "acceptance-evidence-recovered"
    | "accepted"
    | "rejected"
'''
if text.count(old_union) != 1:
    raise SystemExit("broker event union patch point missing")
text = text.replace(old_union, new_union)

old_catch = '''    } catch (error) {
      const status = statusOf(error);
      const reason = reasonOf(error, status);
      if (status !== null && isExplicitBrokerRejection(status)) {
        await this.clearIntent(request, intent.id, status, "explicit-4xx");
        this.emitEvent({ event: "rejected", request, ledgerId: intent.id, status });
        throw new BrokerWriteRejectedError(request, status);
      }
      await this.persistUnknown(request, intent.id, status, reason);
      this.emitEvent({ event: "unknown", request, ledgerId: intent.id, status: status ?? undefined, reason });
      throw new UnknownOutcomeError(request, intent.id, reason, status, error);
    }
'''
new_catch = '''    } catch (error) {
      const recovered = recoverAcceptedMutationResponse(request, error);
      if (recovered) {
        response = recovered;
        this.emitEvent({
          event: "acceptance-evidence-recovered",
          request,
          ledgerId: intent.id,
          status: recovered.status,
          reason: "2xx-response-headers-after-body-read-failure",
        });
      } else {
        const status = statusOf(error);
        const reason = reasonOf(error, status);
        if (status !== null && isExplicitBrokerRejection(status)) {
          await this.clearIntent(request, intent.id, status, "explicit-4xx");
          this.emitEvent({ event: "rejected", request, ledgerId: intent.id, status });
          throw new BrokerWriteRejectedError(request, status);
        }
        await this.persistUnknown(request, intent.id, status, reason);
        this.emitEvent({ event: "unknown", request, ledgerId: intent.id, status: status ?? undefined, reason });
        throw new UnknownOutcomeError(request, intent.id, reason, status, error);
      }
    }
'''
if text.count(old_catch) != 1:
    raise SystemExit("broker transport catch patch point missing")
text = text.replace(old_catch, new_catch)

anchor = '''function statusOf(error: unknown): number | null {
'''
helper = '''function recoverAcceptedMutationResponse(
  request: BrokerWriteRequest,
  error: unknown,
): BrokerWriteResponse | null {
  if ((error as { isNetworkError?: unknown })?.isNetworkError !== true) return null;
  const status = statusOf(error);
  const headers = responseHeadersOf(error);

  // Schwab's Trader API contract defines successful DELETE cancellation as
  // HTTP 200 with an empty body. If body streaming fails after those response
  // headers arrived, the cancel is already conclusively accepted.
  if (request.method === "DELETE" && status === 200) {
    return { status, headers };
  }

  // Place/Replace success is HTTP 201 plus Location. Require both pieces of
  // broker evidence so a generic 2xx client-side error can never clear WAL.
  if ((request.method === "POST" || request.method === "PUT") && status === 201) {
    return locationOrderId(headers) === null ? null : { status, headers };
  }
  return null;
}

function responseHeadersOf(error: unknown): BrokerWriteResponse["headers"] {
  const value = (error as { headers?: unknown })?.headers;
  if (value instanceof Headers) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" || entry === undefined) headers[key] = entry;
  }
  return headers;
}

'''
if text.count(anchor) != 1:
    raise SystemExit("broker helper insertion point missing")
text = text.replace(anchor, helper + anchor)
coordinator_path.write_text(text)

# Extend focused coordinator tests with broker-contract acceptance evidence.
test_path = Path("test/broker_write_coordinator.test.ts")
text = test_path.read_text()
anchor_test = '''test("structured 2xx response-body read failure is unknown, never a safe retry", async () => {
'''
new_tests = '''test("201 plus valid Location recovers Place acceptance after response-body read failure", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  const events: string[] = [];
  transport.queue(Object.assign(new Error("response body read failed"), {
    status: 201,
    isNetworkError: true,
    headers: { location: "/trader/v1/accounts/hash/orders/98765" },
  }));
  const coordinator = new BrokerWriteCoordinator({
    ledger,
    transport,
    guards: { assertReady: () => undefined },
    emit: (event) => { events.push(event.event); },
  });
  const result = await coordinator.execute(baseRequest());
  assert.equal(result.status, 201);
  assert.equal(result.orderId, "98765");
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 0);
  assert.equal(events.includes("acceptance-evidence-recovered"), true);
  assert.equal(events.includes("accepted"), true);
});

test("201 plus valid Location recovers Replace acceptance after response-body read failure", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue(Object.assign(new Error("response body read failed"), {
    status: 201,
    isNetworkError: true,
    headers: new Headers({ location: "/trader/v1/accounts/hash/orders/76543" }),
  }));
  const request = baseRequest({
    method: "PUT",
    operation: "REPLACE_ORDER",
    path: "/trader/v1/accounts/hash/orders/12345",
    targetOrderId: "12345",
    targetOrder: { orderId: "12345", status: "WORKING" },
  });
  const result = await makeCoordinator(ledger, transport).execute(request);
  assert.equal(result.orderId, "76543");
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 0);
});

test("HTTP 200 recovers Cancel acceptance after response-body read failure", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue(Object.assign(new Error("response body read failed"), {
    status: 200,
    isNetworkError: true,
    headers: {},
  }));
  const request = baseRequest({
    method: "DELETE",
    operation: "CANCEL_ORDER",
    path: "/trader/v1/accounts/hash/orders/12345",
    payload: undefined,
    targetOrderId: "12345",
    targetOrder: { orderId: "12345", status: "WORKING" },
  });
  const result = await makeCoordinator(ledger, transport).execute(request);
  assert.equal(result.status, 200);
  assert.equal(result.orderId, null);
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 0);
});

test("2xx transport errors require exact broker acceptance evidence", async (t) => {
  const cases: Array<[string, Error]> = [
    ["201 missing Location", Object.assign(new Error("response body read failed"), {
      status: 201, isNetworkError: true, headers: {},
    })],
    ["201 malformed Location", Object.assign(new Error("response body read failed"), {
      status: 201, isNetworkError: true, headers: { location: "/not/orders/abc" },
    })],
    ["201 non-network error", Object.assign(new Error("future schema error"), {
      status: 201, isNetworkError: false, headers: { location: "/trader/v1/accounts/hash/orders/123" },
    })],
    ["200 on Place", Object.assign(new Error("response body read failed"), {
      status: 200, isNetworkError: true, headers: {},
    })],
  ];
  for (const [name, error] of cases) {
    await t.test(name, async () => {
      const ledger = new FakeLedger();
      const transport = new FakeTransport();
      transport.queue(error);
      await assert.rejects(
        () => makeCoordinator(ledger, transport).execute(baseRequest()),
        UnknownOutcomeError,
      );
      assert.equal(transport.attempts, 1);
      assert.equal(ledger.pendingCount, 1);
    });
  }
});

'''
if anchor_test not in text:
    raise SystemExit("2xx body-read test anchor missing")
if 'recovers Place acceptance after response-body read failure' not in text:
    text = text.replace(anchor_test, new_tests + anchor_test)
test_path.write_text(text)
