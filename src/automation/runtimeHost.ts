import type { RuntimeProcessEvents } from "./runtimeProcess.ts";

export type RuntimeErrorOutput = Pick<NodeJS.WritableStream, "write">;

export type AutomationRuntimeOptions = Readonly<{
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  pid?: number;
  execPath?: string;
  entryPath?: string;
  stderr?: RuntimeErrorOutput;
  processEvents?: RuntimeProcessEvents;
}>;

export type AutomationRuntimeHost = Readonly<{
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  pid: number;
  execPath: string;
  entryPath: string;
  stderr: RuntimeErrorOutput;
  processEvents: RuntimeProcessEvents;
}>;

/** Resolve process-global defaults once at the executable/module boundary. */
export function resolveAutomationRuntimeHost(
  options: AutomationRuntimeOptions = {},
  defaults: Readonly<{
    entryPath: string;
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    pid?: number;
    execPath?: string;
    stderr?: RuntimeErrorOutput;
    processEvents?: RuntimeProcessEvents;
  }>,
): AutomationRuntimeHost {
  const argv = options.argv ?? defaults.argv ?? process.argv;
  const env = options.env ?? defaults.env ?? process.env;
  const pid = options.pid ?? defaults.pid ?? process.pid;
  const execPath = options.execPath ?? defaults.execPath ?? process.execPath;
  const entryPath = options.entryPath ?? defaults.entryPath;
  const stderr = options.stderr ?? defaults.stderr ?? process.stderr;
  const processEvents = options.processEvents ?? defaults.processEvents ?? process;

  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new Error("AUTOMATION_RUNTIME_ARGV_INVALID");
  }
  if (!env || typeof env !== "object") throw new Error("AUTOMATION_RUNTIME_ENV_INVALID");
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("AUTOMATION_RUNTIME_PID_INVALID");
  if (typeof execPath !== "string" || !execPath) throw new Error("AUTOMATION_RUNTIME_EXEC_PATH_INVALID");
  if (typeof entryPath !== "string" || !entryPath) throw new Error("AUTOMATION_RUNTIME_ENTRY_PATH_INVALID");
  if (!stderr || typeof stderr.write !== "function") throw new Error("AUTOMATION_RUNTIME_STDERR_INVALID");
  if (
    !processEvents
    || typeof processEvents.on !== "function"
    || typeof processEvents.once !== "function"
    || typeof processEvents.off !== "function"
  ) {
    throw new Error("AUTOMATION_RUNTIME_PROCESS_EVENTS_INVALID");
  }

  return { argv, env, pid, execPath, entryPath, stderr, processEvents };
}
