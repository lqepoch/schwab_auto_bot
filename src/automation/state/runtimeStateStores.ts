import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "../../utils/atomicJson.ts";
import { PriceExplorer, type ExplorerSnapshot } from "../execution/priceExplorer.ts";
import type { Json } from "../policy/order.ts";

export type RuntimeStateWriteFailureHandler = (error: unknown) => void;

type SerializedJsonStateOptions<T> = Readonly<{
  path: string;
  readOnly: boolean;
  missing: () => T;
  decode: (value: unknown) => T;
  encode: (value: T) => unknown;
  onWriteFailure: RuntimeStateWriteFailureHandler;
}>;

class SerializedJsonState<T> {
  private readonly path: string;
  private readonly readOnly: boolean;
  private readonly missing: () => T;
  private readonly decode: (value: unknown) => T;
  private readonly encode: (value: T) => unknown;
  private readonly onWriteFailure: RuntimeStateWriteFailureHandler;
  private writeTail: Promise<void> = Promise.resolve();
  private writeFailure: { error: unknown } | null = null;

  constructor(options: SerializedJsonStateOptions<T>) {
    this.path = options.path;
    this.readOnly = options.readOnly;
    this.missing = options.missing;
    this.decode = options.decode;
    this.encode = options.encode;
    this.onWriteFailure = options.onWriteFailure;
  }

  async load(): Promise<T> {
    try {
      return this.decode(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.missing();
      throw error;
    }
  }

  save(value: T): void {
    if (this.readOnly) return;
    // Snapshot at enqueue time. Mutable Maps/Sets/PriceExplorer instances may
    // change before the prior disk write has finished.
    const snapshot = this.encode(value);
    this.writeTail = this.writeTail
      .then(async () => {
        await atomicWriteJson(this.path, snapshot);
        // A complete state snapshot supersedes an earlier failed write. Once
        // the newest authoritative view is durable, the queue is healthy again.
        this.writeFailure = null;
      })
      .catch((error) => {
        this.writeFailure = { error };
        try {
          this.onWriteFailure(error);
        } catch {
          // Persistence reporting is best effort. The queue must recover so a
          // later state save can still persist the newest authoritative view.
        }
      });
  }

  async flush(): Promise<void> {
    await this.writeTail;
    if (this.writeFailure) throw this.writeFailure.error;
  }
}

function explorerSnapshot(value: unknown): ExplorerSnapshot {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !("groups" in value)
    || !(value as { groups?: unknown }).groups
    || typeof (value as { groups?: unknown }).groups !== "object"
  ) {
    throw new Error("EXPLORER_STATE_INVALID");
  }
  return value as ExplorerSnapshot;
}

export class PriceExplorerStateStore {
  private readonly state: SerializedJsonState<PriceExplorer>;

  constructor(
    path: string,
    options: Readonly<{
      readOnly: boolean;
      onWriteFailure: RuntimeStateWriteFailureHandler;
    }>,
  ) {
    this.state = new SerializedJsonState({
      path,
      readOnly: options.readOnly,
      missing: () => new PriceExplorer(),
      decode: (value) => new PriceExplorer(explorerSnapshot(value)),
      encode: (value) => value.snapshot(),
      onWriteFailure: options.onWriteFailure,
    });
  }

  load(): Promise<PriceExplorer> {
    return this.state.load();
  }

  save(value: PriceExplorer): void {
    this.state.save(value);
  }

  flush(): Promise<void> {
    return this.state.flush();
  }
}

const MAX_FIXED_PRICE_CONSUMED_FILLS = 1_000;

export class FixedPriceCycleStateStore {
  private readonly state: SerializedJsonState<Set<string>>;

  constructor(
    path: string,
    options: Readonly<{
      readOnly: boolean;
      onWriteFailure: RuntimeStateWriteFailureHandler;
    }>,
  ) {
    this.state = new SerializedJsonState({
      path,
      readOnly: options.readOnly,
      missing: () => new Set<string>(),
      decode: (value) => {
        if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
          throw new Error("FIXED_PRICE_CYCLE_STATE_INVALID");
        }
        return new Set(value.slice(-MAX_FIXED_PRICE_CONSUMED_FILLS));
      },
      encode: (value) => [...value].slice(-MAX_FIXED_PRICE_CONSUMED_FILLS),
      onWriteFailure: options.onWriteFailure,
    });
  }

  load(): Promise<Set<string>> {
    return this.state.load();
  }

  save(value: Set<string>): void {
    this.state.save(value);
  }

  flush(): Promise<void> {
    return this.state.flush();
  }
}

export class ExitTemplateStateStore {
  private readonly state: SerializedJsonState<Map<string, Json>>;

  constructor(
    path: string,
    options: Readonly<{
      readOnly: boolean;
      onWriteFailure: RuntimeStateWriteFailureHandler;
    }>,
  ) {
    this.state = new SerializedJsonState({
      path,
      readOnly: options.readOnly,
      missing: () => new Map<string, Json>(),
      decode: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("EXIT_TEMPLATE_STATE_INVALID");
        }
        return new Map(
          Object.entries(value as Record<string, Json>)
            .filter(([, template]) => Array.isArray(template?.orderLegCollection)),
        );
      },
      encode: (value) => structuredClone(Object.fromEntries(value)),
      onWriteFailure: options.onWriteFailure,
    });
  }

  load(): Promise<Map<string, Json>> {
    return this.state.load();
  }

  save(value: Map<string, Json>): void {
    this.state.save(value);
  }

  flush(): Promise<void> {
    return this.state.flush();
  }
}
