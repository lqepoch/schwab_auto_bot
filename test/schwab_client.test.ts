import assert from "node:assert/strict";
import test from "node:test";
import { SchwabApiError } from "../vendor/schwab-api-nodejs/src/utils/errors.ts";
import { SchwabRestClient } from "../src/schwab_client.ts";

test("SDK transport preserves the broker Location header and JSON request contract", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const client = new SchwabRestClient({
    fetch: async (url, init) => {
      observedUrl = String(url);
      observedInit = init;
      return new Response(JSON.stringify({ accepted: true }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          location: "/trader/v1/accounts/hash/orders/12345",
        },
      });
    },
  });

  const response = await client.request<{ accepted: boolean }>(
    "/trader/v1/accounts/hash/orders",
    { method: "POST", body: JSON.stringify({ orderType: "NET_DEBIT" }) },
    "access-token",
  );

  assert.equal(observedUrl, "https://api.schwabapi.com/trader/v1/accounts/hash/orders");
  assert.equal(new Headers(observedInit?.headers).get("authorization"), "Bearer access-token");
  assert.equal(new Headers(observedInit?.headers).get("content-type"), "application/json");
  assert.deepEqual(response.body, { accepted: true });
  assert.equal(response.headers.get("location"), "/trader/v1/accounts/hash/orders/12345");
  assert.equal(response.status, 201);
});

test("SDK transport makes exactly one broker attempt and retains structured errors", async () => {
  let calls = 0;
  const client = new SchwabRestClient({
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ errors: [{ detail: "retry later" }] }), {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(
    () => client.request("/trader/v1/accounts/accountNumbers", {}, "access-token"),
    (error: unknown) => error instanceof SchwabApiError && error.status === 503,
  );
  assert.equal(calls, 1);
});
