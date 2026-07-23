import EventEmitter from 'node:events';
import WebSocket from 'ws';
import { StreamerInfo } from '../types/trader.js';
import { Logger, createConsoleLogger } from '../utils/logger.js';
import { redactSensitive } from '../utils/redact.js';
import { cloneParameters, stableStringify } from '../utils/objectUtils.js';
import {
  StreamerCommandResponse,
  StreamerMessage,
  StreamerMessageSchema,
  StreamerNotifyPayload,
  StreamerRequestEnvelope,
  StreamerServiceRequest,
} from '../types/streamer.js';

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
}

export interface SubscriptionOptions {
  service: string;
  command?: 'SUBS' | 'ADD';
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

type StoredSubscription = {
  service: string;
  parameters?: Record<string, unknown>;
  command: 'SUBS' | 'ADD';
  replayCommand: 'SUBS' | 'ADD';
};

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
  private readonly subscriptions = new Map<string, StoredSubscription>();
  private connectionStatus: StreamerConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;

  constructor(options: StreamerClientOptions = {}) {
    super();
    this.options = options;
    this.logger = options.logger ?? createConsoleLogger({ scope: 'StreamerClient' });
    this.reconnectStrategy = this.resolveReconnectStrategy(options);
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
    this.setStatus('connecting');

    this.logger.info('开始建立 WebSocket 连接');
    await this.openSocket();
  }

  /**
   * 主动关闭当前 WebSocket 连接，同时清理自动重连定时器与心跳监控。
   */
  disconnect(): void {
    this.clearReconnectTimer();
    this.stopHeartbeatMonitor();
    this.stopClientPing();
    this.isLoggedIn = false;
    this.reconnectAttempts = 0;
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
  subscribe(options: SubscriptionOptions): void {
    if (!this.streamerInfo) {
      throw new Error('Streamer info not set. Call connect() first.');
    }

    const command = options.command ?? 'SUBS';
    const replayCommand: 'SUBS' | 'ADD' = command === 'ADD' ? 'SUBS' : command;
    const parameters = cloneParameters(options.parameters);
    const key = this.buildSubscriptionKey(options.service, parameters);
    const stored: StoredSubscription = {
      service: options.service,
      parameters,
      command,
      replayCommand,
    };

    this.subscriptions.set(key, stored);
    this.logger.info('记录订阅命令', { service: stored.service, command: stored.command, parameters: stored.parameters });

    if (this.isSocketReady()) {
      this.logger.info('WebSocket 已就绪，立即发送订阅', {
        service: stored.service,
        command: stored.command,
      });
      this.sendSubscription(stored, stored.command);
    } else {
      this.logger.debug('WebSocket 尚未登录完成，订阅将在登录成功后自动发送', { service: stored.service });
    }
  }

  /**
   * 取消指定订阅，并从自动恢复列表中移除。
   */
  unsubscribe(options: UnsubscribeOptions): void {
    if (!this.streamerInfo) {
      throw new Error('Streamer info not set. Call connect() first.');
    }
    const key = this.buildSubscriptionKey(options.service, options.parameters);
    const removed = this.subscriptions.delete(key);
    this.logger.info('取消订阅', { service: options.service, removed });

    if (this.isSocketReady()) {
      const request: StreamerServiceRequest = {
        service: options.service,
        command: 'UNSUBS',
        requestid: `${this.requestId++}`,
        SchwabClientCustomerId: this.streamerInfo.schwabClientCustomerId,
        SchwabClientCorrelId: this.streamerInfo.schwabClientCorrelId,
        parameters: options.parameters,
      };
      this.send({ requests: [request] });
    }
  }

  /**
   * 发送自定义的 Streamer 请求包裹。
   * @param payload 完整的 Streamer 请求对象，包含一个或多个 `requests`。
   */
  send(payload: StreamerRequestEnvelope): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.logger.debug('发送 WebSocket 消息', { payload: redactSensitive(payload) });
    socket.send(JSON.stringify(payload));
  }

  /**
   * 等待 WebSocket 完成登录流程。可用于确保在发送订阅前连接已经就绪。
   */
  async waitForReady(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.isSocketReady()) {
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

  /**
   * 打开 WebSocket 连接并挂载必要的事件监听，包括自动登录与心跳监控。
   */
  private async openSocket(): Promise<void> {
    if (!this.accessToken || !this.streamerInfo) {
      throw new Error('Missing access token or streamer info');
    }

    this.clearReconnectTimer();
    this.stopHeartbeatMonitor();
    this.stopClientPing();
    this.isLoggedIn = false;
    this.setStatus('connecting');

    const { streamerSocketUrl } = this.streamerInfo;
    const socket = new WebSocket(streamerSocketUrl);
    this.socket = socket;

    socket.on('open', () => {
      this.logger.info('Streamer WebSocket 已打开');
      this.lastHeartbeatAt = Date.now();
      this.startHeartbeatMonitor();
      this.startClientPing();
      this.emit('open');
      this.login();
    });

    socket.on('message', (data) => {
      this.logger.debug('收到 WebSocket 消息');
      let message: StreamerMessage;
      try {
        const parsed = JSON.parse(data.toString());
        message = StreamerMessageSchema.parse(parsed);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('解析 WebSocket 消息失败', { error: err.message });
        this.emit('error', err);
        return;
      }

      this.emit('message', message);

      for (const resp of message.response ?? []) {
        this.emit('response', resp);
        this.handleResponse(resp);
      }
      for (const payload of message.data ?? []) {
        this.emit('data', payload);
      }
      for (const notify of message.notify ?? []) {
        this.emit('notify', notify);
        this.handleNotify(notify);
      }
    });

    socket.on('close', (code, reason) => {
      this.logger.warn('Streamer WebSocket 已关闭', { code, reason: reason.toString() });
      this.stopHeartbeatMonitor();
      this.stopClientPing();
      this.isLoggedIn = false;
      this.setStatus('disconnected');
      this.emit('close', code, reason);
      this.scheduleReconnect();
    });

    socket.on('pong', () => {
      this.lastHeartbeatAt = Date.now();
      this.logger.debug('收到 WebSocket pong');
    });

    socket.on('error', (error) => {
      this.logger.error('Streamer WebSocket 错误', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
  }

  /**
   * 构造并发送 ADMIN/LOGIN 请求，用于完成 Streamer 的登录流程。
   */
  private login(): void {
    if (!this.streamerInfo || !this.accessToken) return;

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

    this.send(loginRequest);
  }

  /**
   * 处理服务端返回的命令响应，特别关注登录结果并触发后续流程。
   */
  private handleResponse(response: StreamerCommandResponse): void {
    if (response.service !== 'ADMIN' || response.command !== 'LOGIN') {
      return;
    }

    if (response.content.code === 0) {
      this.logger.info('Streamer 登录成功');
      this.isLoggedIn = true;
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      this.replaySubscriptions();
      this.emit('ready');
    } else {
      this.logger.error('Streamer 登录失败', {
        code: response.content.code,
        message: response.content.msg,
      });
      this.setStatus('disconnected');
      this.emit('error', new Error(`Streamer login failed: ${response.content.code} ${response.content.msg}`));
    }
  }

  /**
   * 处理 notify 类型消息，目前仅追踪心跳时间戳。
   */
  private handleNotify(notify: StreamerNotifyPayload): void {
    if (notify.heartbeat) {
      this.lastHeartbeatAt = Date.now();
      this.logger.debug('收到心跳', { heartbeat: notify.heartbeat });
    }
  }

  /**
   * 根据配置调度下一次自动重连，超出尝试次数时会停止重连。
   */
  private scheduleReconnect(): void {
    if (!this.options.autoReconnect) {
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
        this.emit('error', err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * 根据指数退避策略计算重连等待时间，支持固定间隔与随机抖动。
   */
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

  /**
   * 解析并标准化自动重连策略，填充默认值确保后续逻辑统一。
   */
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

  /**
   * 清理正在等待执行的重连定时器，避免重复触发。
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 启动客户端 ping 机制，定期向服务器发送 ping 包辅助检测断线。
   */
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

  /**
   * 停止客户端 ping 定时器。
   */
  private stopClientPing(): void {
    if (this.clientPingTimer) {
      clearInterval(this.clientPingTimer);
      this.clientPingTimer = null;
    }
  }

  /**
   * 启动心跳检测，超时后会触发重连流程。
   */
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

  /**
   * 停止心跳检测定时器。
   */
  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 当检测到心跳超时时执行，主动断开连接并尝试重连。
   */
  private handleHeartbeatTimeout(): void {
    this.stopHeartbeatMonitor();
    this.stopClientPing();
    this.isLoggedIn = false;
    this.setStatus('disconnected');
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.terminate();
    }
    this.emit('error', new Error('Streamer heartbeat timeout'));
  }

  /**
   * 判断当前 WebSocket 是否已建立且通过登录校验。
   */
  private isSocketReady(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && this.isLoggedIn);
  }

  /**
   * 在重连成功后重新发送所有缓存的订阅命令。
   */
  private replaySubscriptions(): void {
    if (!this.isSocketReady()) {
      return;
    }
    for (const subscription of this.subscriptions.values()) {
      this.logger.info('重新发送订阅', {
        service: subscription.service,
        command: subscription.replayCommand,
      });
      this.sendSubscription(subscription, subscription.replayCommand);
    }
  }

  /**
   * 将订阅命令包装为请求并发送到 Streamer 服务。
   */
  private sendSubscription(subscription: StoredSubscription, command: 'SUBS' | 'ADD'): void {
    if (!this.streamerInfo) {
      throw new Error('Streamer info not set. Call connect() first.');
    }
    const request: StreamerServiceRequest = {
      service: subscription.service,
      command,
      requestid: `${this.requestId++}`,
      SchwabClientCustomerId: this.streamerInfo.schwabClientCustomerId,
      SchwabClientCorrelId: this.streamerInfo.schwabClientCorrelId,
      parameters: subscription.parameters,
    };
    this.send({ requests: [request] });
  }

  /**
   * 构造订阅缓存的唯一键，保证对象顺序不同也能识别为同一订阅。
   */
  private buildSubscriptionKey(service: string, parameters?: Record<string, unknown>): string {
    if (!parameters) {
      return service;
    }
    return `${service}:${stableStringify(parameters)}`;
  }
}
