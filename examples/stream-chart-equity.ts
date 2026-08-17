import { createSdk, handleExampleError } from './shared.ts';

/**
 * 订阅图表数据流 - 提供更高频率的K线数据，比Level 1更详细
 * 这可以提供分钟级别的OHLCV数据，比Level 1的聚合数据更频繁
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

  // 建立 Streamer 连接
  await sdk.connectStreamer();

  sdk.streamer.on('data', (payload) => {
    if (payload.service === 'CHART_EQUITY') {
      console.log('\n=== CHART_EQUITY 图表数据流 ===');
      
      if (Array.isArray(payload.content)) {
        payload.content.forEach((item: any, index: number) => {
          console.log(`\n📊 K线数据 #${index + 1}:`);
          console.log(`🏷️  股票代码: ${item.key || item['0']}`);
          
          // 格式化K线数据
          if (item['1'] !== undefined) console.log(`📈 开盘价: $${item['1']}`);
          if (item['2'] !== undefined) console.log(`⬆️  最高价: $${item['2']}`);
          if (item['3'] !== undefined) console.log(`⬇️  最低价: $${item['3']}`);
          if (item['4'] !== undefined) console.log(`📉 收盘价: $${item['4']}`);
          if (item['5'] !== undefined) console.log(`📊 成交量: ${item['5'].toLocaleString()}`);
          if (item['6'] !== undefined) console.log(`🔢 序列号: ${item['6']}`);
          if (item['7'] !== undefined) {
            const chartTime = new Date(item['7']).toLocaleString('zh-CN');
            console.log(`⏰ 图表时间: ${chartTime}`);
          }
          
          console.log('\n🔍 原始字段数据:');
          Object.entries(item).forEach(([key, value]) => {
            const fieldNames: Record<string, string> = {
              '0': '股票代码',
              '1': '开盘价',
              '2': '最高价', 
              '3': '最低价',
              '4': '收盘价',
              '5': '成交量',
              '6': '序列号',
              '7': '图表时间戳',
              '8': '图表日期',
              'key': '股票代码'
            };
            
            const fieldName = fieldNames[key] || key;
            console.log(`   ${key}(${fieldName}): ${value}`);
          });
          
          console.log('\n' + '─'.repeat(50));
        });
      } else {
        console.log('数据格式异常:', payload.content);
      }
    }
  });

  sdk.streamer.on('response', (payload) => {
    console.log('[CHART RESPONSE]', payload);
  });

  sdk.streamer.on('error', (error) => {
    console.error('[STREAMER ERROR]', error);
  });

  // 订阅图表数据 - 1分钟K线
  sdk.marketDataStream.subscribeChartEquity({ 
    keys,
    frequency: '1',  // 1分钟频率
    period: '1'      // 1天数据窗口
  });
  
  console.log(`\n🚀 已订阅 CHART_EQUITY: ${keys}`);
  console.log('📡 开始接收图表数据流...');
  console.log('💡 说明:');
  console.log('   - 图表数据提供1分钟级别的OHLCV数据');
  console.log('   - 比Level 1数据更频繁，包含更多交易细节');
  console.log('   - 适合需要更高频率数据但不需要逐笔成交的场景');
  console.log('   - 按 Ctrl+C 可随时退出程序\n');
  console.log('─'.repeat(60));

  setTimeout(() => {
    sdk.disconnectStreamer();
    console.log('已主动断开 Streamer 连接。');
  }, 1000_000);
}

main().catch(handleExampleError);
