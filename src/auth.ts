import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const statePath = process.env.SCHWAB_BOT_AUTH_FILE || join(root, "state", "schwab-auth.json");
const authorizeUrl = "https://api.schwabapi.com/v1/oauth/authorize";
const tokenUrl = "https://api.schwabapi.com/v1/oauth/token";

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

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_expires_in?: unknown;
};

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function boundedSeconds(value: unknown, fallback: number, code: string): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 31 * 24 * 60 * 60) {
    throw new Error(code);
  }
  return value as number;
}

function fromResponse(response: TokenResponse, prior?: Token): Token {
  const now = Date.now();
  const accessSeconds = boundedSeconds(response.expires_in, 1_800, "AUTH_TOKEN_RESPONSE_INVALID");
  const receivedRefresh = response.refresh_token === undefined
    ? prior?.refreshToken
    : requiredString(response.refresh_token, "AUTH_TOKEN_RESPONSE_INVALID");
  if (!receivedRefresh) throw new Error("AUTH_TOKEN_RESPONSE_INVALID");
  const refreshSeconds = boundedSeconds(response.refresh_expires_in, 7 * 24 * 60 * 60, "AUTH_TOKEN_RESPONSE_INVALID");
  return {
    accessToken: requiredString(response.access_token, "AUTH_TOKEN_RESPONSE_INVALID"),
    refreshToken: receivedRefresh,
    accessExpiresAt: new Date(now + accessSeconds * 1_000).toISOString(),
    refreshExpiresAt: response.refresh_token === undefined && prior
      ? prior.refreshExpiresAt
      : new Date(now + refreshSeconds * 1_000).toISOString(),
  };
}

async function load(): Promise<AuthFile | null> {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8")) as Partial<AuthFile>;
    if (
      value.version !== 1 ||
      typeof value.clientId !== "string" ||
      typeof value.clientSecret !== "string" ||
      typeof value.redirectUri !== "string" ||
      !value.token ||
      typeof value.token.accessToken !== "string" ||
      typeof value.token.refreshToken !== "string" ||
      typeof value.token.accessExpiresAt !== "string" ||
      typeof value.token.refreshExpiresAt !== "string"
    ) throw new Error("AUTH_FILE_INVALID");
    if (value.reauthorizedAt !== undefined && typeof value.reauthorizedAt !== "string") throw new Error("AUTH_FILE_INVALID");
    if (value.reauthorizationWeek !== undefined && typeof value.reauthorizationWeek !== "string") throw new Error("AUTH_FILE_INVALID");
    return value as AuthFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function save(value: AuthFile): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, statePath);
}

async function requestToken(
  credentials: Pick<AuthFile, "clientId" | "clientSecret">,
  form: URLSearchParams,
): Promise<TokenResponse> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`AUTH_HTTP_${response.status}`);
  return await response.json() as TokenResponse;
}

function environmentCredentials(): Pick<AuthFile, "clientId" | "clientSecret" | "redirectUri"> {
  const clientId = requiredString(process.env.SCHWAB_APP_KEY || process.env.SCHWAB_CLIENT_ID, "AUTH_APP_KEY_MISSING");
  const clientSecret = requiredString(process.env.SCHWAB_APP_SECRET || process.env.SCHWAB_CLIENT_SECRET, "AUTH_APP_SECRET_MISSING");
  const redirectUri = requiredString(process.env.SCHWAB_CALLBACK_URL || process.env.SCHWAB_REDIRECT_URI || "https://127.0.0.1", "AUTH_REDIRECT_URI_MISSING");
  return { clientId, clientSecret, redirectUri };
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
  private cached: AuthFile | null = null;
  private pending: Promise<string> | null = null;
  private readonly report: (message: string) => void;

  constructor(report: (message: string) => void) {
    this.report = report;
  }

  async get(force = false): Promise<string> {
    if (!this.pending) this.pending = this.resolve(force).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async resolve(force: boolean): Promise<string> {
    const auth = this.cached || await load();
    if (!auth) throw new Error("AUTH_LOGIN_REQUIRED");
    if (Date.parse(auth.token.refreshExpiresAt) <= Date.now()) throw new Error("AUTH_LOGIN_REQUIRED");
    if (!force && Date.parse(auth.token.accessExpiresAt) - Date.now() > 90_000) return auth.token.accessToken;
    const refreshed = fromResponse(await requestToken(auth, new URLSearchParams({
      grant_type: "refresh_token", refresh_token: auth.token.refreshToken,
    })), auth.token);
    this.cached = { ...auth, token: refreshed };
    await save(this.cached);
    this.report(`Schwab Node OAuth token 已刷新 expiresAt=${refreshed.accessExpiresAt}`);
    return refreshed.accessToken;
  }
}

export async function status(): Promise<AuthStatus> {
  const auth = await load();
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

export async function requireWeeklyReauthorization(now = new Date()): Promise<void> {
  const auth = await load();
  if (!auth || auth.reauthorizationWeek !== weeklyReauthorizationWeek(now)) {
    throw new Error("AUTH_WEEKLY_REAUTH_REQUIRED");
  }
}

export async function login(callbackUrl: string, state: string): Promise<void> {
  const credentials = environmentCredentials();
  const callback = new URL(callbackUrl);
  if (callback.origin !== new URL(credentials.redirectUri).origin || callback.searchParams.get("state") !== state) {
    throw new Error("AUTH_CALLBACK_INVALID");
  }
  const code = requiredString(callback.searchParams.get("code"), "AUTH_CALLBACK_INVALID");
  const token = fromResponse(await requestToken(credentials, new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: credentials.redirectUri,
  })));
  await save({
    version: 1,
    ...credentials,
    token,
    reauthorizedAt: new Date().toISOString(),
    reauthorizationWeek: weeklyReauthorizationWeek(),
  });
}

export function beginLogin(): { state: string; authorizationUrl: string } {
  const credentials = environmentCredentials();
  const state = randomUUID();
  const url = new URL(authorizeUrl);
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", credentials.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return { state, authorizationUrl: url.toString() };
}

export function weeklyReauthorizationWeek(now = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  if (weekday < 0) throw new Error("AUTH_REAUTH_CLOCK_INVALID");
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  let daysSinceMonday = (weekday + 6) % 7;
  if (weekday === 1 && Number(parts.hour) * 60 + Number(parts.minute) < 6 * 60) daysSinceMonday = 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday);
  return localDate.toISOString().slice(0, 10);
}
