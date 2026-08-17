const SAFE_AUTH_FAILURE = /^AUTH_[A-Z0-9_]+(?:_\d{3})?$/;

export function backgroundAuthFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_AUTH_FAILURE.test(message) ? message : "AUTH_BACKGROUND_REFRESH_FAILED";
}

export type UnauthorizedRefreshCoordinatorOptions = Readonly<{
  refresh: () => Promise<unknown>;
  onFailure: (code: string) => void;
}>;

/**
 * Pre-warm credentials after a broker 401 without retrying the broker request.
 * The coordinator coalesces concurrent 401s and consumes both async rejections
 * and synchronous refresh failures so the original broker error remains the
 * authoritative result of the request that received 401.
 */
export class UnauthorizedRefreshCoordinator {
  private readonly refresh: () => Promise<unknown>;
  private readonly onFailure: (code: string) => void;
  private pending: Promise<void> | null = null;

  constructor(options: UnauthorizedRefreshCoordinatorOptions) {
    this.refresh = options.refresh;
    this.onFailure = options.onFailure;
  }

  schedule(): boolean {
    if (this.pending) return false;

    const pending = Promise.resolve()
      .then(() => this.refresh())
      .then(
        () => undefined,
        (error) => {
          try {
            this.onFailure(backgroundAuthFailureCode(error));
          } catch {
            // Reporting is best-effort on this background path. A logging
            // failure must never turn a handled token refresh rejection into
            // an unhandled process-level rejection.
          }
        },
      )
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });

    this.pending = pending;
    return true;
  }
}
