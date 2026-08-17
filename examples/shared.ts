import { SchwabOwokit, SchwabApiError, createConsoleLogger } from '../src/index.ts';
import type { SchwabOwokitOptions } from '../src/index.ts';

const exampleLogger = createConsoleLogger({ scope: 'Examples', level: 'info' });

/**
 * 创建 SDK 实例并自动读取 `.env` 中的凭据。
 * @param options 可覆盖默认配置，例如：
 *  - `options.logLevel`: 控制日志详细程度，可填 `debug`/`info`/`warn`/`error`
 *  - `options.streamer`: 自定义自动重连、重试间隔等 Streamer 行为
 *  - `options.logger`: 注入自定义日志实现，默认使用带作用域的控制台输出
 */
export function createSdk(options?: SchwabOwokitOptions): SchwabOwokit {
  // 合并示例默认的日志配置，确保输出集中在一个作用域下
  const mergedOptions: SchwabOwokitOptions = {
    ...options,
    logger: options?.logger ?? exampleLogger.child('SDK'),
  };
  try {
    const sdk = SchwabOwokit.fromEnvironment(mergedOptions);
    exampleLogger.info('SDK 已成功初始化');
    return sdk;
  } catch (error) {
    exampleLogger.error('SDK 初始化失败，请确认环境变量配置是否完整', { error });
    throw error;
  }
}

/**
 * 将访问令牌截断为更友好的展示形式，避免在日志中泄露完整字符串。
 */
export function formatTokenPreview(token: string): string {
  // 若令牌长度足够，则保留前 6 位与后 4 位用于辨识
  if (token.length <= 10) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

/**
 * 统一的示例脚本错误处理逻辑，针对 API 错误输出完整 JSON。
 */
export function handleExampleError(error: unknown): never {
  if (error instanceof SchwabApiError) {
    exampleLogger.error('Schwab API 调用失败', error.toJSON());
  } else {
    exampleLogger.error('脚本执行失败', { error });
  }
  process.exit(1);
}
