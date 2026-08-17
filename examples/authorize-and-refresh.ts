import { createSdk, formatTokenPreview, handleExampleError } from './shared.ts';
import * as readline from 'readline';

/**
 * 一体化授权流程：
 * 1. 检查是否已有有效令牌
 * 2. 如果没有，自动打开授权页面
 * 3. 等待用户输入回调URL或授权码
 * 4. 自动解析并完成授权
 * 
 * 使用方法：
 *   npm run example:authorize
 * 
 * 支持输入格式：
 *   - 完整的回调URL: https://127.0.0.1:8080/?code=xxx&state=xxx
 *   - 仅授权码: xxx
 */

/**
 * 从URL或字符串中提取授权码
 */
function extractCodeFromInput(input: string): string | null {
  const trimmedInput = input.trim();
  
  // 如果输入包含 URL，尝试解析
  if (trimmedInput.includes('code=')) {
    try {
      const url = new URL(trimmedInput);
      return url.searchParams.get('code');
    } catch {
      // 如果不是有效URL，尝试从字符串中提取
      const match = trimmedInput.match(/code=([^&\s]+)/);
      return match ? match[1] : null;
    }
  }
  
  // 如果输入不包含 code=，假设整个输入就是授权码
  return trimmedInput || null;
}

/**
 * 等待用户输入回调URL或授权码
 */
function waitForUserInput(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('\n请粘贴完整的回调URL或直接输入授权码: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  // 初始化 SDK（将自动读取 .env 配置并输出日志）
  const sdk = createSdk();
  
  // 首先检查是否已有有效令牌
  const cached = await sdk.tokenManager.getValidToken();
  if (cached) {
    console.log('已存在有效访问令牌：', formatTokenPreview(cached.access_token));
    console.log('过期时间：', new Date(cached.expires_at).toISOString());
    console.log('\n如需重新授权，请先删除本地令牌缓存。');
    return;
  }

  console.log('当前没有本地令牌，开始授权流程...\n');
  
  // 生成授权URL并尝试打开浏览器
  const state = 'demo-state';
  console.log('正在自动打开授权页面...');
  
  try {
    const url = await sdk.openAuthorizeUrl({ state });
    console.log('授权页面已打开。如果浏览器未自动打开，请复制以下链接手动访问：');
    console.log(url);
  } catch (error) {
    console.log('自动打开浏览器失败，请复制以下链接手动访问：');
    const fallbackUrl = sdk.createAuthorizeUrl({ state });
    console.log(fallbackUrl);
    console.log('失败原因：', error instanceof Error ? error.message : String(error));
  }

  // 等待用户输入
  const userInput = await waitForUserInput();
  
  // 提取授权码
  const code = extractCodeFromInput(userInput);
  
  if (!code) {
    console.error('无法从输入中提取授权码，请检查输入格式。');
    console.error('支持的格式：');
    console.error('  - 完整URL: https://127.0.0.1:8080/?code=xxx&state=xxx');
    console.error('  - 仅授权码: xxx');
    return;
  }

  console.log('\n正在使用授权码交换访问令牌...');
  
  try {
    // 使用授权码交换访问令牌
    const token = await sdk.exchangeCodeForToken(code);
    console.log('✅ 授权成功！令牌已写入本地缓存。');
    console.log('访问令牌有效期至：', new Date(token.expires_at).toISOString());
    console.log('访问令牌预览：', formatTokenPreview(token.access_token));
  } catch (error) {
    console.error('❌ 授权失败：', error instanceof Error ? error.message : String(error));
    console.error('请检查授权码是否正确，或重新进行授权流程。');
  }
}

main().catch(handleExampleError);
