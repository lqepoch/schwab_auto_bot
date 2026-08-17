from pathlib import Path

provider_path = Path('src/automation/auth/provider.ts')
text = provider_path.read_text(encoding='utf-8')

old_state = 'const statePath = process.env.SCHWAB_BOT_AUTH_FILE || defaultAutomationAuthStatePath(import.meta.url);\n'
if old_state not in text:
    raise SystemExit('AUTH_STATE_CONSTANT_ANCHOR_MISSING')
text = text.replace(old_state, '', 1)

formatter_end = '''  hourCycle: "h23",\n});\n'''
options_block = '''  hourCycle: "h23",\n});\n\nexport type AutomationAuthOptions = Readonly<{\n  env?: NodeJS.ProcessEnv;\n  statePath?: string;\n}>;\n\nfunction authEnvironment(options: AutomationAuthOptions = {}): NodeJS.ProcessEnv {\n  return options.env ?? process.env;\n}\n\nfunction authStatePath(options: AutomationAuthOptions = {}): string {\n  const env = authEnvironment(options);\n  return options.statePath || env.SCHWAB_BOT_AUTH_FILE || defaultAutomationAuthStatePath(import.meta.url);\n}\n'''
if formatter_end not in text:
    raise SystemExit('AUTH_FORMATTER_ANCHOR_MISSING')
text = text.replace(formatter_end, options_block, 1)

text = text.replace('async function load(): Promise<AuthFile | null> {', 'async function load(statePath: string): Promise<AuthFile | null> {', 1)
text = text.replace('async function save(value: AuthFile): Promise<void> {\n  await atomicWriteJson(statePath, value,', 'async function save(statePath: string, value: AuthFile): Promise<void> {\n  await atomicWriteJson(statePath, value,', 1)

old_env = '''function environmentCredentials(): Credentials {\n  const clientId = requiredString(process.env.SCHWAB_APP_KEY || process.env.SCHWAB_CLIENT_ID, "AUTH_APP_KEY_MISSING");\n  const clientSecret = requiredString(process.env.SCHWAB_APP_SECRET || process.env.SCHWAB_CLIENT_SECRET, "AUTH_APP_SECRET_MISSING");\n  const redirectUri = requiredString(process.env.SCHWAB_CALLBACK_URL || process.env.SCHWAB_REDIRECT_URI || "https://127.0.0.1", "AUTH_REDIRECT_URI_MISSING");\n  return { clientId, clientSecret, redirectUri };\n}\n'''
new_env = '''function environmentCredentials(options: AutomationAuthOptions = {}): Credentials {\n  const env = authEnvironment(options);\n  const clientId = requiredString(env.SCHWAB_APP_KEY || env.SCHWAB_CLIENT_ID, "AUTH_APP_KEY_MISSING");\n  const clientSecret = requiredString(env.SCHWAB_APP_SECRET || env.SCHWAB_CLIENT_SECRET, "AUTH_APP_SECRET_MISSING");\n  const redirectUri = requiredString(env.SCHWAB_CALLBACK_URL || env.SCHWAB_REDIRECT_URI || "https://127.0.0.1", "AUTH_REDIRECT_URI_MISSING");\n  return { clientId, clientSecret, redirectUri };\n}\n'''
if old_env not in text:
    raise SystemExit('AUTH_ENVIRONMENT_CREDENTIALS_ANCHOR_MISSING')
text = text.replace(old_env, new_env, 1)

old_store = '''class AutomationAuthStore implements TokenStoreAdapter {\n  readonly path = statePath;\n  private readonly credentials: Credentials | undefined;\n  private readonly markReauthorized: boolean;\n\n  constructor(credentials?: Credentials, markReauthorized = false) {\n    this.credentials = credentials;\n    this.markReauthorized = markReauthorized;\n  }\n\n  async load(): Promise<unknown | null> {\n    const auth = await load();\n'''
new_store = '''class AutomationAuthStore implements TokenStoreAdapter {\n  readonly path: string;\n  private readonly credentials: Credentials | undefined;\n  private readonly markReauthorized: boolean;\n\n  constructor(statePath: string, credentials?: Credentials, markReauthorized = false) {\n    this.path = statePath;\n    this.credentials = credentials;\n    this.markReauthorized = markReauthorized;\n  }\n\n  async load(): Promise<unknown | null> {\n    const auth = await load(this.path);\n'''
if old_store not in text:
    raise SystemExit('AUTH_STORE_ANCHOR_MISSING')
text = text.replace(old_store, new_store, 1)
text = text.replace('    const current = await load();\n', '    const current = await load(this.path);\n', 1)
text = text.replace('    await save(value);\n', '    await save(this.path, value);\n', 1)

old_provider = '''export class SchwabTokenProvider {\n  private pending: Promise<string> | null = null;\n  private pendingForce = false;\n  private readonly report: (message: string) => void;\n\n  constructor(report: (message: string) => void) {\n    this.report = report;\n  }\n'''
new_provider = '''export class SchwabTokenProvider {\n  private pending: Promise<string> | null = null;\n  private pendingForce = false;\n  private readonly report: (message: string) => void;\n  private readonly statePath: string;\n\n  constructor(report: (message: string) => void, options: AutomationAuthOptions = {}) {\n    this.report = report;\n    this.statePath = authStatePath(options);\n  }\n'''
if old_provider not in text:
    raise SystemExit('TOKEN_PROVIDER_CONSTRUCTOR_ANCHOR_MISSING')
text = text.replace(old_provider, new_provider, 1)
text = text.replace('    const auth = await load();\n    if (!auth || Date.parse(auth.token.refreshExpiresAt) <= Date.now()) throw new Error("AUTH_LOGIN_REQUIRED");\n    const tokenManager = manager(auth, new AutomationAuthStore());\n', '    const auth = await load(this.statePath);\n    if (!auth || Date.parse(auth.token.refreshExpiresAt) <= Date.now()) throw new Error("AUTH_LOGIN_REQUIRED");\n    const tokenManager = manager(auth, new AutomationAuthStore(this.statePath));\n', 1)

old_status = '''export async function status(): Promise<AuthStatus> {\n  const auth = await load();\n'''
new_status = '''export async function status(options: AutomationAuthOptions = {}): Promise<AuthStatus> {\n  const auth = await load(authStatePath(options));\n'''
if old_status not in text:
    raise SystemExit('AUTH_STATUS_ANCHOR_MISSING')
text = text.replace(old_status, new_status, 1)

old_weekly = '''export async function requireWeeklyReauthorization(now = new Date()): Promise<void> {\n  const auth = await load();\n'''
new_weekly = '''export async function requireWeeklyReauthorization(\n  now = new Date(),\n  options: AutomationAuthOptions = {},\n): Promise<void> {\n  const auth = await load(authStatePath(options));\n'''
if old_weekly not in text:
    raise SystemExit('AUTH_WEEKLY_ANCHOR_MISSING')
text = text.replace(old_weekly, new_weekly, 1)

old_login = '''export async function login(callbackUrl: string, state: string): Promise<void> {\n  const credentials = environmentCredentials();\n'''
new_login = '''export async function login(\n  callbackUrl: string,\n  state: string,\n  options: AutomationAuthOptions = {},\n): Promise<void> {\n  const credentials = environmentCredentials(options);\n  const statePath = authStatePath(options);\n'''
if old_login not in text:
    raise SystemExit('AUTH_LOGIN_ANCHOR_MISSING')
text = text.replace(old_login, new_login, 1)
text = text.replace('    await manager(credentials, new AutomationAuthStore(credentials, true)).exchangeCodeForToken(code);\n', '    await manager(credentials, new AutomationAuthStore(statePath, credentials, true)).exchangeCodeForToken(code);\n', 1)

old_begin = '''export function beginLogin(): { state: string; authorizationUrl: string } {\n  const credentials = environmentCredentials();\n  const state = randomUUID();\n  return {\n    state,\n    authorizationUrl: manager(credentials, new AutomationAuthStore(credentials, true)).createAuthorizeUrl({ state }),\n  };\n}\n'''
new_begin = '''export function beginLogin(options: AutomationAuthOptions = {}): { state: string; authorizationUrl: string } {\n  const credentials = environmentCredentials(options);\n  const statePath = authStatePath(options);\n  const state = randomUUID();\n  return {\n    state,\n    authorizationUrl: manager(credentials, new AutomationAuthStore(statePath, credentials, true)).createAuthorizeUrl({ state }),\n  };\n}\n'''
if old_begin not in text:
    raise SystemExit('AUTH_BEGIN_LOGIN_ANCHOR_MISSING')
text = text.replace(old_begin, new_begin, 1)

# No module-level state path or direct environment credential reads may remain.
if 'const statePath = process.env.SCHWAB_BOT_AUTH_FILE' in text:
    raise SystemExit('MODULE_STATE_PATH_REMAINS')
if 'environmentCredentials()' in text:
    raise SystemExit('UNSCOPED_ENVIRONMENT_CREDENTIALS_REMAINS')

provider_path.write_text(text, encoding='utf-8')

runtime_path = Path('src/automation/runtimeOrchestrator.ts')
runtime = runtime_path.read_text(encoding='utf-8')
old_auth_import = 'import { requireWeeklyReauthorization, SchwabTokenProvider } from "./auth/provider.ts";\n'
new_auth_import = 'import { beginLogin, login, requireWeeklyReauthorization, SchwabTokenProvider, type AutomationAuthOptions } from "./auth/provider.ts";\n'
if old_auth_import not in runtime:
    raise SystemExit('RUNTIME_AUTH_IMPORT_ANCHOR_MISSING')
runtime = runtime.replace(old_auth_import, new_auth_import, 1)

host_anchor = '''const root = repositoryRootFromAutomationModuleUrl(import.meta.url);\n'''
host_replacement = '''const root = repositoryRootFromAutomationModuleUrl(import.meta.url);\nconst automationAuthOptions: AutomationAuthOptions = { env: host.env };\n'''
if host_anchor not in runtime:
    raise SystemExit('RUNTIME_AUTH_OPTIONS_ANCHOR_MISSING')
runtime = runtime.replace(host_anchor, host_replacement, 1)

runtime = runtime.replace('const tokens = new SchwabTokenProvider(stamp);\n', 'const tokens = new SchwabTokenProvider(stamp, automationAuthOptions);\n', 1)

old_ensurer = '''const ensureWeeklyReauthorization = createWeeklyReauthorizationEnsurer({\n  requireWeeklyReauthorization,\n  reauthorizeInteractively: runInteractiveLogin,\n'''
new_ensurer = '''const ensureWeeklyReauthorization = createWeeklyReauthorizationEnsurer({\n  requireWeeklyReauthorization: () => requireWeeklyReauthorization(new Date(), automationAuthOptions),\n  reauthorizeInteractively: () => runInteractiveLogin({\n    beginLogin: () => beginLogin(automationAuthOptions),\n    login: (callbackUrl, state) => login(callbackUrl, state, automationAuthOptions),\n  }),\n'''
if old_ensurer not in runtime:
    raise SystemExit('RUNTIME_REAUTH_ENSURER_ANCHOR_MISSING')
runtime = runtime.replace(old_ensurer, new_ensurer, 1)

if 'new SchwabTokenProvider(stamp);' in runtime:
    raise SystemExit('RUNTIME_UNSCOPED_TOKEN_PROVIDER_REMAINS')
if 'reauthorizeInteractively: runInteractiveLogin' in runtime:
    raise SystemExit('RUNTIME_UNSCOPED_INTERACTIVE_LOGIN_REMAINS')

runtime_path.write_text(runtime, encoding='utf-8')

public_path = Path('src/automation/public.ts')
public = public_path.read_text(encoding='utf-8')
anchor = "export { SchwabTokenProvider, requireWeeklyReauthorization, status as authStatus } from './auth/provider.ts';\n"
replacement = anchor + "export type { AutomationAuthOptions } from './auth/provider.ts';\n"
if anchor not in public:
    raise SystemExit('PUBLIC_AUTH_EXPORT_ANCHOR_MISSING')
public = public.replace(anchor, replacement, 1)
public_path.write_text(public, encoding='utf-8')
