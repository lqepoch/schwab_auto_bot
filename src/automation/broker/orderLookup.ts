export class OrderLookup<T> {
  private readonly key: (value: T) => string;
  private byId = new Map<string, T>();

  constructor(key: (value: T) => string) {
    this.key = key;
  }

  /**
   * Build a complete replacement index before publishing it. Duplicate broker
   * identities fail closed and leave the previously published index intact.
   */
  replace(values: readonly T[]): void {
    const next = new Map<string, T>();
    for (const value of values) {
      const id = this.key(value);
      if (next.has(id)) throw new Error("BROKER_ORDER_ID_DUPLICATE");
      next.set(id, value);
    }
    this.byId = next;
  }

  /**
   * Publish a locally accepted order only when an authoritative poll has not
   * already observed the same broker ID. The authoritative object wins this
   * race because it contains the broker's fresher status/execution metadata.
   */
  addIfAbsent(value: T): boolean {
    const id = this.key(value);
    if (this.byId.has(id)) return false;
    this.byId.set(id, value);
    return true;
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }
}
