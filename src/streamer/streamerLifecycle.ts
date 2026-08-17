export type PendingLifecycle = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  generation: number;
};

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createLifecycle(generation: number): PendingLifecycle {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject, generation };
}
