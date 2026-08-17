import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parse } from 'dotenv';
import { createConsoleLogger } from '../src/utils/logger.js';

/**
 * 统一的日志记录器，确保交互式流程每一步都有清晰输出。
 */
const logger = createConsoleLogger({ scope: 'setup-env', level: 'info' });

type EnvKey = 'SCHWAB_CLIENT_ID' | 'SCHWAB_CLIENT_SECRET' | 'SCHWAB_REDIRECT_URI' | 'SCHWAB_TOKEN_PATH';

interface EnvAnswers {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath?: string;
}

/**
 * 从磁盘加载已存在的 .env 文件，若读取失败则返回空对象。
 * @param filePath 需要读取的文件路径。
 */
async function loadExistingEnv(filePath: string): Promise<Partial<Record<EnvKey, string>>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = parse(raw);
    logger.info('检测到已存在的 .env 配置，将作为默认值使用', { filePath });
    return parsed as Partial<Record<EnvKey, string>>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('读取现有 .env 文件失败，将忽略该文件', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      logger.info('未找到现有的 .env 文件，将创建新文件', { filePath });
    }
    return {};
  }
}

/**
 * 将用户的输入内容进行裁剪，避免出现多余的空白字符。
 * @param value 用户输入的原始文本。
 */
function sanitizeInput(value: string): string {
  return value.trim();
}

/**
 * 对敏感信息进行脱敏展示，只保留前后若干字符以便确认。
 * @param value 需要脱敏的原始字符串。
 */
function maskSensitive(value: string): string {
  if (value.length <= 6) {
    return value;
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

/**
 * 将环境变量对象序列化为写入 .env 的格式。
 * @param answers 用户最终确认的环境变量内容。
 */
function buildEnvFileContent(answers: EnvAnswers): string {
  const lines: string[] = [
    '# Charles Schwab OAuth 配置文件',
    '# 由 npm run setup 自动生成，如需调整可重新运行该命令。',
    `SCHWAB_CLIENT_ID=${answers.clientId}`,
    `SCHWAB_CLIENT_SECRET=${answers.clientSecret}`,
    `SCHWAB_REDIRECT_URI=${answers.redirectUri}`,
  ];

  if (answers.tokenPath) {
    lines.push(`SCHWAB_TOKEN_PATH=${answers.tokenPath}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * 提示用户输入必要的信息，并在缺少必填项时循环追问。
 * @param question 用于提示用户的完整文案。
 * @param defaultValue 当前建议的默认值，用户直接回车即可沿用。
 * @param validator 返回 true 表示输入合法；返回 false 会继续追问。
 * @param errorMessage 输入非法时展示的提示语。
 * @param rl readline 实例，用于与用户交互。
 */
async function promptUntilValid(
  question: string,
  defaultValue: string | undefined,
  validator: (value: string) => boolean,
  errorMessage: string,
  rl: ReturnType<typeof createInterface>,
): Promise<string> {
  while (true) {
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    const answer = await rl.question(`${question}${suffix}: `);
    const rawInput = answer.length > 0 ? answer : defaultValue ?? '';
    const sanitized = sanitizeInput(rawInput);
    if (validator(sanitized)) {
      return sanitized;
    }
    if (errorMessage) {
      logger.warn(errorMessage);
    }
  }
}

/**
 * 主入口：交互式生成 .env 文件，确保项目能够顺利运行示例脚本。
 */
async function main(): Promise<void> {
  const envPath = path.resolve(process.cwd(), '.env');
  logger.info('即将生成或更新环境变量文件', { envPath });

  const existing = await loadExistingEnv(envPath);
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const clientId = await promptUntilValid(
      '请输入 Schwab Client ID（格式类似 ABCD@AMER.OAUTHAP）',
      existing.SCHWAB_CLIENT_ID ?? process.env.SCHWAB_CLIENT_ID,
      (value) => value.length > 0,
      'Client ID 不能为空，请重新输入。',
      rl,
    );

    const clientSecret = await promptUntilValid(
      '请输入 Schwab Client Secret（请妥善保管，不会回显）',
      existing.SCHWAB_CLIENT_SECRET ?? process.env.SCHWAB_CLIENT_SECRET,
      (value) => value.length > 0,
      'Client Secret 不能为空，请重新输入。',
      rl,
    );

    const redirectUri = await promptUntilValid(
      '请输入 OAuth Redirect URI（需与 Schwab 后台配置一致）',
      existing.SCHWAB_REDIRECT_URI ?? process.env.SCHWAB_REDIRECT_URI,
      (value) => value.length > 0 && value.includes('://'),
      'Redirect URI 不能为空，且必须包含协议（如 https://）。',
      rl,
    );

    const tokenPath = await promptUntilValid(
      '可选：自定义令牌缓存文件路径（留空使用默认 .schwab_tokens.json）',
      existing.SCHWAB_TOKEN_PATH ?? process.env.SCHWAB_TOKEN_PATH,
      () => true,
      '',
      rl,
    );

    const answers: EnvAnswers = {
      clientId,
      clientSecret,
      redirectUri,
      tokenPath: tokenPath.length > 0 ? tokenPath : undefined,
    };

    logger.info('已收集用户输入，开始写入 .env', {
      clientId: maskSensitive(clientId),
      redirectUri,
      tokenPath: answers.tokenPath,
    });

    await fs.writeFile(envPath, buildEnvFileContent(answers), 'utf-8');

    logger.info('环境变量写入成功，可以立即运行示例脚本');
    logger.info('下一步建议执行：npm run example:authorize -- --open');
  } finally {
    await rl.close();
  }
}

main().catch((error) => {
  logger.error('生成 .env 过程中出现异常', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
