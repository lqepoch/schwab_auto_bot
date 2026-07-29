export type RefreshRoundLimitState = Readonly<{
  completedRounds: number;
  maximumRounds: number | null;
  maximumReached: boolean;
}>;

export class RefreshRoundLimit {
  private completedRounds = 0;
  private readonly maximumRounds: number | null;

  constructor(maximumRounds: number | null) {
    this.maximumRounds = maximumRounds;
  }

  mayStartRound(): boolean {
    return this.maximumRounds === null || this.completedRounds < this.maximumRounds;
  }

  completeRound(): RefreshRoundLimitState {
    if (!this.mayStartRound()) throw new Error("REFRESH_ROUND_LIMIT_EXHAUSTED");
    this.completedRounds += 1;
    return {
      completedRounds: this.completedRounds,
      maximumRounds: this.maximumRounds,
      maximumReached: !this.mayStartRound(),
    };
  }
}
