import { createSdk, handleExampleError } from './shared.js';
import { createStreamerDebugger } from '../src/index.js';

/**
 * 订阅Level II买卖盘深度数据 - 显示完整的买卖队列
 * 使用增强调试器提供更详细的市场深度分析和可视化
 */
async function main(): Promise<void> {
  const sdk = createSdk({
    streamer: {
      autoReconnect: true,
      reconnectDelayMs: 2_000,
    },
  });

  // 解析命令行传入的订阅代码，默认监听 QQQ
  const keys = (process.argv[2] ?? 'QQQ')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .join(',');

  if (!keys) {
    console.warn('未提供有效的订阅代码。');
    return;
  }

  // 创建专门用于 Level II 数据的调试器
  const streamDebugger = createStreamerDebugger({
    verbose: true,
    showRawData: process.env.DEBUG_RAW === 'true',
    autoAnalyze: true,
    enableVisualization: true,
    enablePerformanceMonitoring: true,
    statisticsInterval: 30000
  });

  // 建立 Streamer 连接
  await sdk.connectStreamer();

  // 启动监控
  streamDebugger.startMonitoring(sdk.streamer);

  // 订阅NASDAQ Level II数据
  sdk.marketDataStream.subscribeNasdaqBook({ 
    keys,
    fields: '0,1,2,3'
  });
  
  console.log(`\n🚀 已订阅 NASDAQ_BOOK: ${keys}`);
  console.log('📡 开始接收Level II买卖盘数据...');
  console.log('💡 说明:');
  console.log('   - Level II数据显示完整的买卖盘深度');
  console.log('   - 包含多个价格层级和做市商信息');
  console.log('   - 比Level 1提供更详细的市场微观结构');
  console.log('   - 适合需要深度市场分析的交易策略');
  console.log('   - 按 Ctrl+C 可随时退出程序\n');
  console.log('─'.repeat(60));

  setTimeout(() => {
    sdk.disconnectStreamer();
    console.log('已主动断开 Streamer 连接。');
  }, 1000_000);
}

main().catch(handleExampleError);
