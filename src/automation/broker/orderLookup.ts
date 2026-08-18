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

  /** Add one locally accepted broker order without rescanning the snapshot. */
  add(value: T): void {
    const id = this.key(value);
    if (this.byId.has(id)) throw new Error("BROKER_ORDER_ID_DUPLICATE");
    this.byId.set(id, value);
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }
}
