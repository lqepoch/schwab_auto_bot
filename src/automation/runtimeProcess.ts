export type RuntimeSignal = "SIGINT" | "SIGTERM";

export interface RuntimeProcessEvents {
  on(event: RuntimeSignal, listener: () => void): unknown;
  once(event: "exit", listener: () => void): unknown;
  off(event: RuntimeSignal | "exit", listener: () => void): unknown;
}

export type RuntimeProcessHandlers = Readonly<{
  onSignal: (signal: RuntimeSignal) => void;
  onExit: () => void;
}>;

/**
 * Bind the process hooks owned by one automation runtime invocation.
 * The returned cleanup is idempotent so an embedded caller can run the
 * automation more than once without accumulating signal or exit listeners.
 */
export function bindRuntimeProcessHandlers(
  target: RuntimeProcessEvents,
  handlers: RuntimeProcessHandlers,
): () => void {
  let bound = true;
  const handleSigint = () => handlers.onSignal("SIGINT");
  const handleSigterm = () => handlers.onSignal("SIGTERM");
  const handleExit = () => handlers.onExit();

  target.on("SIGINT", handleSigint);
  target.on("SIGTERM", handleSigterm);
  target.once("exit", handleExit);

  return () => {
    if (!bound) return;
    bound = false;
    target.off("SIGINT", handleSigint);
    target.off("SIGTERM", handleSigterm);
    target.off("exit", handleExit);
  };
}
