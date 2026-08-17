import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { readCallbackUrl, runInteractiveLogin } from "../src/automation/auth/cli.ts";

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
  assert.match(output, /OAuth 授权地址: https:\/\/example\.test\/authorize/);
  assert.match(output, /默认浏览器/);
  assert.match(output, /Token/);
});

test("headless browser launch failure falls back to the printed authorization URL", async () => {
  const calls: string[] = [];
  let output = "";

  await runInteractiveLogin({
    beginLogin: () => ({ state: "headless-state", authorizationUrl: "https://example.test/headless" }),
    openBrowser: async (url) => {
      calls.push(`browser:${url}`);
      throw new Error("xdg-open unavailable");
    },
    readCallbackUrl: async () => {
      calls.push("callback");
      return "https://127.0.0.1/?code=headless&state=headless-state";
    },
    login: async (callbackUrl, state) => { calls.push(`login:${state}:${callbackUrl}`); },
    output: { write(chunk: string): boolean { output += chunk; return true; } },
  });

  assert.deepEqual(calls, [
    "browser:https://example.test/headless",
    "callback",
    "login:headless-state:https://127.0.0.1/?code=headless&state=headless-state",
  ]);
  assert.match(output, /OAuth 授权地址: https:\/\/example\.test\/headless/);
  assert.match(output, /自动打开浏览器失败/);
  assert.match(output, /手动打开/);
  assert.doesNotMatch(output, /xdg-open unavailable/);
});

test("interactive login waits for an asynchronous browser launcher before reading callback input", async () => {
  let releaseBrowser!: () => void;
  const browserReady = new Promise<void>((resolve) => { releaseBrowser = resolve; });
  const calls: string[] = [];

  const loginFlow = runInteractiveLogin({
    beginLogin: () => ({ state: "wait-state", authorizationUrl: "https://example.test/wait" }),
    openBrowser: async () => {
      calls.push("browser-start");
      await browserReady;
      calls.push("browser-ready");
    },
    readCallbackUrl: async () => {
      calls.push("callback");
      return "https://127.0.0.1/?code=wait&state=wait-state";
    },
    login: async () => { calls.push("login"); },
    output: { write(): boolean { return true; } },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["browser-start"]);
  releaseBrowser();
  await loginFlow;
  assert.deepEqual(calls, ["browser-start", "browser-ready", "callback", "login"]);
});
