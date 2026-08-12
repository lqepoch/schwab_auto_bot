import { performance } from 'node:perf_hooks';

/**
 * 可用的日志等级，`debug` 输出最详细，`error` 只打印严重错误。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 统一的日志接口定义，便于在不同模块之间注入自定义日志实现。
 */
export interface Logger {
  /** 输出调试级别日志，适用于诊断详细流程。 */
  debug(message: string, metadata?: Record<string, unknown>): void;
  /** 输出信息级别日志，用于提示关键步骤或状态变更。 */
  info(message: string, metadata?: Record<string, unknown>): void;
  /** 输出警告级别日志，用于提示潜在问题但程序仍可继续。 */
  warn(message: string, metadata?: Record<string, unknown>): void;
  /** 输出错误级别日志，表示操作失败或遇到异常。 */
  error(message: string, metadata?: Record<string, unknown>): void;
  /** 创建带作用域的子记录器，方便区分模块来源。 */
  child(scope: string): Logger;
}

/**
 * 控制日志等级的优先级映射，数值越小意味着输出越详细。
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface ConsoleLoggerOptions {
  /** 日志作用域名称，会在终端输出中展示，帮助快速定位。 */
  scope?: string;
  /** 最低输出的日志级别，默认 `info`。 */
  level?: LogLevel;
}

/**
 * 默认的控制台日志实现，会在输出中包含时间戳、作用域与元数据。
 */
export class ConsoleLogger implements Logger {
  /** Subclasses use these to preserve logger identity when creating children. */
  protected readonly scope?: string;
  protected readonly level: LogLevel;
  private readonly levelPriority: number;

  constructor(options: ConsoleLoggerOptions = {}) {
    // 保留构造配置，方便 child() 继承
    this.scope = options.scope;
    this.level = options.level ?? 'info';
    this.levelPriority = LOG_LEVEL_PRIORITY[this.level];
  }

  /**
   * 输出调试日志，包含高精度耗时信息，便于性能分析。
   */
  debug(message: string, metadata?: Record<string, unknown>): void {
    this.print('debug', message, metadata);
  }

  /**
   * 输出普通信息日志，用于标识业务关键节点。
   */
  info(message: string, metadata?: Record<string, unknown>): void {
    this.print('info', message, metadata);
  }

  /**
   * 输出警告日志，提醒用户注意潜在问题。
   */
  warn(message: string, metadata?: Record<string, unknown>): void {
    this.print('warn', message, metadata);
  }

  /**
   * 输出错误日志，用于记录异常详情。
   */
  error(message: string, metadata?: Record<string, unknown>): void {
    this.print('error', message, metadata);
  }

  /**
   * 创建带更细粒度作用域的子记录器，继承父级的日志级别设置。
   */
  child(scope: string): Logger {
    const childScope = this.scope ? `${this.scope}:${scope}` : scope;
    return new ConsoleLogger({ scope: childScope, level: this.level });
  }

  /**
   * 根据当前日志级别判断是否输出，并格式化日志内容。
   */
  private print(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    // 不满足输出条件时直接返回，避免额外计算。
    if (LOG_LEVEL_PRIORITY[level] < this.levelPriority) {
      return;
    }

    // 生成精确到毫秒的时间戳，帮助还原执行顺序。
    const timestamp = new Date().toISOString();
    const scope = this.scope ? `[${this.scope}]` : '';
    const levelLabel = level.toUpperCase().padEnd(5, ' ');

    // 组装基础日志文本。
    const baseMessage = `${timestamp} ${scope} ${levelLabel} ${message}`.trim();

    // 选择合适的控制台输出方法。
    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

    if (metadata && Object.keys(metadata).length > 0) {
      // 附带额外的结构化数据，便于追踪上下文信息。
      consoleMethod(baseMessage, metadata);
    } else {
      consoleMethod(baseMessage);
    }
  }
}

/**
 * 快捷工厂方法，简化默认记录器的创建。
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): ConsoleLogger {
  return new ConsoleLogger(options);
}

/**
 * 创建一个空实现的记录器，适用于完全关闭日志的场景。
 */
export function createNullLogger(): Logger {
  return {
    debug: () => {
      // 空实现，确保调用方无需判空即可调用。
    },
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createNullLogger(),
  };
}

/**
 * 生成带耗时统计的元数据对象，方便在日志中记录执行耗时。
 */
export function withDuration(startTime: number): Record<string, number> {
  // 使用 performance.now() 获取更高精度的毫秒值。
  const durationMs = performance.now() - startTime;
  return { durationMs: Number(durationMs.toFixed(2)) };
}

/**
 * 调试专用日志记录器，支持更多调试场景
 */
export class DebugLogger extends ConsoleLogger {
  private debugContext: Map<string, any> = new Map();
  
  constructor(options: ConsoleLoggerOptions = {}) {
    super({ ...options, level: 'debug' });
  }

  /**
   * 设置调试上下文
   */
  setContext(key: string, value: any): void {
    this.debugContext.set(key, value);
  }

  /**
   * 获取调试上下文
   */
  getContext(key: string): any {
    return this.debugContext.get(key);
  }

  /**
   * 清除调试上下文
   */
  clearContext(): void {
    this.debugContext.clear();
  }

  /**
   * 记录 API 调用
   */
  logApiCall(method: string, url: string, params?: any, duration?: number): void {
    const metadata: Record<string, any> = { method, url };
    if (params) metadata.params = params;
    if (duration !== undefined) metadata.durationMs = Number(duration.toFixed(2));
    
    this.debug(`API调用: ${method} ${url}`, metadata);
  }

  /**
   * 记录 Streamer 事件
   */
  logStreamerEvent(event: string, service?: string, details?: any): void {
    const metadata: Record<string, any> = { event };
    if (service) metadata.service = service;
    if (details) metadata.details = details;
    
    this.info(`Streamer事件: ${event}`, metadata);
  }

  /**
   * 记录数据质量问题
   */
  logDataQuality(service: string, symbol: string, qualityScore: number, issues?: string[]): void {
    const metadata: Record<string, any> = {
      service,
      symbol,
      qualityScore: Math.round(qualityScore * 100),
      severity: qualityScore < 0.5 ? 'high' : qualityScore < 0.8 ? 'medium' : 'low'
    };
    
    if (issues && issues.length > 0) {
      metadata.issues = issues;
    }

    if (qualityScore < 0.5) {
      this.error(`数据质量严重问题: ${service}/${symbol}`, metadata);
    } else if (qualityScore < 0.8) {
      this.warn(`数据质量问题: ${service}/${symbol}`, metadata);
    } else {
      this.debug(`数据质量正常: ${service}/${symbol}`, metadata);
    }
  }

  /**
   * 记录性能指标
   */
  logPerformanceMetric(operation: string, duration: number, threshold?: number): void {
    const metadata: Record<string, any> = {
      operation,
      durationMs: Number(duration.toFixed(2))
    };

    if (threshold !== undefined) {
      metadata.threshold = threshold;
      metadata.exceedsThreshold = duration > threshold;
    }

    if (threshold && duration > threshold) {
      this.warn(`性能警告: ${operation} 超出阈值`, metadata);
    } else {
      this.debug(`性能指标: ${operation}`, metadata);
    }
  }

  /**
   * 记录连接状态变化
   */
  logConnectionStatus(status: 'connecting' | 'connected' | 'disconnected' | 'error', details?: any): void {
    const metadata: Record<string, any> = { status };
    if (details) metadata.details = details;

    switch (status) {
      case 'connecting':
        this.info('🔄 正在连接', metadata);
        break;
      case 'connected':
        this.info('🟢 连接成功', metadata);
        break;
      case 'disconnected':
        this.warn('🔴 连接断开', metadata);
        break;
      case 'error':
        this.error('❌ 连接错误', metadata);
        break;
    }
  }

  /**
   * 记录错误并附加调试上下文
   */
  errorWithContext(message: string, error?: any): void {
    const metadata: Record<string, any> = {};
    
    // 附加调试上下文
    if (this.debugContext.size > 0) {
      metadata.context = Object.fromEntries(this.debugContext);
    }
    
    if (error) {
      metadata.error = error;
      if (error.stack) {
        metadata.stack = error.stack;
      }
    }

    this.error(message, metadata);
  }

  /**
   * 创建带操作名称的子记录器
   */
  forOperation(operationName: string): DebugLogger {
    const childLogger = new DebugLogger({ 
      scope: this.scope ? `${this.scope}:${operationName}` : operationName,
      level: this.level 
    });
    
    // 复制父级上下文
    for (const [key, value] of this.debugContext.entries()) {
      childLogger.setContext(key, value);
    }
    
    return childLogger;
  }
}

/**
 * 创建调试专用记录器
 */
export function createDebugLogger(options: ConsoleLoggerOptions = {}): DebugLogger {
  return new DebugLogger(options);
}

/**
 * 性能监控装饰器
 */
export function logExecutionTime(logger: Logger, operationName?: string) {
  return function <This, Args extends unknown[], Result>(
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Result>,
  ): TypedPropertyDescriptor<(this: This, ...args: Args) => Result> {
    const originalMethod = descriptor.value;
    if (!originalMethod) {
      return descriptor;
    }
    
    descriptor.value = function (this: This, ...args: Args): Result {
      const startTime = performance.now();
      const operation = operationName || `${target.constructor.name}.${String(propertyKey)}`;
      
      try {
        const result = originalMethod.apply(this, args);
        
        // 处理 Promise
        if (isPromiseLike(result)) {
          return result.then(
            (value) => {
              logger.debug(`操作完成: ${operation}`, withDuration(startTime));
              return value;
            },
            (error: unknown) => {
              logger.error(`操作失败: ${operation}`, { ...withDuration(startTime), error });
              throw error;
            },
          ) as Result;
        } else {
          logger.debug(`操作完成: ${operation}`, withDuration(startTime));
          return result;
        }
      } catch (error) {
        logger.error(`操作失败: ${operation}`, { ...withDuration(startTime), error });
        throw error;
      }
    };
    
    return descriptor;
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === 'function';
}
