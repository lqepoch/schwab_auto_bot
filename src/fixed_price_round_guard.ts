export class FixedPriceRefreshRoundGuard {
  private readonly strategies = new Set<string>();

  beginRound(): void {
    this.strategies.clear();
  }

  reserveStrategy(strategy: string): boolean {
    if (this.strategies.has(strategy)) return false;
    this.strategies.add(strategy);
    return true;
  }

  endRound(): void {
    this.strategies.clear();
  }
}
