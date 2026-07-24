import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { readCallbackUrl } from "../src/auth_cli.ts";

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
