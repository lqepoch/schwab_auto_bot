import { readFile, writeFile } from 'node:fs/promises';

async function replaceInFile(path, replacements) {
  let text = await readFile(path, 'utf8');
  for (const [before, after] of replacements) {
    if (!text.includes(before)) throw new Error(`PATTERN_NOT_FOUND:${path}:${before.slice(0, 80)}`);
    text = text.replace(before, after);
  }
  await writeFile(path, text, 'utf8');
}

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
imports = imports.replaceAll('from "./', 'from "../');
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
