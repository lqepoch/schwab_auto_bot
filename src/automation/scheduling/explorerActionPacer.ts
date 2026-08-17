export type ExplorerActionPacerOptions = Readonly<{
  cooldownMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

/** Serializes normal price-explorer writes and enforces their minimum cadence. */
export class ExplorerActionPacer {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tail = Promise.resolve();
  private lastNormalActionAt = 0;

  constructor(options: ExplorerActionPacerOptions) {
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) {
      throw new Error("EXPLORER_ACTION_COOLDOWN_INVALID");
    }
    this.cooldownMs = options.cooldownMs;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async admit(): Promise<void> {
    const next = this.tail.then(async () => {
      const delay = this.cooldownMs - (this.now() - this.lastNormalActionAt);
      if (delay > 0) await this.sleep(delay);
      this.lastNormalActionAt = this.now();
    });
    this.tail = next.catch(() => undefined);
    await next;
  }
}
