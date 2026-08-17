import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function replaceInFile(path, replacements) {
  let text = await readFile(path, 'utf8');
  for (const [before, after] of replacements) {
    if (!text.includes(before)) throw new Error(`PATTERN_NOT_FOUND:${path}:${before.slice(0, 80)}`);
    text = text.replace(before, after);
  }
  await writeFile(path, text, 'utf8');
}

async function sourceFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.ts')) result.push(path);
  }
  return result;
}

// Node 24 strip-types executes the same source files that TypeScript compiles.
// Keep relative source imports explicit as .ts; rewriteRelativeImportExtensions
// emits .js references in dist, so the source and package execution models stay aligned.
for (const path of await sourceFiles('src')) {
  const text = await readFile(path, 'utf8');
  const rewritten = text.replace(/(['"])(\.\.?\/[^'"]+)\.js\1/g, '$1$2.ts$1');
  if (rewritten !== text) await writeFile(path, rewritten, 'utf8');
}

await replaceInFile('src/auth.ts', [[
  `class AutomationAuthStore implements TokenStoreAdapter {
  readonly path = statePath;

  constructor(
    private readonly credentials?: Credentials,
    private readonly markReauthorized = false,
  ) {}`,
  `class AutomationAuthStore implements TokenStoreAdapter {
  readonly path = statePath;
  private readonly credentials: Credentials | undefined;
  private readonly markReauthorized: boolean;

  constructor(credentials?: Credentials, markReauthorized = false) {
    this.credentials = credentials;
    this.markReauthorized = markReauthorized;
  }`,
]]);

await replaceInFile('src/streamer/streamerClient.ts', [[
  "this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));",
  "this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url, { handshakeTimeout: 15_000, perMessageDeflate: false }));",
]]);

await replaceInFile('test/activity_stream.test.ts', [
  [
    'this.emit("message", Buffer.from(JSON.stringify({ response: [{ requestid, service, command, content: { code } }] })));',
    'this.emit("message", Buffer.from(JSON.stringify({ response: [{ requestid, service, command, timestamp: Date.now(), content: { code, msg: "OK" } }] })));',
  ],
  [
    'this.emit("message", Buffer.from(JSON.stringify({ data: entries })));',
    'this.emit("message", Buffer.from(JSON.stringify({ data: entries.map((entry) => ({ timestamp: Date.now(), command: "SUBS", ...entry })) })));',
  ],
]);

const mainPath = 'src/main.ts';
const source = await readFile(mainPath, 'utf8');
const lines = source.split(/\r?\n/);
const boundary = lines.findIndex((line) => line.startsWith('const root = '));
if (boundary < 0) throw new Error('MAIN_BOUNDARY_NOT_FOUND');
let imports = lines.slice(0, boundary).join('\n').trimEnd();
let body = lines.slice(boundary).join('\n');
imports = imports.replaceAll('from "./', 'from "../').replaceAll("from './", "from '../");
body = body.replace(
  'const root = dirname(dirname(fileURLToPath(import.meta.url)));',
  'const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));',
);
body = body.replace(
  'entryPath: fileURLToPath(import.meta.url),',
  'entryPath: join(root, "src", "main.ts"),',
);
if (!body.includes('entryPath: join(root, "src", "main.ts"),')) throw new Error('ENTRY_PATH_NOT_REWRITTEN');
const orchestrator = `${imports}\n\n/**\n * Production automation composition and lifecycle orchestrator.\n * Broker mutation invariants stay behind the existing write coordinator, WAL,\n * reconciliation and snapshot-freshness gates. src/main.ts remains a stable\n * executable boundary for process management and hot-switch tooling.\n */\nexport async function runAutomationRuntime(): Promise<void> {\n${body}\n}\n`;
await writeFile('src/automation/runtimeOrchestrator.ts', orchestrator, 'utf8');
await writeFile(mainPath, 'import { runAutomationRuntime } from "./automation/runtimeOrchestrator.ts";\n\nawait runAutomationRuntime();\n', 'utf8');
await writeFile(
  'src/automation/runtime.ts',
  "export { runAutomationRuntime as runSchwabAutomationCli } from './runtimeOrchestrator.ts';\n",
  'utf8',
);
