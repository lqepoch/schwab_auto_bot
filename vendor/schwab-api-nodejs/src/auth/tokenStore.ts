import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersistedToken, PersistedTokenSchema } from '../types/auth.js';
import { Logger, createConsoleLogger } from '../utils/logger.js';

export interface TokenStoreOptions {
  filePath?: string;
  logger?: Logger;
  logScope?: string;
  lockRetryDelayMs?: number;
  lockAcquireTimeoutMs?: number;
  staleLockThresholdMs?: number;
}

const DEFAULT_FILENAME = '.schwab_tokens.json';
const DEFAULT_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const MIN_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_STALE_LOCK_MULTIPLIER = 2;

interface LockMetadata {
  pid: number;
  hostname: string;
  createdAt: number;
  ownerId: string;
}

/**
 * 简单的文件型令牌存储器。默认写入当前工作目录下的 `.schwab_tokens.json`，
 * 用于跨进程、跨重启缓存 OAuth 访问令牌。
 */
export class TokenStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly lockPath: string;
  private readonly lockRetryDelayMs: number;
  private readonly lockAcquireTimeoutMs: number;
  private readonly staleLockThresholdMs: number;
  private readonly lockOwners = new WeakMap<FileHandle, string>();

  constructor(options: TokenStoreOptions = {}) {
    this.filePath = options.filePath ?? path.join(process.cwd(), DEFAULT_FILENAME);
    this.logger = (options.logger ?? createConsoleLogger({ scope: 'TokenStore' })).child(
      options.logScope ?? path.basename(this.filePath),
    );
    this.lockPath = `${this.filePath}.lock`;
    const retryDelay = options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
    this.lockRetryDelayMs = Math.max(MIN_LOCK_RETRY_DELAY_MS, retryDelay);
    const timeout = options.lockAcquireTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockAcquireTimeoutMs = Math.max(this.lockRetryDelayMs, timeout);
    const staleThreshold =
      options.staleLockThresholdMs ?? this.lockAcquireTimeoutMs * DEFAULT_STALE_LOCK_MULTIPLIER;
    this.staleLockThresholdMs = Math.max(this.lockAcquireTimeoutMs, staleThreshold);
  }

  /**
   * 读取本地缓存的令牌，若文件不存在或结构不完整返回 `null`。
   */
  async load(): Promise<PersistedToken | null> {
    // 记录读取开始，便于排查文件路径问题
    this.logger.info('尝试读取本地缓存的 OAuth 令牌', { path: this.filePath });
    const released = await this.waitForLockRelease();
    if (!released) {
      this.logger.error('等待令牌存储锁释放超时，将返回 null', {
        path: this.filePath,
        lockPath: this.lockPath,
        timeoutMs: this.lockAcquireTimeoutMs,
      });
      return null;
    }
    try {
      // 读取磁盘文件并解析 JSON
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsedJson = JSON.parse(raw);
      const parsedResult = PersistedTokenSchema.safeParse(parsedJson);
      if (!parsedResult.success) {
        this.logger.warn('令牌文件校验失败，忽略缓存', {
          path: this.filePath,
          issues: parsedResult.error.issues,
        });
        return null;
      }
      const parsed = parsedResult.data;
      this.logger.info('成功加载本地缓存令牌', { expiresAt: parsed.expires_at });
      return parsed;
    } catch (error) {
      // 文件缺失或解析失败视为无缓存
      this.logger.warn('未找到有效的令牌缓存，将返回 null', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 将最新令牌持久化到磁盘。
   */
  async save(token: PersistedToken): Promise<void> {
    // 写入前确保目录存在
    this.logger.info('准备写入令牌到磁盘', { path: this.filePath });
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(token, null, 2);
    let lockHandle: FileHandle | null = null;
    try {
      lockHandle = await this.acquireLock();
      const temporaryHandle = await fs.open(tempPath, 'w', 0o600);
      try {
        await temporaryHandle.writeFile(payload, 'utf-8');
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      await fs.rename(tempPath, this.filePath);
      const directoryHandle = await fs.open(path.dirname(this.filePath), 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      this.logger.info('令牌写入完成', { expiresAt: token.expires_at });
    } catch (error) {
      this.logger.error('令牌写入失败', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      await fs
        .unlink(tempPath)
        .catch((unlinkError: unknown) => {
          const err = unlinkError as NodeJS.ErrnoException;
          if (err?.code !== 'ENOENT') {
            this.logger.warn('清理令牌临时文件失败', {
              path: tempPath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      throw error;
    } finally {
      if (lockHandle) {
        await this.releaseLock(lockHandle);
      }
    }
  }

  /**
   * 返回当前令牌文件的绝对路径，便于在日志或调试时查看。
   */
  get path(): string {
    return this.filePath;
  }

  private async acquireLock(): Promise<FileHandle> {
    const start = Date.now();
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        const metadata = this.createLockMetadata();
        await handle.writeFile(JSON.stringify(metadata), { encoding: 'utf-8' });
        await handle.datasync().catch(() => undefined);
        this.lockOwners.set(handle, metadata.ownerId);
        this.logger.debug('成功获取令牌存储锁', { lockPath: this.lockPath, pid: process.pid });
        return handle;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== 'EEXIST') {
          this.logger.error('创建令牌存储锁文件失败', {
            path: this.lockPath,
            error: err instanceof Error ? err.message : String(err),
          });
          throw error;
        }
        if (await this.tryReclaimStaleLock()) {
          continue;
        }
        if (Date.now() - start >= this.lockAcquireTimeoutMs) {
          this.logger.error('获取令牌存储锁超时', {
            path: this.lockPath,
            timeoutMs: this.lockAcquireTimeoutMs,
          });
          throw new Error(`Timed out acquiring token store lock at ${this.lockPath}`);
        }
        await this.sleep(this.lockRetryDelayMs);
      }
    }
  }

  private async releaseLock(handle: FileHandle): Promise<void> {
    const ownerId = this.lockOwners.get(handle);
    this.lockOwners.delete(handle);
    try {
      await handle.close();
    } catch (error) {
      this.logger.warn('关闭令牌锁文件句柄失败', {
        path: this.lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!ownerId || !(await this.lockBelongsTo(ownerId))) {
      return;
    }
    try {
      await fs.unlink(this.lockPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        this.logger.warn('删除令牌锁文件失败', {
          path: this.lockPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async waitForLockRelease(): Promise<boolean> {
    const start = Date.now();
    while (true) {
      try {
        await fs.access(this.lockPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
          return true;
        }
        this.logger.warn('检查令牌锁文件状态失败，视为可继续', {
          path: this.lockPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }

      if (await this.tryReclaimStaleLock()) {
        continue;
      }

      if (Date.now() - start >= this.lockAcquireTimeoutMs) {
        return false;
      }
      await this.sleep(this.lockRetryDelayMs);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private createLockMetadata(): LockMetadata {
    return {
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: Date.now(),
      ownerId: randomUUID(),
    };
  }

  private async tryReclaimStaleLock(): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.readFile(this.lockPath, 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        return true;
      }
      this.logger.warn('读取令牌锁文件时出错，将保留现有锁', {
        path: this.lockPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const metadata = this.parseLockMetadata(raw);
    const now = Date.now();
    const reasons: string[] = [];

    if (!metadata) {
      reasons.push('锁文件内容无效');
    } else if (metadata.hostname === os.hostname()) {
      // A local PID protects a live owner even when its lease is old.
      if (this.isProcessAlive(metadata.pid)) {
        return false;
      }
      reasons.push(`PID ${metadata.pid} 不存在`);
    } else {
      // A PID is meaningful only on its originating host; foreign locks use
      // the lease timestamp and never probe the local process table.
      const age = now - metadata.createdAt;
      if (!Number.isFinite(age) || age < 0) {
        reasons.push('锁文件时间戳异常');
      } else if (age > this.staleLockThresholdMs) {
        reasons.push(`锁已存在 ${age}ms，超过阈值 ${this.staleLockThresholdMs}ms`);
      }
    }

    if (reasons.length === 0) {
      return false;
    }

    try {
      const currentRaw = await fs.readFile(this.lockPath, 'utf-8');
      const current = this.parseLockMetadata(currentRaw);
      if (!metadata || !current || current.ownerId !== metadata.ownerId) {
        return false;
      }
      await fs.unlink(this.lockPath);
      this.logger.warn('检测到陈旧的令牌锁文件，已清理', {
        path: this.lockPath,
        reasons,
        metadata,
      });
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        return true;
      }
      this.logger.warn('尝试清理令牌锁文件失败', {
        path: this.lockPath,
        reasons,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async lockBelongsTo(ownerId: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.lockPath, 'utf-8');
      return this.parseLockMetadata(raw)?.ownerId === ownerId;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') {
        this.logger.warn('验证令牌锁所有权失败，保留锁文件', {
          path: this.lockPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    }
  }

  private parseLockMetadata(raw: string): LockMetadata | null {
    try {
      const parsed = JSON.parse(raw) as Partial<LockMetadata>;
      if (
        typeof parsed?.pid === 'number' &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.createdAt === 'number' &&
        Number.isFinite(parsed.createdAt) &&
        typeof parsed.hostname === 'string' &&
        typeof parsed.ownerId === 'string' &&
        parsed.ownerId.length > 0
      ) {
        return {
          pid: parsed.pid,
          createdAt: parsed.createdAt,
          hostname: parsed.hostname,
          ownerId: parsed.ownerId,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ESRCH') {
        return false;
      }
      if (err?.code === 'EPERM') {
        return true;
      }
      return false;
    }
  }
}
