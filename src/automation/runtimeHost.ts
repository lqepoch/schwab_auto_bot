import { isAbsolute } from "node:path";
import type { RuntimeProcessEvents } from "./runtimeProcess.ts";

export type RuntimeErrorOutput = Pick<NodeJS.WritableStream, "write">;

export type AutomationRuntimeOptions = Readonly<{
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  pid?: number;
  execPath?: string;
  entryPath?: string;
  workspaceRoot?: string;
  stderr?: RuntimeErrorOutput;
  processEvents?: RuntimeProcessEvents;
  reauthorizeInteractively?: () => Promise<void>;
  signal?: AbortSignal;
}>;

export type AutomationRuntimeHost = Readonly<{
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  pid: number;
  execPath: string;
  entryPath: string;
  workspaceRoot: string;
  stderr: RuntimeErrorOutput;
  processEvents: RuntimeProcessEvents;
  reauthorizeInteractively?: () => Promise<void>;
  signal?: AbortSignal;
}>;

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AbortSignal>;
  return typeof candidate.aborted === "boolean"
    && typeof candidate.addEventListener === "function"
    && typeof candidate.removeEventListener === "function";
}

/** Resolve process-global defaults once at the executable/module boundary. */
export function resolveAutomationRuntimeHost(
  options: AutomationRuntimeOptions = {},
  defaults: Readonly<{
    entryPath: string;
    workspaceRoot: string;
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
  const workspaceRoot = options.workspaceRoot ?? defaults.workspaceRoot;
  const stderr = options.stderr ?? defaults.stderr ?? process.stderr;
  const processEvents = options.processEvents ?? defaults.processEvents ?? process;
  const reauthorizeInteractively = options.reauthorizeInteractively;
  const signal = options.signal;

  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new Error("AUTOMATION_RUNTIME_ARGV_INVALID");
  }
  if (!env || typeof env !== "object") throw new Error("AUTOMATION_RUNTIME_ENV_INVALID");
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("AUTOMATION_RUNTIME_PID_INVALID");
  if (typeof execPath !== "string" || !execPath) throw new Error("AUTOMATION_RUNTIME_EXEC_PATH_INVALID");
  if (typeof entryPath !== "string" || !entryPath) throw new Error("AUTOMATION_RUNTIME_ENTRY_PATH_INVALID");
  if (typeof workspaceRoot !== "string" || !workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error("AUTOMATION_RUNTIME_WORKSPACE_ROOT_INVALID");
  }
  if (!stderr || typeof stderr.write !== "function") throw new Error("AUTOMATION_RUNTIME_STDERR_INVALID");
  if (
    !processEvents
    || typeof processEvents.on !== "function"
    || typeof processEvents.once !== "function"
    || typeof processEvents.off !== "function"
  ) {
    throw new Error("AUTOMATION_RUNTIME_PROCESS_EVENTS_INVALID");
  }
  if (reauthorizeInteractively !== undefined && typeof reauthorizeInteractively !== "function") {
    throw new Error("AUTOMATION_RUNTIME_REAUTH_CALLBACK_INVALID");
  }
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new Error("AUTOMATION_RUNTIME_ABORT_SIGNAL_INVALID");
  }

  return {
    argv,
    env,
    pid,
    execPath,
    entryPath,
    workspaceRoot,
    stderr,
    processEvents,
    reauthorizeInteractively,
    signal,
  };
}
