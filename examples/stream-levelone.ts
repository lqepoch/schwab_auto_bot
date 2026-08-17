import { createSdk, handleExampleError } from './shared.ts';
import { formatLevelOneData, addFieldNames, LEVEL_ONE_FIELD_NAMES, TRADING_STATUS_CODES, EXCHANGE_CODES } from '../src/types/levelOneFields.ts';

/**
 * 分析数据更新类型，帮助理解为什么某些字段存在而某些不存在
 */
function analyzeUpdateType(data: any): string {
  const fields = Object.keys(data).filter(key => key !== 'key');
  const fieldCount = fields.length;
  
  // 判断是否包含价格信息
  const hasPriceInfo = data['1'] !== undefined || data['2'] !== undefined || data['3'] !== undefined;
  
  // 判断是否包含成交量信息
  const hasVolumeInfo = data['8'] !== undefined || data['9'] !== undefined;
  
  // 判断是否包含交易所信息
  const hasExchangeInfo = data['39'] !== undefined || data['40'] !== undefined || data['41'] !== undefined;
  
  // 判断是否只有时间戳和Mark信息
  const onlyTimestampAndMark = fields.every(field => 
    ['34', '37', '38', '39'].includes(field)
  );
  
  if (fieldCount >= 8 && hasPriceInfo && hasVolumeInfo) {
    return '完整行情更新 📈 (包含价格、成交量、交易所等完整信息)';
  } else if (hasPriceInfo && !hasVolumeInfo) {
    return '价格更新 💰 (主要是价格变化)';
  } else if (hasExchangeInfo && !hasPriceInfo) {
    return '交易所切换 🏢 (最佳报价来源变化)';
  } else if (onlyTimestampAndMark) {
    return 'Mark价格更新 📊 (用于衍生品定价的参考价格)';
  } else if (fieldCount <= 3) {
    return '微调更新 🔧 (少量字段变化)';
  } else {
    return `部分更新 ⚡ (${fieldCount}个字段变化)`;
  }
}

/**
 * 建立 Streamer 连接并订阅 Level 1 行情，默认监听 QQQ。按 Ctrl+C 退出或等待脚本自动断开。
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

  // 建立 Streamer 连接，内部会自动登录
  await sdk.connectStreamer();

  sdk.streamer.on('data', (payload) => {
    if (payload.service === 'LEVELONE_EQUITIES') {
      console.log('\n=== LEVELONE_EQUITIES 实时行情数据 ===');
      
      // 遍历每个股票的数据
      if (Array.isArray(payload.content)) {
        payload.content.forEach((item: any, index: number) => {
          console.log(`\n📊 数据包 #${index + 1}:`);
          
          // 分析数据更新类型
          const updateType = analyzeUpdateType(item);
          console.log(`🔄 更新类型: ${updateType}`);
          
          // 显示格式化的中文行情数据
          console.log(formatLevelOneData(item));
          
          // 显示原始数据及字段说明
          console.log('\n🔍 详细字段解析:');
          const fieldsWithNames = addFieldNames(item);
          Object.entries(fieldsWithNames).forEach(([key, value]) => {
            if (key !== 'key(股票代码)') {
              // 为特殊字段添加额外说明
              let explanation = '';
              if (key.includes('37(Mark变化)') || key.includes('38(Mark变化%)')) {
                explanation = ' 📝 Mark字段用于期权定价和风险管理';
              } else if (key.includes('39(买盘交易所)') || key.includes('40(卖盘交易所)') || key.includes('41(成交交易所)')) {
                explanation = ' 🏢 交易所信息显示最佳报价来源';
              } else if (key.includes('34(报价时间戳)')) {
                const timestamp = new Date(value as number).toLocaleString('zh-CN');
                explanation = ` ⏰ 对应时间: ${timestamp}`;
              }
              
              console.log(`   ${key}: ${value}${explanation}`);
            }
          });
          
          console.log('\n' + '─'.repeat(50));
        });
      } else {
        console.log('数据格式异常:', payload.content);
      }
    }
  });

  sdk.streamer.on('response', (payload) => {
    // 输出订阅确认或系统通知
    console.log('[RESPONSE]', payload);
  });

  sdk.streamer.on('error', (error) => {
    console.error('[STREAMER ERROR]', error);
  });

  // 发送订阅指令并提示用户，添加 fields 参数
  sdk.marketDataStream.subscribeLevelOneEquities({ 
    keys,
    fields: '0,1,2,3,4,5,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54'
  });
  
  console.log(`\n🚀 已订阅 LEVELONE_EQUITIES: ${keys}`);
  console.log('📡 开始接收实时行情数据...');
  console.log('💡 数据说明:');
  console.log('   - 每个数据包都会显示格式化的中文行情信息');
  console.log('   - 详细字段解析部分显示所有原始字段及其含义');
  console.log('   - 系统采用增量更新：只传输变化的字段，节省带宽');
  console.log('   - Mark字段用于期权定价和风险管理参考');
  console.log('   - 交易所字段显示最佳报价的来源交易所');
  console.log('   - 按 Ctrl+C 可随时退出程序');
  console.log('   - 程序将在 1000 秒后自动断开连接\n');
  console.log('─'.repeat(60));

  setTimeout(() => {
    sdk.disconnectStreamer();
    console.log('已主动断开 Streamer 连接。');
  }, 1000_000);
}

main().catch(handleExampleError);
