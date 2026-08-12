import { isSuccessfulStreamerCommand, type StreamerCommandResponse } from '../types/streamer.js';
import { StreamerCommandError, StreamerCommandTimeoutError } from './streamerErrors.js';

type PendingCommand = {
  service: string;
  command: string;
  generation: number;
  resolve: (response: StreamerCommandResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type CommandTrackerRequest = {
  requestid: string;
  service: string;
  command: string;
  generation: number;
};

/**
 * Tracks Streamer command acknowledgements without coupling command state to a
 * particular WebSocket instance. A request is only resolved by a response from
 * the same socket generation that sent it.
 */
export class StreamerCommandTracker {
  private readonly pending = new Map<string, PendingCommand>();

  constructor(private readonly timeoutMs: number) {}

  track(request: CommandTrackerRequest): Promise<StreamerCommandResponse> {
    const existing = this.pending.get(request.requestid);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error(`Duplicate Streamer requestid: ${request.requestid}`));
      this.pending.delete(request.requestid);
    }

    return new Promise<StreamerCommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.requestid);
        if (!pending) return;
        this.pending.delete(request.requestid);
        reject(
          new StreamerCommandTimeoutError({
            service: pending.service,
            command: pending.command,
            requestid: request.requestid,
            timeoutMs: this.timeoutMs,
          }),
        );
      }, this.timeoutMs);

      this.pending.set(request.requestid, {
        service: request.service,
        command: request.command,
        generation: request.generation,
        resolve,
        reject,
        timer,
      });
    });
  }

  /** Resolves/rejects a request only when the response belongs to its socket. */
  handle(response: StreamerCommandResponse, generation: number): boolean {
    const requestid = String(response.requestid);
    const pending = this.pending.get(requestid);
    if (
      !pending
      || pending.generation !== generation
      || pending.service !== response.service
      || pending.command !== response.command
    ) return false;

    clearTimeout(pending.timer);
    this.pending.delete(requestid);
    if (isSuccessfulStreamerCommand(response.service, response.command, response.content.code)) {
      pending.resolve(response);
    } else {
      pending.reject(new StreamerCommandError(response));
    }
    return true;
  }

  cancel(requestid: string, error: Error): boolean {
    const pending = this.pending.get(requestid);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestid);
    pending.reject(error);
    return true;
  }

  rejectGeneration(generation: number, error: Error): void {
    for (const [requestid, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestid);
      pending.reject(error);
    }
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
