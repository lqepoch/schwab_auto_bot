import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function runAuthScript(authPath: string, source: string): Promise<string> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SCHWAB_BOT_AUTH_FILE: authPath,
      SCHWAB_APP_KEY: "client-id",
      SCHWAB_APP_SECRET: "client-secret",
      SCHWAB_CALLBACK_URL: "https://127.0.0.1/callback",
    },
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

function authFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://127.0.0.1/callback",
    token: {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    ...overrides,
  };
}

test("rejects corrupt, blank, and invalid-date auth files before making a token request", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "auth.json");
  try {
    for (const value of [
      "not-json",
      authFile({ clientSecret: "" }),
      authFile({ token: { ...authFile().token as object, accessExpiresAt: "not-a-date" } }),
    ]) {
      await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
      const output = await runAuthScript(path, `
        globalThis.fetch = async () => { console.log("FETCH_CALLED"); return new Response("{}", { status: 200 }); };
        const { SchwabTokenProvider } = await import("./src/automation/auth/provider.ts");
        try { await new SchwabTokenProvider(() => undefined).get(); }
        catch (error) { console.log("ERROR=" + (error instanceof Error ? error.message : String(error))); }
      `);
      assert.match(output, /ERROR=AUTH_FILE_INVALID/);
      assert.equal(output.includes("FETCH_CALLED"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shares concurrent refreshes and a force request cannot be weakened by an in-flight cache read", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "auth.json");
  try {
    await writeFile(path, JSON.stringify(authFile()), "utf8");
    const output = await runAuthScript(path, `
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const body = String(init.body);
        if (!body.includes("grant_type=refresh_token")) throw new Error("WRONG_GRANT");
        return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800, refresh_expires_in: 86400 }), { status: 200 });
      };
      const { SchwabTokenProvider } = await import("./src/automation/auth/provider.ts");
      const provider = new SchwabTokenProvider(() => undefined);
      const cached = await provider.get();
      const regular = provider.get(false);
      const forced = provider.get(true);
      const values = await Promise.all([regular, forced]);
      const concurrent = await Promise.all([provider.get(true), provider.get(true)]);
      console.log(JSON.stringify({ calls, cached, values, concurrent }));
    `);
    const result = JSON.parse(output.trim().split("\n").at(-1) as string);
    assert.equal(result.cached, "old-access-token");
    assert.deepEqual(result.values, ["old-access-token", "new-access"]);
    assert.deepEqual(result.concurrent, ["new-access", "new-access"]);
    assert.equal(result.calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects callback state, origin, path, and malformed URL mismatches without token exchange", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "auth.json");
  try {
    const output = await runAuthScript(path, `
      let calls = 0;
      globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 200 }); };
      const { login } = await import("./src/automation/auth/provider.ts");
      for (const callback of [
        "https://127.0.0.1/callback?code=x&state=wrong",
        "https://localhost/callback?code=x&state=state",
        "https://127.0.0.1/other?code=x&state=state",
        "not-a-url",
      ]) {
        try { await login(callback, "state"); console.log("ACCEPTED"); }
        catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
      }
      console.log("CALLS=" + calls);
    `);
    assert.equal((output.match(/AUTH_CALLBACK_INVALID/g) ?? []).length, 4);
    assert.match(output, /CALLS=0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("login atomically saves a private auth file and does not print credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "nested", "auth.json");
  try {
    const output = await runAuthScript(path, `
      globalThis.fetch = async (_url, init) => {
        const headers = new Headers(init.headers);
        const form = String(init.body);
        console.log(JSON.stringify({ method: init.method, hasBasic: headers.get("authorization")?.startsWith("Basic "), formHasCode: form.includes("code=auth-code"), formHasRedirect: form.includes("redirect_uri=https%3A%2F%2F127.0.0.1%2Fcallback") }));
        return new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 1800, refresh_expires_in: 86400 }), { status: 200 });
      };
      const { login } = await import("./src/automation/auth/provider.ts");
      await login("https://127.0.0.1/callback?code=auth-code&state=expected", "expected");
      console.log("DONE");
    `);
    assert.match(output, /DONE/);
    assert.equal(output.includes("access-secret"), false);
    assert.equal(output.includes("refresh-secret"), false);
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
    const parentMode = (await stat(dirname(path))).mode & 0o777;
    assert.equal(parentMode, 0o700);
    assert.deepEqual(await readdir(dirname(path)), ["auth.json"]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.token.accessToken, "access-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh failure remains structured and reports no token or secret material", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "auth.json");
  try {
    await writeFile(path, JSON.stringify(authFile({ token: {
      accessToken: "expired-access",
      refreshToken: "refresh-secret",
      accessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } })), "utf8");
    const output = await runAuthScript(path, `
      globalThis.fetch = async () => new Response("denied", { status: 401 });
      const { SchwabTokenProvider } = await import("./src/automation/auth/provider.ts");
      try { await new SchwabTokenProvider((message) => console.log("REPORT=" + message)).get(); }
      catch (error) { console.log("ERROR=" + (error instanceof Error ? error.message : String(error))); }
    `);
    assert.match(output, /ERROR=AUTH_HTTP_401/);
    assert.equal(output.includes("refresh-secret"), false);
    assert.equal(output.includes("client-secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired refresh credentials fail closed without calling the token endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "auth.json");
  try {
    await writeFile(path, JSON.stringify(authFile({ token: {
      accessToken: "expired-access",
      refreshToken: "expired-refresh",
      accessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    } })), "utf8");
    const output = await runAuthScript(path, `
      globalThis.fetch = async () => { console.log("FETCH_CALLED"); return new Response("{}", { status: 200 }); };
      const { SchwabTokenProvider } = await import("./src/automation/auth/provider.ts");
      try { await new SchwabTokenProvider(() => undefined).get(true); }
      catch (error) { console.log("ERROR=" + (error instanceof Error ? error.message : String(error))); }
    `);
    assert.match(output, /ERROR=AUTH_LOGIN_REQUIRED/);
    assert.equal(output.includes("FETCH_CALLED"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid refresh JSON is fail-closed and the token endpoint receives an abort signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "auth.json");
  try {
    await writeFile(path, JSON.stringify(authFile({ token: {
      accessToken: "expired-access",
      refreshToken: "refresh-token",
      accessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } })), "utf8");
    const output = await runAuthScript(path, `
      globalThis.fetch = async (_url, init) => {
        console.log(JSON.stringify({ method: init.method, hasAbortSignal: Boolean(init.signal), abortInitially: init.signal.aborted }));
        return new Response("not-json", { status: 200 });
      };
      const { SchwabTokenProvider } = await import("./src/automation/auth/provider.ts");
      try { await new SchwabTokenProvider(() => undefined).get(); }
      catch (error) { console.log("ERROR=" + (error instanceof Error ? error.message : String(error))); }
    `);
    assert.match(output, /"method":"POST","hasAbortSignal":true,"abortInitially":false/);
    assert.match(output, /ERROR=AUTH_TOKEN_RESPONSE_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("null or array token responses are rejected as invalid schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "auth.json");
  try {
    await writeFile(path, JSON.stringify(authFile({ token: {
      accessToken: "expired-access",
      refreshToken: "refresh-token",
      accessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } })), "utf8");
    for (const body of ["null", "[]"]) {
      const output = await runAuthScript(path, `
        globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: 200 });
        const { SchwabTokenProvider } = await import("./src/automation/auth/provider.ts");
        try { await new SchwabTokenProvider(() => undefined).get(); }
        catch (error) { console.log("ERROR=" + (error instanceof Error ? error.message : String(error))); }
      `);
      assert.match(output, /ERROR=AUTH_TOKEN_RESPONSE_INVALID/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh response without a new refresh token preserves the prior refresh credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "auth.json");
  try {
    const original = authFile({ token: {
      accessToken: "expired-access",
      refreshToken: "keep-refresh",
      accessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } });
    await writeFile(path, JSON.stringify(original), "utf8");
    await runAuthScript(path, `
      globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "new-access", expires_in: 1800 }), { status: 200 });
      const { SchwabTokenProvider } = await import("./src/automation/auth/provider.ts");
      console.log(await new SchwabTokenProvider(() => undefined).get());
    `);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.token.accessToken, "new-access");
    assert.equal(saved.token.refreshToken, "keep-refresh");
    assert.equal(saved.token.refreshExpiresAt, (original.token as Record<string, unknown>).refreshExpiresAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed atomic save removes its temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-auth-"));
  const path = join(root, "target-directory");
  try {
    await (await import("node:fs/promises")).mkdir(path);
    const output = await runAuthScript(path, `
      globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800, refresh_expires_in: 86400 }), { status: 200 });
      const { login } = await import("./src/automation/auth/provider.ts");
      try { await login("https://127.0.0.1/callback?code=code&state=state", "state"); }
      catch (error) { console.log("ERROR=" + (error instanceof Error ? error.code || error.message : String(error))); }
    `);
    assert.match(output, /ERROR=/);
    const names = await readdir(root);
    assert.deepEqual(names, ["target-directory"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
