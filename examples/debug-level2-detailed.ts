#!/usr/bin/env tsx

/**
 * Level II 数据调试脚本 - 详细版本
 * 使用高级 StreamerDebugger 进行专业的 NASDAQ_BOOK 和 NYSE_BOOK 数据分析
 */

import { createSdk } from '../src/index.js';
import { createStreamerDebugger } from '../src/index.js';

async function debugLevel2Data() {
  console.log('🔍 Level II 数据结构调试工具（增强版）');
  console.log('=' .repeat(50));

  const sdk = createSdk({
    streamer: {
      autoReconnect: true,
      reconnectDelayMs: 3000,
      heartbeatTimeoutMs: 30000,
      heartbeatCheckIntervalMs: 10000
    }
  });

  // 创建最详细的调试器配置
  const streamDebugger = createStreamerDebugger({
    verbose: true,
    showRawData: true,
    autoAnalyze: true,
    enableVisualization: true,
    enablePerformanceMonitoring: true,
    statisticsInterval: 30000,
    saveToFile: process.env.SAVE_LOG === 'true'
  });

  try {
    // 连接到流媒体服务
    await sdk.marketDataStream.connect();
    console.log('✅ 连接成功');

    // 启动全面监控
    streamDebugger.startMonitoring(sdk.streamer);

    const symbols = ['QQQ', 'AAPL', 'TSLA'];
    console.log(`📊 订阅Level II数据: ${symbols.join(', ')}`);

    // 订阅NASDAQ_BOOK
    try {
      sdk.marketDataStream.subscribeNasdaqBook({
        keys: symbols.join(','),
        fields: '0,1,2,3' // Symbol, Time, Bids, Asks
      });
      console.log('✅ NASDAQ_BOOK 订阅成功');
    } catch (error) {
      console.log('❌ NASDAQ_BOOK 订阅失败:', error);
      
      // 尝试NYSE_BOOK作为备选
      try {
        sdk.marketDataStream.subscribeNyseBook({
          keys: symbols.join(','),
          fields: '0,1,2,3'
        });
        console.log('✅ NYSE_BOOK 订阅成功 (备选)');
      } catch (error2) {
        console.log('❌ NYSE_BOOK 订阅也失败:', error2);
      }
    }

    // 保持脚本运行
    console.log('\n🎯 开始监听Level II数据...');
    console.log('💡 提示: 如果看到数据质量问题，调试器会自动分析原因');
    console.log('💡 环境变量:');
    console.log('   - DEBUG_STREAMER=true  启用详细字段分析');
    console.log('   - SAVE_LOG=true        保存调试日志到文件');
    console.log('\n按 Ctrl+C 停止...\n');

  } catch (error) {
    console.error('❌ 初始化失败:', error);
    process.exit(1);
  }
}

// 优雅退出处理
process.on('SIGINT', () => {
  console.log('\n👋 正在退出...');
  process.exit(0);
});

debugLevel2Data().catch(console.error);
