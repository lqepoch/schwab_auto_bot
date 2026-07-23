import { createSdk, handleExampleError } from './shared.js';
import { createStreamerDebugger } from '../src/index.js';

/**
 * 数据流调试工具 - 专门用来诊断各种数据流的问题
 * 使用增强的 StreamerDebugger 显示原始数据结构和详细分析
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

  // 创建高级调试器，启用所有调试功能
  const streamDebugger = createStreamerDebugger({
    verbose: true,
    showRawData: true,
    autoAnalyze: true,
    enableVisualization: true,
    enablePerformanceMonitoring: true,
    statisticsInterval: 30000
  });

  // 建立 Streamer 连接
  await sdk.connectStreamer();

  // 启动全面监控
  streamDebugger.startMonitoring(sdk.streamer);

  // 按顺序订阅不同的数据源
  console.log(`\n🚀 开始调试订阅: ${keys}`);
  console.log('📡 将按顺序订阅不同数据源...\n');

  // 1. 先订阅Level 1
  console.log('1️⃣ 订阅Level 1基础行情...');
  sdk.marketDataStream.subscribeLevelOneEquities({ 
    keys,
    fields: '0,1,2,3,4,5,8,9,18,42'
  });
  
  // 等待3秒再订阅Chart
  setTimeout(() => {
    console.log('\n2️⃣ 订阅Chart数据...');
    try {
      sdk.marketDataStream.subscribeChartEquity({ 
        keys,
        frequency: '1',
        period: '1'
      });
    } catch (error) {
      console.log('Chart订阅异常:', error);
    }
  }, 3000);
  
  // 等待6秒再订阅Book
  setTimeout(() => {
    console.log('\n3️⃣ 订阅Level II Book数据...');
    try {
      sdk.marketDataStream.subscribeNasdaqBook({ 
        keys,
        fields: '0,1,2,3'
      });
    } catch (error) {
      console.log('Book订阅异常:', error);
    }
  }, 6000);

  console.log('\n💡 调试说明:');
  console.log('   - 此脚本将显示所有原始数据结构');
  console.log('   - 帮助理解为什么某些字段为空或undefined');
  console.log('   - Chart数据可能在市场收盘后不可用');
  console.log('   - Book数据结构可能与文档不完全一致');
  console.log('   - 按 Ctrl+C 退出\n');

  setTimeout(() => {
    sdk.disconnectStreamer();
    console.log('\n已主动断开调试连接。');
  }, 120_000); // 2分钟后自动断开
}

main().catch(handleExampleError);
