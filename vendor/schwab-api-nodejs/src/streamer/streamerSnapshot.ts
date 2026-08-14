import EventEmitter from 'node:events';
import {
  decodeStreamerServicePayload,
  STREAMER_SERVICE_CONTRACTS,
  type StreamerService,
  type StreamerServiceRow,
  type TypedStreamerDataPayload,
} from '../types/streamerContracts.js';

export type SnapshotFreshness = 'fresh' | 'stale' | 'uncertain';
export type SnapshotDiscardReason =
  | 'inactive-generation'
  | 'stale-timestamp'
  | 'stale-sequence'
  | 'duplicate'
  | 'uncertain-order'
  | 'invalid-payload';

export interface StreamerSnapshotCacheOptions {
  staleAfterMs?: number;
  clock?: () => number;
}

export interface StreamerSnapshotEntry<S extends StreamerService = StreamerService> {
  service: S;
  key: string;
  row: StreamerServiceRow<S>;
  generation: number;
  freshness: SnapshotFreshness;
  timestamp?: number;
  sequence?: number;
  updatedAt: number;
}

export interface StreamerSnapshotUpdate<S extends StreamerService = StreamerService> {
  entry: StreamerSnapshotEntry<S>;
  mode: (typeof STREAMER_SERVICE_CONTRACTS[S])['delivery'];
}

export interface SnapshotApplyResult<S extends StreamerService = StreamerService> {
  accepted: boolean;
  reason?: SnapshotDiscardReason;
  update?: StreamerSnapshotUpdate<S>;
}

export interface SnapshotPayloadResult<S extends StreamerService = StreamerService> {
  results: Array<SnapshotApplyResult<S>>;
  updates: Array<StreamerSnapshotUpdate<S>>;
}

const DEFAULT_STALE_AFTER_MS = 30_000;

/**
 * Opt-in row cache for Streamer data. It is intentionally not a native complex
 * option-book or execution-quote implementation; it only tracks documented
 * service rows and their ordering evidence.
 */
export class StreamerSnapshotCache {
  private readonly entries = new Map<string, StreamerSnapshotEntry>();
  private readonly staleAfterMs: number;
  private readonly clock: () => number;
  private currentGeneration = 0;
  private active = false;

  constructor(options: StreamerSnapshotCacheOptions = {}) {
    this.staleAfterMs = Math.max(0, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
    this.clock = options.clock ?? Date.now;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Start an isolated socket generation and discard rows from the prior socket. */
  beginGeneration(): number {
    this.currentGeneration += 1;
    this.active = true;
    this.entries.clear();
    return this.currentGeneration;
  }

  /** Mark the current socket generation inactive without accepting late data. */
  deactivateGeneration(generation = this.currentGeneration): void {
    if (generation === this.currentGeneration) this.active = false;
  }

  clear(): void {
    this.entries.clear();
  }

  get<S extends StreamerService>(service: S, key: string, now = this.clock()): StreamerSnapshotEntry<S> | undefined {
    const entry = this.entries.get(cacheKey(service, key)) as StreamerSnapshotEntry<S> | undefined;
    if (!entry) return undefined;
    const age = Math.max(0, now - entry.updatedAt);
    if (entry.freshness === 'fresh' && age > this.staleAfterMs) {
      return { ...entry, freshness: 'stale' };
    }
    return { ...entry };
  }

  applyPayload<S extends StreamerService>(
    service: S,
    payload: unknown,
    generation = this.currentGeneration,
  ): SnapshotPayloadResult<S> {
    try {
      const decoded = decodeStreamerServicePayload(service, payload);
      const results = decoded.content.map((row) => this.applyRow(service, decoded, row, generation));
      return {
        results,
        updates: results.flatMap((result) => result.update ? [result.update] : []),
      };
    } catch {
      return { results: [{ accepted: false, reason: 'invalid-payload' }], updates: [] };
    }
  }

  private applyRow<S extends StreamerService>(
    service: S,
    payload: TypedStreamerDataPayload<S>,
    row: StreamerServiceRow<S>,
    generation: number,
  ): SnapshotApplyResult<S> {
    if (!this.active || generation !== this.currentGeneration) {
      return { accepted: false, reason: 'inactive-generation' };
    }

    const key = rowKey(service, row);
    if (!key) return { accepted: false, reason: 'uncertain-order' };

    const timestamp = rowTimestamp(service, payload, row);
    const sequence = rowSequence(service, row);
    const mode = STREAMER_SERVICE_CONTRACTS[service].delivery;
    if (mode === 'all-sequence' && (service === 'CHART_EQUITY' || service === 'ACCT_ACTIVITY') && sequence === undefined) {
      return { accepted: false, reason: 'uncertain-order' };
    }
    const cacheKeyValue = cacheKey(service, key);
    const previous = this.entries.get(cacheKeyValue) as StreamerSnapshotEntry<S> | undefined;
    if (previous) {
      const ordering = compareOrdering(previous, timestamp, sequence);
      if (ordering === 'stale-timestamp') return { accepted: false, reason: ordering };
      if (ordering === 'stale-sequence') return { accepted: false, reason: ordering };
      if (ordering === 'duplicate') return { accepted: false, reason: ordering };
      if (ordering === 'uncertain-order') return { accepted: false, reason: ordering };
    } else if (timestamp === undefined && sequence === undefined) {
      return { accepted: false, reason: 'uncertain-order' };
    }

    const nextRow = mode === 'change' && previous
      ? ({ ...previous.row, ...row } as StreamerServiceRow<S>)
      : row;
    const now = this.clock();
    const entry: StreamerSnapshotEntry<S> = {
      service,
      key,
      row: nextRow,
      generation,
      freshness: timestamp !== undefined || sequence !== undefined ? 'fresh' : 'uncertain',
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(sequence === undefined ? {} : { sequence }),
      updatedAt: now,
    };
    this.entries.set(cacheKeyValue, entry);
    return { accepted: true, update: { entry, mode } };
  }
}

type OrderingResult = 'ok' | SnapshotDiscardReason;

function compareOrdering<S extends StreamerService>(
  previous: StreamerSnapshotEntry<S>,
  timestamp: number | undefined,
  sequence: number | undefined,
): OrderingResult {
  if (sequence !== undefined && previous.sequence !== undefined) {
    if (sequence < previous.sequence) return 'stale-sequence';
    if (sequence === previous.sequence) return 'duplicate';
    if (timestamp !== undefined && previous.timestamp !== undefined && timestamp < previous.timestamp) {
      return 'stale-timestamp';
    }
    return 'ok';
  } else if (sequence !== undefined || previous.sequence !== undefined) {
    return 'uncertain-order';
  }

  if (timestamp !== undefined && previous.timestamp !== undefined) {
    if (timestamp < previous.timestamp) return 'stale-timestamp';
    if (timestamp === previous.timestamp) return 'duplicate';
    return 'ok';
  }
  return 'uncertain-order';
}

function rowKey<S extends StreamerService>(service: S, row: StreamerServiceRow<S>): string | undefined {
  if (typeof row.key === 'string' && row.key.trim()) return row.key.trim();
  const candidate = row['0'];
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  if (service === 'ACCT_ACTIVITY' && typeof row['1'] === 'string' && row['1'].trim()) return row['1'].trim();
  return undefined;
}

function rowTimestamp<S extends StreamerService>(
  service: S,
  payload: TypedStreamerDataPayload<S>,
  row: StreamerServiceRow<S>,
): number | undefined {
  const candidates = service === 'CHART_EQUITY'
    ? [row['7'], payload.timestamp]
    : service === 'CHART_FUTURES'
      ? [row['1'], payload.timestamp]
      : service === 'NYSE_BOOK' || service === 'NASDAQ_BOOK' || service === 'OPTIONS_BOOK'
        ? [row['1'], payload.timestamp]
        : [payload.timestamp];
  return candidates.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function rowSequence<S extends StreamerService>(service: S, row: StreamerServiceRow<S>): number | undefined {
  const candidate = service === 'CHART_EQUITY' ? row['6'] : service === 'ACCT_ACTIVITY' ? row.seq : undefined;
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0) return candidate;
  if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  return undefined;
}

function cacheKey(service: StreamerService, key: string): string {
  return `${service}\u0000${key}`;
}

export type QueueOverflowPolicy = 'drop-oldest' | 'drop-newest' | 'error';

export interface QueuePushResult {
  accepted: boolean;
  dropped: number;
}

/** Small cancellable async queue with explicit bounded overflow semantics. */
export class BoundedAsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private closeError: unknown;
  private droppedItems = 0;

  constructor(
    private readonly capacity = 128,
    private readonly overflow: QueueOverflowPolicy = 'drop-oldest',
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Queue capacity must be a positive integer');
  }

  get dropped(): number {
    return this.droppedItems;
  }

  push(item: T): QueuePushResult {
    if (this.closed) return { accepted: false, dropped: 0 };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return { accepted: true, dropped: 0 };
    }
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return { accepted: true, dropped: 0 };
    }
    if (this.overflow === 'drop-newest') {
      this.droppedItems += 1;
      return { accepted: false, dropped: 1 };
    }
    if (this.overflow === 'error') {
      const error = new Error(`Streamer update queue overflow at capacity ${this.capacity}`);
      this.close(error);
      throw error;
    }
    this.items.shift();
    this.items.push(item);
    this.droppedItems += 1;
    return { accepted: true, dropped: 1 };
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) {
      return this.closeError ? Promise.reject(this.closeError) : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  async throw(error?: unknown): Promise<IteratorResult<T>> {
    this.close(error);
    throw error;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }
}

type StreamerEventSource = Pick<EventEmitter, 'on' | 'off'>;

export interface StreamerSnapshotConsumerOptions extends StreamerSnapshotCacheOptions {
  queueCapacity?: number;
  overflow?: QueueOverflowPolicy;
  onDiscard?: (result: SnapshotApplyResult) => void;
}

/**
 * Connects the opt-in cache to a StreamerClient-like EventEmitter. Socket open
 * events create a fresh generation; close/reconnecting events stop late rows.
 */
export class StreamerSnapshotConsumer<S extends StreamerService> implements AsyncIterable<StreamerSnapshotUpdate<S>> {
  readonly cache: StreamerSnapshotCache;
  private readonly queue: BoundedAsyncQueue<StreamerSnapshotUpdate<S>>;
  private readonly onDiscard?: (result: SnapshotApplyResult<S>) => void;
  private source?: StreamerEventSource;
  private generation = 0;
  private attached = false;

  constructor(
    readonly service: S,
    options: StreamerSnapshotConsumerOptions = {},
  ) {
    this.cache = new StreamerSnapshotCache(options);
    this.queue = new BoundedAsyncQueue(options.queueCapacity ?? 128, options.overflow ?? 'drop-oldest');
    this.onDiscard = options.onDiscard;
  }

  get dropped(): number {
    return this.queue.dropped;
  }

  attach(source: StreamerEventSource): void {
    if (this.attached) this.detach();
    this.source = source;
    this.attached = true;
    this.generation = this.cache.beginGeneration();
    source.on('open', this.handleOpen);
    source.on('close', this.handleClose);
    source.on('reconnecting', this.handleReconnecting);
    source.on('data', this.handleData);
  }

  detach(): void {
    if (!this.source) return;
    this.source.off('open', this.handleOpen);
    this.source.off('close', this.handleClose);
    this.source.off('reconnecting', this.handleReconnecting);
    this.source.off('data', this.handleData);
    this.cache.deactivateGeneration(this.generation);
    this.source = undefined;
    this.attached = false;
  }

  disconnect(): void {
    this.detach();
    this.queue.close();
  }

  getSnapshot(key: string): StreamerSnapshotEntry<S> | undefined {
    return this.cache.get(this.service, key);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamerSnapshotUpdate<S>> {
    return this.queue;
  }

  private readonly handleOpen = (): void => {
    this.generation = this.cache.beginGeneration();
  };

  private readonly handleClose = (): void => {
    this.cache.deactivateGeneration(this.generation);
  };

  private readonly handleReconnecting = (): void => {
    this.cache.deactivateGeneration(this.generation);
  };

  private readonly handleData = (payload: unknown): void => {
    const result = this.cache.applyPayload(this.service, payload, this.generation);
    for (const item of result.results) {
      if (!item.accepted) this.onDiscard?.(item as SnapshotApplyResult<S>);
    }
    for (const update of result.updates) this.queue.push(update);
  };
}
