const STABLE_RUNTIME_FAILURE = /^[A-Z][A-Z0-9_:-]{2,119}$/;

export function backgroundTaskFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return STABLE_RUNTIME_FAILURE.test(message)
    ? message
    : "RUNTIME_BACKGROUND_TASK_FAILED";
}

export type BackgroundTaskFailureHandler = (
  task: string,
  error: unknown,
  code: string,
) => void;

/**
 * Execute intentionally detached runtime work with an explicit rejection
 * boundary. The failure callback is also isolated so a logging/reporting
 * problem cannot re-create an unhandled rejection at process scope.
 */
export function superviseBackgroundTask(
  task: string,
  operation: () => void | Promise<unknown>,
  onFailure: BackgroundTaskFailureHandler,
): void {
  void Promise.resolve()
    .then(operation)
    .catch((error) => {
      try {
        onFailure(task, error, backgroundTaskFailureCode(error));
      } catch {
        // The task rejection has already crossed the runtime boundary. Error
        // reporting is best effort and must never create a second unhandled
        // rejection.
      }
    });
}
