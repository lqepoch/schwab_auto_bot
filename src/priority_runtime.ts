export type Priority = 0 | 1 | 2 | 3;

export type Job = {
  key: string;
  priority: Priority;
  run: () => Promise<void>;
  done?: () => void;
};

export class PriorityWriter {
  private readonly onError: (message: string) => void;
  private queues: Job[][] = [[], [], [], []];
  private keys = new Set<string>();
  private active = 0;
  private activeByPriority = [0, 0, 0, 0];
  private consecutiveHighPriority = 0;
  private readonly maxActive = 8;
  private readonly maxFollowupActive = 2;
  private readonly maxNonCriticalActive = 4;
  private readonly maxRefreshActive = 2;

  constructor(onError: (message: string) => void) {
    this.onError = onError;
  }

  enqueue(job: Job): void {
    if (this.keys.has(job.key)) return;
    this.keys.add(job.key);
    this.queues[job.priority].push(job);
    this.drain();
  }

  enqueueAndWait(job: Job): Promise<void> {
    return new Promise((resolve) => {
      if (this.keys.has(job.key)) {
        resolve();
        return;
      }
      this.enqueue({ ...job, done: resolve });
    });
  }

  async waitIdle(): Promise<void> {
    while (this.active > 0 || this.queues.some((queue) => queue.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private drain(): void {
    while (this.active < this.maxActive) {
      const nonCriticalActive = this.activeByPriority[2] + this.activeByPriority[3];
      const lowerPriorityPending = this.queues[1].length > 0
        || this.queues[2].length > 0
        || this.queues[3].length > 0;
      const shouldAgeLowerPriority = lowerPriorityPending && this.consecutiveHighPriority >= 4;
      const takeFollowup = (): Job | undefined => (
        this.activeByPriority[1] < this.maxFollowupActive ? this.queues[1].shift() : undefined
      );
      const takeNonCritical = (): Job | undefined => (
        nonCriticalActive < this.maxNonCriticalActive ? this.queues[2].shift() : undefined
      );
      const takeRefresh = (): Job | undefined => (
        nonCriticalActive < this.maxNonCriticalActive
        && this.activeByPriority[3] < this.maxRefreshActive
          ? this.queues[3].shift()
          : undefined
      );
      const job = shouldAgeLowerPriority
        ? (takeFollowup() ?? takeNonCritical() ?? takeRefresh() ?? this.queues[0].shift())
        : (this.queues[0].shift() ?? takeFollowup() ?? takeNonCritical() ?? takeRefresh());
      if (!job) return;
      this.consecutiveHighPriority = job.priority <= 1 ? this.consecutiveHighPriority + 1 : 0;
      this.active += 1;
      this.activeByPriority[job.priority] += 1;
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      await job.run();
    } catch (error) {
      const message = String(error);
      if (
        !message.includes("REFRESH_QUOTA_HEADROOM")
        && !message.includes("SELL_QUOTA_EXHAUSTED")
        && !message.includes("FOLLOWUP_QUOTA_HEADROOM")
        && !message.includes("CACHED_PREVIEW_REJECTED")
      ) this.onError(`任务失败 key=${job.key} error=${message}`);
    } finally {
      this.keys.delete(job.key);
      job.done?.();
      this.active -= 1;
      this.activeByPriority[job.priority] -= 1;
      this.drain();
    }
  }
}

export class PriorityGate {
  private queues: Array<Array<{
    priority: Priority;
    operation: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: unknown) => void;
  }>> = [[], [], [], []];
  private active = false;

  run<T>(priority: Priority, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[priority].push({ priority, operation, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const next = this.queues[0].shift() ?? this.queues[1].shift()
      ?? this.queues[2].shift() ?? this.queues[3].shift();
    if (!next) return;
    this.active = true;
    void next.operation().then(next.resolve, next.reject).finally(() => {
      this.active = false;
      this.drain();
    });
  }
}
