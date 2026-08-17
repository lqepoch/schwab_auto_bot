import { createSdk, handleExampleError } from './shared.ts';

/**
 * 订阅账户活动推送，自动获取首个账户的 `hashValue` 并打印收到的通知。
 */
async function main(): Promise<void> {
  const sdk = createSdk({
    streamer: {
      autoReconnect: true,
      reconnectDelayMs: 3_000,
    },
  });

  console.log('正在获取账号列表以确定订阅目标…');
  const accounts = await sdk.trader.getAccountNumbers();
  const primaryAccount = accounts[0];

  if (!primaryAccount) {
    console.error('当前授权下未找到任何账户，无法订阅账户活动。');
    return;
  }

  console.log('准备订阅账户活动，账号：', primaryAccount.accountNumber);
  await sdk.connectStreamer();

  sdk.streamer.on('notify', (payload) => {
    console.log('[NOTIFY]', payload);
  });
  sdk.streamer.on('data', (payload) => {
    if (payload.service === 'ACCT_ACTIVITY') {
      console.log('[ACCT_ACTIVITY]', payload.content);
    }
  });

  sdk.marketDataStream.subscribeAccountActivity({ keys: primaryAccount.hashValue });
  console.log('订阅已发送，等待服务器推送。按 Ctrl+C 退出。');
}

main().catch(handleExampleError);
