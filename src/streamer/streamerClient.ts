import EventEmitter from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { StreamerInfo } from '../types/trader.ts';
import { createConsoleLogger } from '../utils/logger.ts';
import type { Logger } from '../utils/logger.ts';
import { redactSensitive } from '../utils/redact.ts';
import {
  StreamerMessageSchema,
  isSuccessfulStreamerCommand,
} from '../types/streamer.ts';
import type {
  StreamerCommandResponse,
  StreamerMessage,
  StreamerNotifyPayload,
  StreamerRequestEnvelope,
  StreamerServiceRequest,
} from '../types/streamer.ts';
import {
  applySubscriptionMutation,
  cloneParameters,
  cloneState,
  parametersForState,
} from './subscriptionState.ts';
import type { CanonicalSubscriptionState, SubscriptionMutation } from './subscriptionState.ts';
import { StreamerCommandTracker } from './commandTracker.ts';
import { StreamerCommandError, StreamerCommandNotSentError, StreamerConnectionError } from './streamerErrors.ts';
import { createLifecycle, toError, type PendingLifecycle } from './streamerLifecycle.ts';
export interface StreamerClientOptions {
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  reconnectStrategy?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    maxAttempts?: number;
  };
  logger?: Logger;
  heartbeatCheckIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  clientPingIntervalMs?: number;
  /** Maximum time to wait for a Streamer command acknowledgement. */
  commandAckTimeoutMs?: number;
  /** Injectable WebSocket constructor for deterministic tests and custom transports. */
  webSocketFactory?: (url: string) => WebSocket;
}
export interface SubscriptionOptions {
  service: string;
  command?: 'SUBS' | 'ADD' | 'VIEW';
  parameters?: Record<string, unknown>;
}
export interface UnsubscribeOptions {
  service: string;
  parameters?: Record<string, unknown>;
}
export type StreamerConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
type StreamerEventMap = {
  open: [];
  close: [code: number, reason: Buffer];
  error: [error: Error];
  message: [message: StreamerMessage];
  data: [payload: NonNullable<StreamerMessage['data']>[number]];
  response: [payload: NonNullable<StreamerMessage['response']>[number]];
  notify: [payload: NonNullable<StreamerMessage['notify']>[number]];
  ready: [];
  reconnecting: [info: { attempt: number; delayMs: number }];
};
type ServiceCommand = 'SUBS' | 'ADD' | 'VIEW' | 'UNSUBS';
/**
 * WebSocket Streamer 基础客户端，负责登录、订阅命令下发与事件派发。
 */
export class StreamerClient extends EventEmitter {
  private readonly options: StreamerClientOptions;
  private readonly logger: Logger;
  private readonly reconnectStrategy: {
    initialDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
    maxAttempts: number | null;
    useConstantDelay: boolean;
  };
  private socket: WebSocket | null = null;
  private streamerInfo?: StreamerInfo;
  private accessToken?: string;
  private tokenProvider?: () => Promise<string>;
  private requestId = 1;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private clientPingTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAt: number | null = null;
  private isLoggedIn = false;
  private readonly subscriptionStates = new Map<string, CanonicalSubscriptionState>();
  private readonly subscriptionGenerations = new Map<string, number>();
  private readonly serviceQueues = new Map<string, Promise<void>>();
  private readonly commandTracker: StreamerCommandTracker;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private pendingAuthenticated: PendingLifecycle | null = null;
  private pendingReady: PendingLifecycle | null = null;
  private readyGeneration: number | null = null;
  private connectionStatus: StreamerConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private socketGeneration = 0;
  private forceReconnect = false;
  constructor(options: StreamerClientOptions = {}) {
    super();
    this.options = options;
    this.logger = options.logger ?? createConsoleLogger({ scope: 'StreamerClient' });
    this.reconnectStrategy = this.resolveReconnectStrategy(options);
    this.commandTracker = new StreamerCommandTracker(Math.max(1, options.commandAckTimeoutMs ?? 15_000));
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url, { handshakeTimeout: 15_000, perMessageDeflate: false }));
  }
  get status(): StreamerConnectionStatus {
    return this.connectionStatus;
  }
  override on<K extends keyof StreamerEventMap>(eventName: K, listener: (...args: StreamerEventMap[K]) => void): this {
    return super.on(eventName, listener);
  }
  override once<K extends keyof StreamerEventMap>(eventName: K, listener: (...args: StreamerEventMap[K]) => void): this {
    return super.once(eventName, listener);
  }
  override emit<K extends keyof StreamerEventMap>(eventName: K, ...args: StreamerEventMap[K]): boolean {
    return super.emit(eventName, ...args);
  }
  /**
   * 更新内部连接状态，并在状态切换时输出详细调试日志。
   */
  private setStatus(status: StreamerConnectionStatus): void {
    if (this.connectionStatus === status) {
      return;
    }
    this.logger.debug('更新 Streamer 状态', {
      previousStatus: this.connectionStatus,
      nextStatus: status,
    });
    this.connectionStatus = status;
  }
  /**
   * 建立 WebSocket 连接并完成后续登录步骤。
   * @param accessToken 通过 OAuth 获得的访问令牌，即 `access_token` 字段的原始值。
   * @param info 从 Trader API 的 `getStreamerInfo` 获取的登录参数集合。
   * @param provider 可选回调，重连前会调用以刷新访问令牌。
   */
  async connect(accessToken: string, info: StreamerInfo, provider?: () => Promise<string>): Promise<void> {
    this.accessToken = accessToken;
    this.streamerInfo = info;
    this.tokenProvider = provider;
    this.reconnectAttempts = 0;
    this.forceReconnect = false;
    this.setStatus('connecting');
    this.logger.info('开始建立 WebSocket 连接');
    await this.openSocket();
    await this.waitForReady({ timeoutMs: this.options.commandAckTimeoutMs ?? 15_000 });
  }
  /**
   * 主动关闭当前 WebSocket 连接，同时清理自动重连定时器与心跳监控。
   */
  disconnect(): void {
    this.clearReconnectTimer();
    this.stopHeartbeatMonitor();
    this.stopClientPing();
    this.commandTracker.rejectAll(new StreamerConnectionError('Streamer disconnected before command acknowledgement'));
    this.rejectLifecycle(this.pendingAuthenticated, new StreamerConnectionError('Streamer disconnected before login'));
    this.rejectLifecycle(this.pendingReady, new StreamerConnectionError('Streamer disconnected before ready'));
    this.pendingAuthenticated = null;
    this.pendingReady = null;
    this.readyGeneration = null;
    this.isLoggedIn = false;
    this.reconnectAttempts = 0;
    this.forceReconnect = false;
    this.socketGeneration += 1;
    this.setStatus('disconnected');
    if (this.socket) {
      this.logger.info('关闭现有 WebSocket 连接');
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }
  /**
   * 发送订阅命令到指定服务。会缓存订阅参数，重连后自动恢复。
   */
  async subscribe(options: SubscriptionOptions): Promise<void> {
    if (!this.streamerInfo) {
      throw new Error('Streamer info not set. Call connect() first.');
    }
    const command = options.command ?? 'SUBS';
    const parameters = cloneParameters(options.parameters);
    await this.waitForCommandReady();
    return this.enqueueService(options.service, async () => {
      const mutation = applySubscriptionMutation(
        this.subscriptionStates,
        this.subscriptionGenerations,
        command,
        options.service,
        parameters,
      );
      this.logger.info('记录订阅状态', {
        service: options.service,
        command,
        parameters,
        generation: this.subscriptionGenerations.get(options.service),
      });
      const commandGeneration = this.socketGeneration;
      try {
        this.logger.info('WebSocket 已就绪，立即发送订阅', { service: options.service, command });
        await this.sendServiceCommand(options.service, command, parameters, commandGeneration);
      } catch (error) {
        this.handleMutationFailure(mutation, error, commandGeneration);
        throw error;
      }
    });
  }
  /**
   * 取消指定订阅，并从自动恢复列表中移除。
   */
  async unsubscribe(options: UnsubscribeOptions): Promise<void> {
    if (!this.streamerInfo) {
      throw new Error('Streamer info not set. Call connect() first.');
    }
    const parameters = cloneParameters(options.parameters);
    await this.waitForCommandReady();
    return this.enqueueService(options.service, async () => {
      const previous = this.subscriptionStates.get(options.service);
      const mutation = applySubscriptionMutation(
        this.subscriptionStates,
        this.subscriptionGenerations,
        'UNSUBS',
        options.service,
        parameters,
      );
      this.logger.info('更新取消订阅状态', {
        service: options.service,
        removed: this.subscriptionStates.has(options.service) === false && previous !== undefined,
        parameters,
        generation: this.subscriptionGenerations.get(options.service),
      });
      const commandGeneration = this.socketGeneration;
      try {
        await this.sendServiceCommand(options.service, 'UNSUBS', parameters, commandGeneration);
      } catch (error) {
        this.handleMutationFailure(mutation, error, commandGeneration);
        throw error;
      }
    });
  }
  /**
   * 发送自定义的 Streamer 请求包裹。
   * @param payload 完整的 Streamer 请求对象，包含一个或多个 `requests`。
   */
  send(payload: StreamerRequestEnvelope): void {
    const socket = this.socket;
    if (!socket) throw new StreamerConnectionError('WebSocket is not open');
    this.sendOnSocket(socket, payload);
  }
  private sendOnSocket(socket: WebSocket, payload: StreamerRequestEnvelope): void {
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
      throw new StreamerConnectionError('WebSocket is not open');
    }
    this.logger.debug('发送 WebSocket 消息', { payload: redactSensitive(payload) });
    socket.send(JSON.stringify(payload));
  }
  /**
   * 等待 WebSocket 完成登录流程。可用于确保在发送订阅前连接已经就绪。
   */
  async waitForReady(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.isReady()) {
      return;
    }
    const { timeoutMs } = options;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        this.off('ready', handleReady);
        this.off('error', handleError);
        this.off('close', handleClose);
      };
      const handleReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const handleError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const handleClose = (code: number, reason: Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        const detail = reason?.toString() || 'no reason provided';
        reject(new Error(`Streamer connection closed before ready: ${code} ${detail}`));
      };
      this.on('ready', handleReady);
      this.on('error', handleError);
      this.on('close', handleClose);
      if (timeoutMs && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error(`Timed out waiting for Streamer ready event after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }
  private async waitForCommandReady(): Promise<void> {
    if (this.isReady()) return;
    const canWait = this.isSocketReady()
      || this.connectionStatus === 'connecting'
      || this.connectionStatus === 'reconnecting'
      || this.reconnectTimer !== null
      || (this.socket?.readyState === WebSocket.CONNECTING);
    if (!canWait) {
      throw new StreamerConnectionError('Streamer is not connected; command was not sent');
    }
    await this.waitForReady({ timeoutMs: this.options.commandAckTimeoutMs ?? 15_000 });
    if (!this.isReady()) {
      throw new StreamerConnectionError('Streamer did not become ready; command was not sent');
    }
  }
  private async openSocket(): Promise<void> {
    if (!this.accessToken || !this.streamerInfo) {
      throw new Error('Missing access token or streamer info');
    }
    this.clearReconnectTimer();
    this.stopHeartbeatMonitor();
    this.stopClientPing();
    this.isLoggedIn = false;
    this.setStatus('connecting');
    const previousSocket = this.socket;
    const previousGeneration = this.socketGeneration;
    if (previousSocket) {
      this.commandTracker.rejectGeneration(
        previousGeneration,
        new StreamerConnectionError('Streamer socket replaced before command acknowledgement'),
      );
      previousSocket.removeAllListeners();
      if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) {
        previousSocket.close();
      }
    }
    const { streamerSocketUrl } = this.streamerInfo;
    const socket = this.webSocketFactory(streamerSocketUrl);
    const generation = ++this.socketGeneration;
    this.socket = socket;
    this.pendingAuthenticated = createLifecycle(generation);
    this.pendingReady = null;
    this.readyGeneration = null;
    socket.on('open', () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.logger.info('Streamer WebSocket 已打开');
      this.lastHeartbeatAt = Date.now();
      this.startHeartbeatMonitor();
      this.startClientPing();
      this.emit('open');
      this.login(socket, generation);
    });
    socket.on('message', (data) => {
      this.handleSocketMessage(socket, generation, data);
    });
    socket.on('close', (code, reason) => {
      this.handleSocketClose(socket, generation, code, reason);
    });
    socket.on('pong', () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.lastHeartbeatAt = Date.now();
      this.logger.debug('收到 WebSocket pong');
    });
    socket.on('error', (error) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      const err = toError(error);
      this.logger.error('Streamer WebSocket 错误', {
        error: err.message,
      });
      this.emitError(err);
    });
  }
  private login(socket: WebSocket, generation: number): void {
    if (!this.streamerInfo || !this.accessToken || !this.isCurrentSocket(socket, generation)) return;
    this.isLoggedIn = false;
    this.logger.info('发送 ADMIN/LOGIN 请求');
    const loginRequest: StreamerRequestEnvelope = {
      requests: [
        {
          service: 'ADMIN',
          command: 'LOGIN',
          requestid: `${this.requestId++}`,
          SchwabClientCustomerId: this.streamerInfo.schwabClientCustomerId,
          SchwabClientCorrelId: this.streamerInfo.schwabClientCorrelId,
          parameters: {
            Authorization: this.accessToken,
            SchwabClientChannel: this.streamerInfo.schwabClientChannel,
            SchwabClientFunctionId: this.streamerInfo.schwabClientFunctionId,
          },
        },
      ],
    };
    const request = loginRequest.requests[0];
    if (!request) return;
    void this.sendTrackedRequest(socket, request, generation).catch((error) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      const err = toError(error);
      this.logger.error('Streamer 登录失败', { error: err.message });
      this.setStatus('disconnected');
      this.emitError(err);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });
  }
  private handleResponse(response: StreamerCommandResponse, generation: number): void {
    const handled = this.commandTracker.handle(response, generation);
    if (!handled || response.service !== 'ADMIN' || response.command !== 'LOGIN') {
      return;
    }
    if (isSuccessfulStreamerCommand(response.service, response.command, response.content.code)
      && generation === this.socketGeneration && this.socket) {
      this.logger.info('Streamer 登录成功');
      this.isLoggedIn = true;
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      this.resolveLifecycle(this.pendingAuthenticated);
      this.pendingAuthenticated = null;
      this.pendingReady = createLifecycle(generation);
      void this.replaySubscriptions(generation).then(
        () => {
          if (this.socketGeneration !== generation || this.socket === null || !this.pendingReady) return;
          this.forceReconnect = false;
          this.readyGeneration = generation;
          this.resolveLifecycle(this.pendingReady);
          this.pendingReady = null;
          this.emit('ready');
        },
        (error) => {
          const err = toError(error);
          this.rejectLifecycle(this.pendingReady, err);
          this.pendingReady = null;
          this.emitError(err);
          if (this.isCurrentSocket(this.socket!, generation)) this.socket?.close();
        },
      );
    } else if (response.content.code !== 0) {
      const err = new StreamerConnectionError(
        `Streamer login failed: ${response.content.code} ${response.content.msg}`,
        response.content.code,
      );
      this.rejectLifecycle(this.pendingAuthenticated, err);
      this.pendingAuthenticated = null;
      this.rejectLifecycle(this.pendingReady, err);
      this.pendingReady = null;
      this.readyGeneration = null;
      this.setStatus('disconnected');
      this.emitError(err);
      if (this.isCurrentSocket(this.socket!, generation)) this.socket?.close();
    }
  }
  private handleSocketMessage(socket: WebSocket, generation: number, data: RawData): void {
    if (!this.isCurrentSocket(socket, generation)) return;
    this.logger.debug('收到 WebSocket 消息');
    let message: StreamerMessage;
    try {
      const parsed = JSON.parse(data.toString());
      message = StreamerMessageSchema.parse(parsed);
    } catch (error) {
      const err = toError(error);
      this.logger.error('解析 WebSocket 消息失败', { error: err.message });
      this.emitError(err);
      return;
    }
    this.emit('message', message);
    for (const resp of message.response ?? []) {
      this.emit('response', resp);
      this.handleResponse(resp, generation);
    }
    for (const payload of message.data ?? []) {
      this.emit('data', payload);
    }
    for (const notify of message.notify ?? []) {
      this.emit('notify', notify);
      this.handleNotify(notify);
    }
  }
  private handleSocketClose(socket: WebSocket, generation: number, code: number, reason: Buffer): void {
    const detail = reason?.toString() || 'no reason provided';
    this.commandTracker.rejectGeneration(
      generation,
      new StreamerConnectionError(`Streamer connection closed: ${code} ${detail}`, code),
    );
    if (!this.isCurrentSocket(socket, generation)) return;
    this.logger.warn('Streamer WebSocket 已关闭', { code, reason: detail });
    this.stopHeartbeatMonitor();
    this.stopClientPing();
    this.isLoggedIn = false;
    this.socket = null;
    this.readyGeneration = null;
    this.rejectLifecycle(this.pendingAuthenticated, new StreamerConnectionError('Streamer connection closed before login', code));
    this.rejectLifecycle(this.pendingReady, new StreamerConnectionError('Streamer connection closed before ready', code));
    this.pendingAuthenticated = null;
    this.pendingReady = null;
    this.setStatus('disconnected');
    this.emit('close', code, reason);
    this.scheduleReconnect();
  }
  private handleNotify(notify: StreamerNotifyPayload): void {
    if (notify.heartbeat) {
      this.lastHeartbeatAt = Date.now();
      this.logger.debug('收到心跳', { heartbeat: notify.heartbeat });
    }
  }
  private scheduleReconnect(): void {
    if (!this.options.autoReconnect && !this.forceReconnect) {
      return;
    }
    this.clearReconnectTimer();
    const attempt = ++this.reconnectAttempts;
    const maxAttempts = this.reconnectStrategy.maxAttempts;
    if (maxAttempts !== null && attempt > maxAttempts) {
      this.logger.error('达到自动重连尝试上限，停止继续重连', { attempt, maxAttempts });
      this.setStatus('disconnected');
      return;
    }
    const delay = this.computeReconnectDelay(attempt - 1);
    this.setStatus('reconnecting');
    this.emit('reconnecting', { attempt, delayMs: delay });
    this.logger.warn('准备自动重连 Streamer WebSocket', { attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(async () => {
      this.logger.warn('尝试自动重连 Streamer WebSocket', { attempt });
      try {
        if (this.tokenProvider) {
          this.logger.info('重连前刷新访问令牌');
          this.accessToken = await this.tokenProvider();
        }
        if (!this.accessToken || !this.streamerInfo) {
          throw new Error('缺少重连所需的访问令牌或 Streamer 信息');
        }
        await this.openSocket();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('自动重连失败，将重试', { error: err.message });
        this.emitError(err);
        this.scheduleReconnect();
      }
    }, delay);
  }
  private computeReconnectDelay(attemptIndex: number): number {
    if (this.reconnectStrategy.useConstantDelay) {
      return Math.max(0, Math.round(this.reconnectStrategy.initialDelayMs));
    }
    const base = this.reconnectStrategy.initialDelayMs * Math.pow(this.reconnectStrategy.multiplier, attemptIndex);
    const capped = Math.min(base, this.reconnectStrategy.maxDelayMs);
    if (!Number.isFinite(capped) || capped <= 0) {
      return 0;
    }
    return Math.max(0, Math.round(Math.random() * capped));
  }
  private resolveReconnectStrategy(options: StreamerClientOptions): {
    initialDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
    maxAttempts: number | null;
    useConstantDelay: boolean;
  } {
    if (options.reconnectDelayMs !== undefined) {
      const fixed = Math.max(0, options.reconnectDelayMs);
      return {
        initialDelayMs: fixed,
        maxDelayMs: fixed,
        multiplier: 1,
        maxAttempts: null,
        useConstantDelay: true,
      };
    }
    const defaults = {
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      multiplier: 2,
      maxAttempts: null as number | null,
    };
    const strategy = options.reconnectStrategy ?? {};
    const initial = Math.max(0, strategy.initialDelayMs ?? defaults.initialDelayMs);
    const max = Math.max(initial, strategy.maxDelayMs ?? defaults.maxDelayMs);
    const multiplier = Math.max(1, strategy.multiplier ?? defaults.multiplier);
    const rawMaxAttempts = strategy.maxAttempts;
    const maxAttempts =
      rawMaxAttempts === undefined || rawMaxAttempts === null
        ? defaults.maxAttempts
        : Math.max(0, Math.floor(rawMaxAttempts));
    return {
      initialDelayMs: initial,
      maxDelayMs: max,
      multiplier,
      maxAttempts,
      useConstantDelay: false,
    };
  }
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  private startClientPing(): void {
    this.stopClientPing();
    const interval = this.options.clientPingIntervalMs ?? 30_000;
    if (interval <= 0) {
      return;
    }
    if (!this.socket || typeof this.socket.ping !== 'function') {
      return;
    }
    this.clientPingTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        this.logger.debug('发送 WebSocket ping');
        this.socket.ping();
      } catch (error) {
        this.logger.error('发送 WebSocket ping 失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, interval);
  }
  private stopClientPing(): void {
    if (this.clientPingTimer) {
      clearInterval(this.clientPingTimer);
      this.clientPingTimer = null;
    }
  }
  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor();
    const interval = this.options.heartbeatCheckIntervalMs ?? 5_000;
    const timeout = this.options.heartbeatTimeoutMs ?? 15_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.lastHeartbeatAt === null) {
        return;
      }
      const elapsed = Date.now() - this.lastHeartbeatAt;
      if (elapsed > timeout) {
        this.logger.error('检测到心跳超时，准备重新建立连接', { elapsed, timeout });
        this.handleHeartbeatTimeout();
      }
    }, interval);
  }
  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  private handleHeartbeatTimeout(): void {
    this.stopHeartbeatMonitor();
    this.stopClientPing();
    this.isLoggedIn = false;
    this.setStatus('disconnected');
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.terminate();
    }
    this.emitError(new Error('Streamer heartbeat timeout'));
  }
  private isSocketReady(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && this.isLoggedIn);
  }
  private isReady(): boolean {
    return this.isSocketReady() && this.readyGeneration === this.socketGeneration;
  }
  private async replaySubscriptions(generation: number): Promise<void> {
    if (!this.isSocketReady() || generation !== this.socketGeneration) return;
    const replays = [...this.subscriptionStates.keys()].map((service) =>
      this.enqueueService(service, async () => {
        const state = this.subscriptionStates.get(service);
        if (!state || !this.isSocketReady() || generation !== this.socketGeneration) {
          return;
        }
        const parameters = parametersForState(state);
        this.logger.info('重新发送 service 完整订阅', {
          service,
          command: 'SUBS',
          generation: state.generation,
          parameters,
        });
        await this.sendServiceCommand(service, 'SUBS', parameters, generation, true);
      }),
    );
    await Promise.all(replays);
  }
  private sendServiceCommand(
    service: string,
    command: ServiceCommand,
    parameters?: Record<string, unknown>,
    generation = this.socketGeneration,
    allowRecovery = false,
  ): Promise<void> {
    if (!this.streamerInfo) {
      return Promise.reject(new StreamerConnectionError('Streamer info not set. Call connect() first.'));
    }
    const socket = this.socket;
    if (!socket || generation !== this.socketGeneration || !(allowRecovery ? this.isSocketReady() : this.isReady())) {
      return Promise.reject(new StreamerCommandNotSentError('Streamer is not ready for service command'));
    }
    const request: StreamerServiceRequest = {
      service,
      command,
      requestid: `${this.requestId++}`,
      SchwabClientCustomerId: this.streamerInfo.schwabClientCustomerId,
      SchwabClientCorrelId: this.streamerInfo.schwabClientCorrelId,
      parameters: cloneParameters(parameters),
    };
    return this.sendTrackedRequest(socket, request, generation);
  }
  private sendTrackedRequest(
    socket: WebSocket,
    request: StreamerRequestEnvelope['requests'][number],
    generation: number,
  ): Promise<void> {
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new StreamerCommandNotSentError('Streamer is not open for service command'));
    }
    const requestid = String(request.requestid);
    const acknowledgement = this.commandTracker.track({
      requestid,
      service: request.service,
      command: request.command,
      generation,
    });
    try {
      this.sendOnSocket(socket, { requests: [request] });
    } catch (error) {
      const notSent = error instanceof StreamerCommandNotSentError
        ? error
        : new StreamerCommandNotSentError(`Streamer command was not sent: ${toError(error).message}`);
      this.commandTracker.cancel(requestid, notSent);
    }
    return acknowledgement.then(() => undefined);
  }
  private enqueueService(service: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.serviceQueues.get(service) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.serviceQueues.set(service, next);
    next.then(
      () => this.clearServiceQueue(service, next),
      () => this.clearServiceQueue(service, next),
    );
    return next;
  }
  private clearServiceQueue(service: string, completed: Promise<void>): void {
    if (this.serviceQueues.get(service) === completed) {
      this.serviceQueues.delete(service);
    }
  }
  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.socketGeneration === generation;
  }
  private rollbackMutation(mutation: SubscriptionMutation): void {
    if (this.subscriptionGenerations.get(mutation.service) !== mutation.generation) return;
    const previous = cloneState(mutation.previousState);
    if (previous) this.subscriptionStates.set(mutation.service, previous);
    else this.subscriptionStates.delete(mutation.service);
    this.logger.warn('Streamer 订阅命令失败，回滚本地 canonical state', {
      service: mutation.service,
      command: mutation.command,
      generation: mutation.generation,
    });
  }
  private handleMutationFailure(mutation: SubscriptionMutation, error: unknown, generation: number): void {
    if (error instanceof StreamerCommandError || error instanceof StreamerCommandNotSentError) {
      this.rollbackMutation(mutation);
      return;
    }
    if (generation !== this.socketGeneration) return;
    this.forceReconnect = true;
    this.readyGeneration = null;
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      if (!this.reconnectTimer) this.scheduleReconnect();
      return;
    }
    this.logger.warn('Streamer 命令 ACK 结果未知，保留 canonical state 并重连对账', {
      generation, error: toError(error).message,
    });
    socket.terminate();
  }
  private resolveLifecycle(lifecycle: PendingLifecycle | null): void {
    lifecycle?.resolve();
  }
  private rejectLifecycle(lifecycle: PendingLifecycle | null, error: Error): void {
    lifecycle?.reject(error);
  }
  private emitError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else {
      this.logger.error('Streamer 未注册 error listener', { error: error.message });
    }
  }
}
