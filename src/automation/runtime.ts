/**
 * Starts the guarded Schwab automation runtime using the current process arguments.
 * The implementation keeps the existing fail-closed CLI semantics and does not
 * bypass live confirmation, Preview, WAL, reconciliation, or serialized writes.
 */
export async function runSchwabAutomationCli(): Promise<void> {
  const entry = new URL(import.meta.url.endsWith('.ts') ? '../main.ts' : '../main.js', import.meta.url);
  await import(entry.href);
}
