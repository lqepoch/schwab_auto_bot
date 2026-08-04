import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { readCallbackUrl, runInteractiveLogin } from "../src/auth_cli.ts";

test("OAuth callback input releases the stdin handle after one pasted URL", async () => {
  const input = new PassThrough() as PassThrough & { unref?: () => void };
  let unrefCalls = 0;
  input.unref = () => { unrefCalls += 1; };
  let prompt = "";
  const output = {
    write(chunk: string): boolean {
      prompt += chunk;
      return true;
    },
  };

  const callback = readCallbackUrl(input, output);
  input.end("https://127.0.0.1/?code=test&state=test\r\n");

  assert.equal(await callback, "https://127.0.0.1/?code=test&state=test");
  assert.match(prompt, /回调 URL/);
  assert.equal(input.readableFlowing, false);
  assert.equal(unrefCalls, 1);
});

test("interactive login opens the authorization page and completes with the pasted callback", async () => {
  const calls: string[] = [];
  let output = "";

  await runInteractiveLogin({
    beginLogin: () => ({ state: "expected-state", authorizationUrl: "https://example.test/authorize" }),
    openBrowser: (url) => { calls.push(`browser:${url}`); },
    readCallbackUrl: async () => {
      calls.push("callback");
      return "https://127.0.0.1/?code=test&state=expected-state";
    },
    login: async (callbackUrl, state) => { calls.push(`login:${state}:${callbackUrl}`); },
    output: { write(chunk: string): boolean { output += chunk; return true; } },
  });

  assert.deepEqual(calls, [
    "browser:https://example.test/authorize",
    "callback",
    "login:expected-state:https://127.0.0.1/?code=test&state=expected-state",
  ]);
  assert.match(output, /OAuth/);
  assert.match(output, /Token/);
});
