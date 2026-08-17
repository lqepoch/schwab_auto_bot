import { createSdk, handleExampleError } from './shared.ts';

/**
 * 稳定连接示例 - 使用优化的配置来减少心跳超时和连接问题
 * 包含更长的超时时间、更频繁的重连尝试和详细的连接状态监控
 */
async function main(): Promise<void> {
  // 使用优化的连接配置
  const sdk = createSdk({
    streamer: {
      autoReconnect: true,
      reconnectDelayMs: 3_000,        // 重连延迟增加到3秒
      heartbeatTimeoutMs: 30_000,     // 心跳超时增加到30秒
      heartbeatCheckIntervalMs: 10_000 // 心跳检查间隔增加到10秒
    },
    // HTTP超时也适当增加
    httpTimeoutMs: 20_000
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

  // 连接状态监控
  let connectionStats = {
    connectTime: Date.now(),
    dataCount: 0,
    lastDataTime: Date.now(),
    reconnectCount: 0,
    heartbeatCount: 0
  };

  console.log(`\n🚀 启动稳定连接监控: ${keys}`);
  console.log('⚙️ 连接配置:');
  console.log('   心跳超时: 30秒 (默认15秒)');
  console.log('   心跳检查间隔: 10秒 (默认5秒)');
  console.log('   重连延迟: 3秒 (默认2秒)');
  console.log('   自动重连: 启用');
  console.log('─'.repeat(60));

  // 建立 Streamer 连接
  try {
    await sdk.connectStreamer();
    console.log('✅ Streamer连接建立成功');
  } catch (error) {
    console.error('❌ 初始连接失败:', error);
    return;
  }

  // 监听连接状态变化
  sdk.streamer.on('ready', () => {
    console.log(`\n🟢 [${new Date().toLocaleString('zh-CN')}] Streamer已就绪`);
    connectionStats.connectTime = Date.now();
  });

  sdk.streamer.on('close', () => {
    console.log(`\n🔴 [${new Date().toLocaleString('zh-CN')}] Streamer已断开`);
    const uptime = Math.round((Date.now() - connectionStats.connectTime) / 1000);
    console.log(`   连接持续时间: ${uptime}秒`);
  });

  sdk.streamer.on('reconnecting', () => {
    connectionStats.reconnectCount++;
    console.log(`\n🔄 [${new Date().toLocaleString('zh-CN')}] 正在重连... (第${connectionStats.reconnectCount}次)`);
  });

  // 监听心跳包（如果有的话）
  sdk.streamer.on('notify', (payload: any) => {
    if (payload.heartbeat) {
      connectionStats.heartbeatCount++;
      const heartbeatTime = new Date(parseInt(payload.heartbeat)).toLocaleString('zh-CN');
      console.log(`💓 心跳 #${connectionStats.heartbeatCount}: ${heartbeatTime}`);
    }
  });

  // 数据监听
  sdk.streamer.on('data', (payload) => {
    connectionStats.dataCount++;
    connectionStats.lastDataTime = Date.now();
    
    const timestamp = new Date().toLocaleString('zh-CN');
    
    if (payload.service === 'LEVELONE_EQUITIES') {
      console.log(`\n📊 [${timestamp}] Level 1数据 (#${connectionStats.dataCount})`);
      
      if (Array.isArray(payload.content)) {
        payload.content.forEach((item: any) => {
          const symbol = item.key;
          const price = item['1'];
          const volume = item['8'];
          const change = item['18'];
          
          if (price !== undefined) {
            const changeStr = change !== undefined ? ` (${change >= 0 ? '+' : ''}${change})` : '';
            console.log(`   ${symbol}: $${price}${changeStr}, 成交量: ${volume?.toLocaleString() || 'N/A'}`);
          }
        });
      }
    }
  });

  sdk.streamer.on('response', (payload) => {
    const status = payload.content?.code === 0 ? '✅' : '❌';
    const timestamp = new Date().toLocaleString('zh-CN');
    console.log(`\n📨 [${timestamp}] ${status} ${payload.service}: ${payload.content?.msg}`);
  });

  sdk.streamer.on('error', (error) => {
    const timestamp = new Date().toLocaleString('zh-CN');
    console.error(`\n❌ [${timestamp}] Streamer错误:`, error.message);
    
    // 分析错误类型
    if (error.message.includes('heartbeat timeout')) {
      console.log('💡 心跳超时建议:');
      console.log('   1. 检查网络连接稳定性');
      console.log('   2. 尝试更换网络环境');
      console.log('   3. 关闭VPN或代理');
      console.log('   4. 系统将自动重连...');
    }
  });

  // 订阅Level 1数据
  sdk.marketDataStream.subscribeLevelOneEquities({ 
    keys,
    fields: '0,1,2,3,4,5,8,9,18,42'
  });

  console.log(`\n📡 已订阅Level 1数据: ${keys}`);
  console.log('🔍 连接监控已启动，将显示详细的连接状态信息\n');

  // 定期显示连接统计
  const statsInterval = setInterval(() => {
    const now = Date.now();
    const uptime = Math.round((now - connectionStats.connectTime) / 1000);
    const timeSinceLastData = Math.round((now - connectionStats.lastDataTime) / 1000);
    
    console.log(`\n📈 连接统计 (运行${uptime}秒):`);
    console.log(`   数据包总数: ${connectionStats.dataCount}`);
    console.log(`   心跳包总数: ${connectionStats.heartbeatCount}`);
    console.log(`   重连次数: ${connectionStats.reconnectCount}`);
    console.log(`   距离上次数据: ${timeSinceLastData}秒`);
    console.log(`   连接状态: ${sdk.streamer.status === 'connected' ? '🟢 已连接' : '🔴 已断开'}`);
    
    // 如果太久没收到数据，给出提醒
    if (timeSinceLastData > 60) {
      console.log('⚠️  警告: 超过1分钟未收到数据，可能存在连接问题');
    }
    
  }, 30_000); // 每30秒显示一次

  // 程序退出处理
  const cleanup = () => {
    clearInterval(statsInterval);
    sdk.disconnectStreamer();
    
    const totalUptime = Math.round((Date.now() - connectionStats.connectTime) / 1000);
    console.log(`\n📊 最终统计:`);
    console.log(`   总运行时间: ${totalUptime}秒`);
    console.log(`   总数据包: ${connectionStats.dataCount}`);
    console.log(`   总重连次数: ${connectionStats.reconnectCount}`);
    console.log(`   平均数据频率: ${(connectionStats.dataCount / (totalUptime / 60)).toFixed(1)}/分钟`);
    console.log('👋 程序已退出');
  };

  // 监听退出信号
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // 10分钟后自动退出
  setTimeout(() => {
    console.log('\n⏰ 达到10分钟运行时间，自动退出...');
    cleanup();
    process.exit(0);
  }, 600_000);
}

main().catch(handleExampleError);
