import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function runSource(source: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  assert.equal(exitCode, 0, output);
  return output;
}

function authFile(): Record<string, unknown> {
  return {
    version: 1,
    clientId: "stored-client",
    clientSecret: "stored-secret",
    redirectUri: "https://127.0.0.1/stored",
    token: {
      accessToken: "injected-access",
      refreshToken: "injected-refresh",
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  };
}

test("token provider statePath injection wins over process environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-injection-"));
  const injectedPath = join(root, "injected.json");
  const processPath = join(root, "process.json");
  try {
    await writeFile(injectedPath, JSON.stringify(authFile()), "utf8");
    await writeFile(processPath, "not-json", "utf8");
    const output = await runSource(`
      const { SchwabTokenProvider, status } = await import("./src/automation/auth/provider.ts");
      const provider = new SchwabTokenProvider(() => undefined, { statePath: ${JSON.stringify(injectedPath)} });
      console.log("TOKEN=" + await provider.get());
      console.log("STATUS=" + JSON.stringify(await status({ statePath: ${JSON.stringify(injectedPath)} })));
    `, { SCHWAB_BOT_AUTH_FILE: processPath });
    assert.match(output, /TOKEN=injected-access/);
    assert.match(output, /"configured":true/);
    assert.doesNotMatch(output, /AUTH_FILE_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("login and beginLogin use injected env and state path without mutating process defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-injection-"));
  const injectedPath = join(root, "nested", "injected.json");
  const processPath = join(root, "process.json");
  const injectedEnv = {
    SCHWAB_APP_KEY: "injected-client",
    SCHWAB_APP_SECRET: "injected-secret",
    SCHWAB_CALLBACK_URL: "https://127.0.0.1/injected",
  };
  try {
    const output = await runSource(`
      globalThis.fetch = async (_url, init) => {
        const headers = new Headers(init.headers);
        const authorization = headers.get("authorization") ?? "";
        console.log("BASIC_OK=" + authorization.startsWith("Basic "));
        return new Response(JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 1800,
          refresh_expires_in: 86400,
        }), { status: 200 });
      };
      const { beginLogin, login } = await import("./src/automation/auth/provider.ts");
      const options = {
        env: ${JSON.stringify(injectedEnv)},
        statePath: ${JSON.stringify(injectedPath)},
      };
      const started = beginLogin(options);
      const url = new URL(started.authorizationUrl);
      console.log("CLIENT=" + url.searchParams.get("client_id"));
      console.log("REDIRECT=" + url.searchParams.get("redirect_uri"));
      await login("https://127.0.0.1/injected?code=auth-code&state=" + encodeURIComponent(started.state), started.state, options);
      console.log("DONE");
    `, {
      SCHWAB_BOT_AUTH_FILE: processPath,
      SCHWAB_APP_KEY: "process-client",
      SCHWAB_APP_SECRET: "process-secret",
      SCHWAB_CALLBACK_URL: "https://127.0.0.1/process",
    });
    assert.match(output, /CLIENT=injected-client/);
    assert.match(output, /REDIRECT=https:\/\/127\.0\.0\.1\/injected/);
    assert.match(output, /BASIC_OK=true/);
    assert.match(output, /DONE/);
    const saved = JSON.parse(await readFile(injectedPath, "utf8"));
    assert.equal(saved.clientId, "injected-client");
    assert.equal(saved.redirectUri, "https://127.0.0.1/injected");
    assert.equal((await stat(injectedPath)).mode & 0o777, 0o600);
    await assert.rejects(stat(processPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
