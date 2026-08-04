export const WEEKLY_REAUTH_REQUIRED = "AUTH_WEEKLY_REAUTH_REQUIRED";

type EnsureDependencies = {
  requireWeeklyReauthorization: () => Promise<void>;
  reauthorizeInteractively: () => Promise<void>;
  onReauthorizationRequired?: () => void;
  onReauthorized?: () => void;
};

function isWeeklyReauthorizationRequired(error: unknown): boolean {
  return error instanceof Error && error.message === WEEKLY_REAUTH_REQUIRED;
}

export function createWeeklyReauthorizationEnsurer({
  requireWeeklyReauthorization,
  reauthorizeInteractively,
  onReauthorizationRequired,
  onReauthorized,
}: EnsureDependencies): () => Promise<void> {
  let pendingReauthorization: Promise<void> | null = null;

  return async (): Promise<void> => {
    try {
      await requireWeeklyReauthorization();
      return;
    } catch (error) {
      if (!isWeeklyReauthorizationRequired(error)) throw error;
    }

    if (!pendingReauthorization) {
      onReauthorizationRequired?.();
      pendingReauthorization = reauthorizeInteractively()
        .then(() => {
          onReauthorized?.();
        })
        .finally(() => {
          pendingReauthorization = null;
        });
    }
    await pendingReauthorization;
    await requireWeeklyReauthorization();
  };
}
