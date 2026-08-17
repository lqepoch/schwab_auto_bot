import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defaultAutomationAuthStatePath } from "../repositoryPaths.ts";
import { TokenManager } from "../../auth/tokenManager.ts";
import type { TokenStoreAdapter } from "../../auth/tokenStore.ts";
import type { PersistedToken, SchwabAuthConfig } from "../../types/auth.ts";
import { ReauthRequiredError } from "../../utils/errors.ts";
import { atomicWriteJson } from "../../utils/atomicJson.ts";

const weeklyReauthorizationFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type AutomationAuthOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  statePath?: string;
}>;

function authEnvironment(options: AutomationAuthOptions = {}): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function authStatePath(options: AutomationAuthOptions = {}): string {
  const env = authEnvironment(options);
  return options.statePath || env.SCHWAB_BOT_AUTH_FILE || defaultAutomationAuthStatePath(import.meta.url);
}

type Token = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

type AuthFile = {
  version: 1;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  token: Token;
  reauthorizedAt?: string;
  reauthorizationWeek?: string;
};

type Credentials = Pick<AuthFile, "clientId" | "clientSecret" | "redirectUri">;

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

async function load(statePath: string): Promise<AuthFile | null> {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8")) as Partial<AuthFile>;
    const token = value.token as Partial<Token> | undefined;
    if (
      value.version !== 1 ||
      !value.clientId?.trim() ||
      !value.clientSecret?.trim() ||
      !value.redirectUri?.trim() ||
      !token ||
      !token.accessToken?.trim() ||
      !token.refreshToken?.trim() ||
      !validTimestamp(token.accessExpiresAt) ||
      !validTimestamp(token.refreshExpiresAt)
    ) throw new Error("AUTH_FILE_INVALID");
    if (value.reauthorizedAt !== undefined && typeof value.reauthorizedAt !== "string") throw new Error("AUTH_FILE_INVALID");
    if (value.reauthorizationWeek !== undefined && typeof value.reauthorizationWeek !== "string") throw new Error("AUTH_FILE_INVALID");
    return value as AuthFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "AUTH_FILE_INVALID") throw error;
    throw new Error("AUTH_FILE_INVALID", { cause: error });
  }
}

async function save(statePath: string, value: AuthFile): Promise<void> {
  await atomicWriteJson(statePath, value, { directoryMode: 0o700, fileMode: 0o600, pretty: true });
}

function environmentCredentials(options: AutomationAuthOptions = {}): Credentials {
  const env = authEnvironment(options);
  const clientId = requiredString(env.SCHWAB_APP_KEY || env.SCHWAB_CLIENT_ID, "AUTH_APP_KEY_MISSING");
  const clientSecret = requiredString(env.SCHWAB_APP_SECRET || env.SCHWAB_CLIENT_SECRET, "AUTH_APP_SECRET_MISSING");
  const redirectUri = requiredString(env.SCHWAB_CALLBACK_URL || env.SCHWAB_REDIRECT_URI || "https://127.0.0.1", "AUTH_REDIRECT_URI_MISSING");
  return { clientId, clientSecret, redirectUri };
}

function authConfig(credentials: Credentials): SchwabAuthConfig {
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: credentials.redirectUri,
    tokenSafetyWindowMs: 90_000,
  };
}

/**
 * Compatibility adapter for the production v1 auth file. OAuth transport,
 * validation, invalid_grant handling and refresh single-flight are owned by
 * TokenManager. This boundary only translates the approved on-disk schema and
 * preserves weekly reauthorization metadata.
 */
class AutomationAuthStore implements TokenStoreAdapter {
  readonly path: string;
  private readonly credentials: Credentials | undefined;
  private readonly markReauthorized: boolean;

  constructor(statePath: string, credentials?: Credentials, markReauthorized = false) {
    this.path = statePath;
    this.credentials = credentials;
    this.markReauthorized = markReauthorized;
  }

  async load(): Promise<unknown | null> {
    const auth = await load(this.path);
    if (!auth) return null;
    if (Date.parse(auth.token.refreshExpiresAt) <= Date.now()) return null;
    const accessExpiresAt = Date.parse(auth.token.accessExpiresAt);
    const refreshExpiresAt = Date.parse(auth.token.refreshExpiresAt);
    return {
      access_token: auth.token.accessToken,
      refresh_token: auth.token.refreshToken,
      expires_in: Math.max(1, Math.ceil((accessExpiresAt - Date.now()) / 1_000)),
      refresh_expires_in: Math.max(1, Math.ceil((refreshExpiresAt - Date.now()) / 1_000)),
      token_type: "Bearer",
      obtained_at: Math.min(Date.now(), accessExpiresAt - 1),
      expires_at: accessExpiresAt,
    } satisfies PersistedToken;
  }

  async save(token: PersistedToken): Promise<void> {
    const current = await load(this.path);
    const credentials: Credentials | undefined = current ?? this.credentials;
    if (!credentials) throw new Error("AUTH_APP_CREDENTIALS_MISSING");
    const refreshRotated = current?.token.refreshToken !== token.refresh_token;
    const refreshExpiresAt = token.refresh_expires_in !== undefined && (refreshRotated || !current)
      ? new Date(Date.now() + token.refresh_expires_in * 1_000).toISOString()
      : current?.token.refreshExpiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    const value: AuthFile = {
      version: 1,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      redirectUri: credentials.redirectUri,
      token: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        accessExpiresAt: new Date(token.expires_at).toISOString(),
        refreshExpiresAt,
      },
      reauthorizedAt: this.markReauthorized ? new Date().toISOString() : current?.reauthorizedAt,
      reauthorizationWeek: this.markReauthorized ? weeklyReauthorizationWeek() : current?.reauthorizationWeek,
    };
    await save(this.path, value);
  }
}

function manager(credentials: Credentials, store: TokenStoreAdapter): TokenManager {
  return new TokenManager(authConfig(credentials), store, { safetyWindowMs: 90_000 });
}

function compatibilityError(error: unknown): Error {
  if (error instanceof ReauthRequiredError) return new Error("AUTH_LOGIN_REQUIRED", { cause: error });
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return new Error("AUTH_TOKEN_RESPONSE_INVALID", { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/Schwab token request failed:\s*(\d{3})/i)?.[1];
  if (status) return new Error(`AUTH_HTTP_${status}`, { cause: error });
  if (message.includes("refresh response omitted refresh_token")) {
    return new Error("AUTH_TOKEN_RESPONSE_INVALID", { cause: error });
  }
  return error instanceof Error ? error : new Error(message);
}

export type AuthStatus = {
  configured: boolean;
  tokenPresent: boolean;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  reauthorizedAt: string | null;
  weeklyReauthRequired: boolean;
  reauthorizationWeek: string;
  storage: "plain-json";
};

export class SchwabTokenProvider {
  private pending: Promise<string> | null = null;
  private pendingForce = false;
  private readonly report: (message: string) => void;
  private readonly statePath: string;

  constructor(report: (message: string) => void, options: AutomationAuthOptions = {}) {
    this.report = report;
    this.statePath = authStatePath(options);
  }

  async get(force = false): Promise<string> {
    if (this.pending) {
      if (!force || this.pendingForce) return this.pending;
      await this.pending;
      return this.get(true);
    }
    this.pendingForce = force;
    const pending = this.resolve(force).finally(() => {
      if (this.pending === pending) {
        this.pending = null;
        this.pendingForce = false;
      }
    });
    this.pending = pending;
    return pending;
  }

  private async resolve(force: boolean): Promise<string> {
    const auth = await load(this.statePath);
    if (!auth || Date.parse(auth.token.refreshExpiresAt) <= Date.now()) throw new Error("AUTH_LOGIN_REQUIRED");
    const tokenManager = manager(auth, new AutomationAuthStore(this.statePath));
    const needsRefresh = force || Date.parse(auth.token.accessExpiresAt) <= Date.now() + 90_000;
    try {
      const token = needsRefresh
        ? await tokenManager.refreshAccessToken(auth.token.refreshToken)
        : await tokenManager.requireAccessToken();
      if (needsRefresh || token.access_token !== auth.token.accessToken) {
        this.report(`Schwab Node OAuth token 已刷新 expiresAt=${new Date(token.expires_at).toISOString()}`);
      }
      return token.access_token;
    } catch (error) {
      throw compatibilityError(error);
    }
  }
}

export async function status(options: AutomationAuthOptions = {}): Promise<AuthStatus> {
  const auth = await load(authStatePath(options));
  const reauthorizationWeek = weeklyReauthorizationWeek();
  return {
    configured: auth !== null,
    tokenPresent: auth !== null,
    accessExpiresAt: auth?.token.accessExpiresAt ?? null,
    refreshExpiresAt: auth?.token.refreshExpiresAt ?? null,
    reauthorizedAt: auth?.reauthorizedAt ?? null,
    weeklyReauthRequired: auth?.reauthorizationWeek !== reauthorizationWeek,
    reauthorizationWeek,
    storage: "plain-json",
  };
}

export async function requireWeeklyReauthorization(
  now = new Date(),
  options: AutomationAuthOptions = {},
): Promise<void> {
  const auth = await load(authStatePath(options));
  if (!auth || auth.reauthorizationWeek !== weeklyReauthorizationWeek(now)) {
    throw new Error("AUTH_WEEKLY_REAUTH_REQUIRED");
  }
}

export async function login(
  callbackUrl: string,
  state: string,
  options: AutomationAuthOptions = {},
): Promise<void> {
  const credentials = environmentCredentials(options);
  const statePath = authStatePath(options);
  const redirect = new URL(credentials.redirectUri);
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch (error) {
    throw new Error("AUTH_CALLBACK_INVALID", { cause: error });
  }
  if (
    callback.origin !== redirect.origin
    || callback.pathname !== redirect.pathname
    || callback.searchParams.get("state") !== state
  ) throw new Error("AUTH_CALLBACK_INVALID");
  const code = requiredString(callback.searchParams.get("code"), "AUTH_CALLBACK_INVALID");
  try {
    await manager(credentials, new AutomationAuthStore(statePath, credentials, true)).exchangeCodeForToken(code);
  } catch (error) {
    throw compatibilityError(error);
  }
}

export function beginLogin(options: AutomationAuthOptions = {}): { state: string; authorizationUrl: string } {
  const credentials = environmentCredentials(options);
  const statePath = authStatePath(options);
  const state = randomUUID();
  return {
    state,
    authorizationUrl: manager(credentials, new AutomationAuthStore(statePath, credentials, true)).createAuthorizeUrl({ state }),
  };
}

export function weeklyReauthorizationWeek(now = new Date()): string {
  const parts = Object.fromEntries(weeklyReauthorizationFormatter
    .formatToParts(now)
    .map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  if (weekday < 0) throw new Error("AUTH_REAUTH_CLOCK_INVALID");
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  let daysSinceMonday = (weekday + 6) % 7;
  if (weekday === 1 && Number(parts.hour) * 60 + Number(parts.minute) < 6 * 60) daysSinceMonday = 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday);
  return localDate.toISOString().slice(0, 10);
}
