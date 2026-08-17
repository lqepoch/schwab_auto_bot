import { createSdk, handleExampleError } from './shared.ts';
import { createQuickDebugger } from '../src/index.ts';

/**
 * 多数据源综合监控 - 同时订阅多种数据流以获得更全面的市场信息
 * 包括Level 1、Chart数据和Level II Book数据
 * 
 * 使用方法:
 *   npm run example:stream-multi-data-sources [股票代码]
 *   例如: npm run example:stream-multi-data-sources QQQ,AAPL,MSFT
 * 
 * 环境变量:
 *   DEBUG_STREAMER=true  # 显示详细字段信息和原始数据调试信息
 * 
 * 数据源说明:
 *   - Level 1: 基础行情数据，包括最新价、买卖价、成交量等
 *     支持54个官方字段，包括价格、成交量、涨跌幅、52周高低点等
 *   - Chart: K线数据，提供OHLCV信息（可能因市场状态而不可用）
 *     支持9个字段，包括开高低收价格、成交量、时间戳等
 *   - Level II Book: 买卖盘深度数据，显示多层级报价和市场分布
 *     支持4个主字段，每个价格层级包含价格、数量、市场数和做市商详情
 * 
 * 字段定义参考:
 *   所有字段定义基于 Schwab API 官方文档，详见 src/utils/debugUtils.ts
 *   包含完整的字段映射、类型定义和描述信息
 */
async function main(): Promise<void> {
  const sdk = createSdk({
    streamer: {
      autoReconnect: true,
      reconnectDelayMs: 3_000,        // 增加重连延迟
      heartbeatTimeoutMs: 30_000,     // 心跳超时从15秒增加到30秒
      heartbeatCheckIntervalMs: 10_000 // 心跳检查间隔从5秒增加到10秒
    },
    httpTimeoutMs: 20_000             // HTTP超时也适当增加
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

  // 创建专用调试器
  const streamDebugger = createQuickDebugger(process.env.DEBUG_STREAMER === 'true');

  // 建立 Streamer 连接
  await sdk.connectStreamer();

  // 启动调试监控
  streamDebugger.startMonitoring(sdk.streamer);

  // 订阅多种数据源
  console.log(`\n🚀 开始订阅多种数据源: ${keys}`);
  
  // 1. Level 1 基础行情
  sdk.marketDataStream.subscribeLevelOneEquities({ 
    keys,
    fields: '0,1,2,3,4,5,8,9,18,42'
  });
  console.log('✅ 已订阅 Level 1 基础行情');
  
  // 2. Chart 1分钟K线数据
  try {
    sdk.marketDataStream.subscribeChartEquity({ 
      keys,
      frequency: '1',
      period: '1'
    });
    console.log('✅ 已订阅 Chart 1分钟K线');
  } catch (error) {
    console.log('❌ Chart订阅失败:', error);
    console.log('   💡 可能原因: 市场已收盘或Chart数据暂时不可用');
  }
  
  // 3. Level II Book数据
  sdk.marketDataStream.subscribeNasdaqBook({ 
    keys,
    fields: '0,1,2,3'
  });
  console.log('✅ 已订阅 Level II Book数据');

  console.log('\n📡 多数据源监控已启动!');
  console.log('💡 数据源说明:');
  console.log('   📈 Level 1: 基础最佳买卖价，更新频率较低');
  console.log('   📊 Chart: 1分钟K线数据，提供OHLCV信息');
  console.log('   📚 Book: 买卖盘深度，显示多层级报价');
  console.log('   ⚡ 组合使用可获得更全面的市场视图');
  console.log('   🔄 不同数据源的更新频率不同，这是正常现象');
  console.log('\n' + '─'.repeat(60));

  setTimeout(() => {
    sdk.disconnectStreamer();
    console.log('\n已主动断开 Streamer 连接。');
    
    // 打印最终诊断报告
    console.log('\n📊 最终诊断报告:');
    console.log(JSON.stringify(streamDebugger.getDiagnosticReport(), null, 2));
  }, 300_000); // 5分钟后自动断开
}

main().catch(handleExampleError);
