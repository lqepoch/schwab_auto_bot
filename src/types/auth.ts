import { z } from 'zod';

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_expires_in: z.number().int().positive().optional(),
  token_type: z.string().min(1).default('Bearer'),
});

export const RefreshTokenResponseSchema = TokenResponseSchema.extend({
  refresh_token: z.string().min(1).optional(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>;

export const PersistedTokenSchema = TokenResponseSchema.extend({
  obtained_at: z.number().int(),
  expires_at: z.number().int(),
});

export type PersistedToken = z.infer<typeof PersistedTokenSchema>;

export interface AuthorizationCodeParams {
  state?: string;
  scope?: string;
}

export interface SchwabAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /**
   * 自定义 TokenStore 文件路径。默认写入 `process.cwd()` 下的 `.schwab_tokens.json`，
   * 在以服务或定时任务方式运行时，建议显式传入绝对路径或通过 `SCHWAB_TOKEN_PATH`
   * 环境变量指定，以避免当前工作目录变化导致找不到缓存文件。
   */
  tokenStorePath?: string;
  tokenSafetyWindowMs?: number;
}
