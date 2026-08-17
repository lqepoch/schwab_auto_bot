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

test("OAuth callback input buffers multiple stream chunks until the complete line arrives", async () => {
  const input = new PassThrough() as PassThrough & { unref?: () => void };
  let unrefCalls = 0;
  input.unref = () => { unrefCalls += 1; };
  const callback = readCallbackUrl(input, { write: () => true });

  input.write("https://127.0.0.1/?code=chunk");
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("ed&state=expected");
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.end("\nignored-second-line\n");

  assert.equal(await callback, "https://127.0.0.1/?code=chunked&state=expected");
  assert.equal(unrefCalls, 1);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("error"), 0);
  assert.equal(input.listenerCount("end"), 0);
});

test("OAuth callback input accepts EOF as a line boundary but rejects blank input", async () => {
  const eofInput = new PassThrough();
  const eofCallback = readCallbackUrl(eofInput, { write: () => true });
  eofInput.end("https://127.0.0.1/?code=eof&state=expected");
  assert.equal(await eofCallback, "https://127.0.0.1/?code=eof&state=expected");

  const blankInput = new PassThrough();
  const blankCallback = readCallbackUrl(blankInput, { write: () => true });
  blankInput.end("   \r\n");
  await assert.rejects(blankCallback, /AUTH_CALLBACK_URL_EMPTY/);
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
