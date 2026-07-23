import { createSdk, handleExampleError } from './shared.js';

/**
 * 下载指定标的的历史价格数据，默认请求 AAPL 的近 10 天 5 分钟蜡烛。
 * 可通过命令行自定义：
 *   node dist/examples/download-price-history.js TSLA 30
 */
async function main(): Promise<void> {
  // 创建 SDK，并确保日志输出到统一作用域
  const sdk = createSdk();
  const symbol = process.argv[2] ?? 'AAPL';
  const period = Number(process.argv[3] ?? '10');

  if (!symbol.trim()) {
    console.error('请提供有效的证券代码，例如 AAPL');
    return;
  }
  if (Number.isNaN(period) || period <= 0) {
    console.error('周期参数必须为正整数，表示查询的天数。');
    return;
  }

  console.log(`准备拉取 ${symbol} 的最近 ${period} 天 5 分钟蜡烛数据`);
  const history = await sdk.marketData.getPriceHistory({
    symbol,
    periodType: 'day',
    period,
    frequencyType: 'minute',
    frequency: 5,
    needExtendedHoursData: true,
  });

  const candles = history.candles ?? [];
  console.log(`共返回 ${candles.length} 条蜡烛数据，示例：`);
  console.log(candles.slice(0, 5));
}

main().catch(handleExampleError);
