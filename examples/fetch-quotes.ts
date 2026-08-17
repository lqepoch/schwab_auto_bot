import { createSdk, handleExampleError } from './shared.js';

/**
 * 快速查询批量行情，默认拉取 AAPL 与 QQQ，可通过命令行参数自定义：
 *   node dist/examples/fetch-quotes.js TSLA,MSFT
 */
async function main(): Promise<void> {
  // 初始化 SDK 并输出基础日志
  const sdk = createSdk();
  const rawSymbols = process.argv[2] ?? 'AAPL,QQQ';
  // 将输入的逗号分隔字符串规范化为数组
  const symbols = rawSymbols
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (!symbols.length) {
    console.warn('未提供有效的标的代码。');
    return;
  }

  console.log('准备查询以下标的：', symbols.join(', '));
  const quotes = await sdk.marketData.getQuotes({ symbols });
  for (const symbol of symbols) {
    // 遍历每个标的并输出关键字段，便于快速比对
    const quote = quotes[symbol];
    const lastPrice = quote?.quote?.lastPrice ?? quote?.quote?.mark ?? 'N/A';
    console.log(`${symbol}:`, {
      lastPrice,
      bid: quote?.quote?.bidPrice ?? null,
      ask: quote?.quote?.askPrice ?? null,
      volume: quote?.quote?.totalVolume ?? null,
    });
  }
}

main().catch(handleExampleError);
