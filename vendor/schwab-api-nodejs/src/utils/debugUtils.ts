/**
 * Schwab API 调试工具 - 数据结构定义和解析函数
 * 
 * 本文件包含了从 Schwab API 官方文档提取的完整字段定义和调试工具
 * 方便开发者理解和调试实时数据流
 * 
 * 参考文档：schwab-api-document/schwab-Data-api-document.md
 */

import type { Logger } from '../utils/logger.js';

// ================================================================================
// LEVELONE_EQUITIES 字段定义 (基于官方文档)
// ================================================================================

/**
 * Level 1 股票数据字段定义
 * 来源：Schwab API 官方文档
 */
export const LEVELONE_EQUITIES_FIELDS = {
  '0': { name: 'Symbol', type: 'String', description: 'Ticker symbol in upper case' },
  '1': { name: 'Bid Price', type: 'double', description: 'Current Bid Price' },
  '2': { name: 'Ask Price', type: 'double', description: 'Current Ask Price' },
  '3': { name: 'Last Price', type: 'double', description: 'Price at which the last trade was matched' },
  '4': { name: 'Bid Size', type: 'int', description: 'Number of shares for bid (Units are "lots", typically 100 shares per lot)' },
  '5': { name: 'Ask Size', type: 'int', description: 'Number of shares for ask' },
  '6': { name: 'Ask ID', type: 'char', description: 'Exchange with the ask' },
  '7': { name: 'Bid ID', type: 'char', description: 'Exchange with the bid' },
  '8': { name: 'Total Volume', type: 'long', description: 'Aggregated shares traded throughout the day, including pre/post market hours' },
  '9': { name: 'Last Size', type: 'long', description: 'Number of shares traded with last trade (Units are shares)' },
  '10': { name: 'High Price', type: 'double', description: 'Day\'s high trade price (only regular session trades set High/Low)' },
  '11': { name: 'Low Price', type: 'double', description: 'Day\'s low trade price' },
  '12': { name: 'Close Price', type: 'double', description: 'Previous day\'s closing price' },
  '13': { name: 'Exchange ID', type: 'char', description: 'Primary "listing" Exchange' },
  '14': { name: 'Marginable', type: 'boolean', description: 'Indicates if the security is marginable' },
  '15': { name: 'Shortable', type: 'boolean', description: 'Indicates if the security is shortable' },
  '16': { name: 'Island Bid', type: 'double', description: 'Island Bid Price' },
  '17': { name: 'Island Ask', type: 'double', description: 'Island Ask Price' },
  '18': { name: 'Net Change', type: 'double', description: 'Current Last - Previous Close' },
  '19': { name: '52 Week High', type: 'double', description: '52 week high' },
  '20': { name: '52 Week Low', type: 'double', description: '52 week low' },
  '21': { name: 'Open Price', type: 'double', description: 'Day\'s Open Price' },
  '22': { name: 'Island Volume', type: 'long', description: 'Island Volume' },
  '23': { name: 'Quote Time', type: 'long', description: 'Trade time of the last quote in milliseconds since epoch' },
  '24': { name: 'Trade Time', type: 'long', description: 'Trade time of the last trade in milliseconds since epoch' },
  '25': { name: 'Volatility', type: 'double', description: 'Current volatility' },
  '26': { name: 'Description', type: 'String', description: 'A company, index or fund name' },
  '27': { name: 'Last ID', type: 'char', description: 'Exchange where last trade was executed' },
  '28': { name: 'Digits', type: 'int', description: 'Number of decimal places' },
  '29': { name: 'Open Interest', type: 'long', description: 'Open Interest' },
  '30': { name: 'NAV', type: 'double', description: 'Net Asset Value (Mutual Funds)' },
  '31': { name: 'PE Ratio', type: 'double', description: 'Price Earnings Ratio' },
  '32': { name: 'Dividend Amount', type: 'double', description: 'Dividend Amount' },
  '33': { name: 'Dividend Yield', type: 'double', description: 'Dividend Yield' },
  '34': { name: 'Island Bid Size', type: 'int', description: 'Island Bid Size' },
  '35': { name: 'Island Ask Size', type: 'int', description: 'Island Ask Size' },
  '36': { name: 'NAV Time', type: 'long', description: 'NAV Time' },
  '37': { name: 'Regular Market Quote', type: 'boolean', description: 'Regular Market Quote' },
  '38': { name: 'Regular Market Trade', type: 'boolean', description: 'Regular Market Trade' },
  '39': { name: 'Regular Market Last Price', type: 'double', description: 'Regular Market Last Price' },
  '40': { name: 'Regular Market Last Size', type: 'int', description: 'Regular Market Last Size' },
  '41': { name: 'Regular Market Trade Time', type: 'long', description: 'Regular Market Trade Time' },
  '42': { name: 'Regular Market Trade Day Volume', type: 'long', description: 'Regular Market Trade Day Volume' },
  '43': { name: 'Regular Market Net Change', type: 'double', description: 'Regular Market Net Change' },
  '44': { name: 'Security Status', type: 'String', description: 'Security Status' },
  '45': { name: 'Mark', type: 'double', description: 'Mark Price' },
  '46': { name: 'Quote Time In Long', type: 'long', description: 'Quote Time in Long format' },
  '47': { name: 'Trade Time In Long', type: 'long', description: 'Trade Time in Long format' },
  '48': { name: 'Mark Change In Double', type: 'double', description: 'Mark Change in Double' },
  '49': { name: 'Mark Percent Change In Double', type: 'double', description: 'Mark Percent Change in Double' },
  '50': { name: 'Regular Market Percent Change In Double', type: 'double', description: 'Regular Market Percent Change in Double' },
  '51': { name: 'Delayed', type: 'boolean', description: 'Whether data is delayed' },
  '52': { name: 'Realtime Entitled', type: 'boolean', description: 'Whether user is entitled to realtime data' },
  '53': { name: 'Asset Main Type', type: 'String', description: 'Asset Main Type: BOND, EQUITY, ETF, etc.' },
  '54': { name: 'Asset Sub Type', type: 'String', description: 'Asset Sub Type: ADR, CEF, COE, etc.' }
} as const;

// ================================================================================
// NASDAQ_BOOK 字段定义 (基于官方文档)
// ================================================================================

/**
 * NASDAQ Book 数据字段定义
 * 来源：Schwab API 官方文档
 */
export const NASDAQ_BOOK_FIELDS = {
  '0': { name: 'Symbol', type: 'String', description: 'Ticker symbol in upper case' },
  '1': { name: 'Market Snapshot Time', type: 'long', description: 'Timestamp for the data (Milliseconds since Epoch)' },
  '2': { name: 'Bid Side Levels', type: 'Array', description: 'Bid side price levels' },
  '3': { name: 'Ask Side Levels', type: 'Array', description: 'Ask side price levels' }
} as const;

/**
 * Book Price Level 子字段定义
 */
export const BOOK_PRICE_LEVEL_FIELDS = {
  '0': { name: 'Price', type: 'double', description: 'Price for this level' },
  '1': { name: 'Aggregate Size', type: 'int', description: 'Aggregate size for this price level' },
  '2': { name: 'Market Maker Count', type: 'int', description: 'Number of Market Makers in this price level' },
  '3': { name: 'Array of Market Makers', type: 'Array', description: 'Array of market maker sizes for this price level' }
} as const;

/**
 * Market Maker 子字段定义
 */
export const MARKET_MAKER_FIELDS = {
  '0': { name: 'Market Maker ID', type: 'String', description: 'Market Maker ID (exchange code)' },
  '1': { name: 'Size', type: 'long', description: 'Size of the Market Maker for this price level' },
  '2': { name: 'Quote Time', type: 'long', description: 'Quote time in milliseconds for this Market Maker\'s quote' }
} as const;

// ================================================================================
// CHART_EQUITY 字段定义 (基于官方文档)
// ================================================================================

/**
 * Chart Equity 数据字段定义
 * 来源：Schwab API 官方文档
 */
export const CHART_EQUITY_FIELDS = {
  '0': { name: 'Key', type: 'String', description: 'Ticker symbol in upper case' },
  '1': { name: 'Open Price', type: 'double', description: 'Opening price for the minute' },
  '2': { name: 'High Price', type: 'double', description: 'Highest price for the minute' },
  '3': { name: 'Low Price', type: 'double', description: 'Chart\'s lowest price for the minute' },
  '4': { name: 'Close Price', type: 'double', description: 'Closing price for the minute' },
  '5': { name: 'Volume', type: 'double', description: 'Total volume for the minute' },
  '6': { name: 'Sequence', type: 'long', description: 'Identifies the candle minute' },
  '7': { name: 'Chart Time', type: 'long', description: 'Milliseconds since Epoch' },
  '8': { name: 'Chart Day', type: 'int', description: 'Chart Day' }
} as const;

// ================================================================================
// 调试工具函数
// ================================================================================

/**
 * 解析并格式化 LEVELONE_EQUITIES 数据
 */
export function parseLevelOneEquities(data: any, logger?: Logger): string {
  if (!data || typeof data !== 'object') {
    return 'Invalid data format';
  }

  const symbol = data.key || '未知股票';
  const result = [`📈 ${symbol} Level 1 数据:`];

  // 基础价格信息
  const lastPrice = data['3'];
  const bidPrice = data['1'];
  const askPrice = data['2'];
  const netChange = data['18'];
  const volume = data['8'];

  if (lastPrice !== undefined) {
    let priceInfo = `   最新价: $${lastPrice}`;
    if (netChange !== undefined) {
      const changeStr = netChange >= 0 ? `+${netChange}` : `${netChange}`;
      priceInfo += ` (${changeStr})`;
    }
    result.push(priceInfo);
  }

  if (bidPrice !== undefined && askPrice !== undefined) {
    result.push(`   买卖价: $${bidPrice} x $${askPrice}`);
  }

  if (volume !== undefined) {
    result.push(`   成交量: ${volume.toLocaleString()}`);
  }

  // 调试信息：显示所有字段
  const availableFields = Object.keys(data).filter(key => data[key] !== undefined);
  result.push(`   📋 可用字段: ${availableFields.join(', ')}`);

  // 详细字段解析（调试模式）
  if (logger && process.env.DEBUG_STREAMER === 'true') {
    result.push('   🔍 字段详情:');
    for (const [fieldId, value] of Object.entries(data)) {
      if (value !== undefined && LEVELONE_EQUITIES_FIELDS[fieldId as keyof typeof LEVELONE_EQUITIES_FIELDS]) {
        const fieldDef = LEVELONE_EQUITIES_FIELDS[fieldId as keyof typeof LEVELONE_EQUITIES_FIELDS];
        result.push(`     ${fieldId}: ${fieldDef.name} = ${value} (${fieldDef.type})`);
        result.push(`         ${fieldDef.description}`);
      }
    }
  }

  return result.join('\n');
}

/**
 * 解析并格式化 NASDAQ_BOOK 数据
 */
export function parseNasdaqBook(data: any, logger?: Logger): string {
  if (!data || typeof data !== 'object') {
    return 'Invalid data format';
  }

  const symbol = data.key || '未知股票';
  const timestamp = data['1'];
  const bidLevels = data['2'];
  const askLevels = data['3'];

  const result = [`📚 ${symbol} Level II Book数据:`];

  if (timestamp) {
    const timeStr = new Date(timestamp).toLocaleString('zh-CN');
    result.push(`   ⏰ 快照时间: ${timeStr}`);
  }

  // 解析买盘数据
  if (bidLevels && Array.isArray(bidLevels)) {
    result.push('   💰 买盘深度:');
    bidLevels.slice(0, 5).forEach((level: any, index: number) => {
      const levelInfo = parsePriceLevel(level, `L${index + 1}`, logger);
      if (levelInfo) {
        result.push(`     ${levelInfo}`);
      }
    });
  }

  // 解析卖盘数据
  if (askLevels && Array.isArray(askLevels)) {
    result.push('   💸 卖盘深度:');
    askLevels.slice(0, 5).forEach((level: any, index: number) => {
      const levelInfo = parsePriceLevel(level, `L${index + 1}`, logger);
      if (levelInfo) {
        result.push(`     ${levelInfo}`);
      }
    });
  }

  // 调试信息
  const availableFields = Object.keys(data).filter(key => data[key] !== undefined);
  result.push(`   📋 可用字段: ${availableFields.join(', ')}`);

  return result.join('\n');
}

/**
 * 解析价格层级数据
 */
function parsePriceLevel(level: any, levelName: string, logger?: Logger): string | null {
  if (!level) return null;

  let price: number;
  let size: number;
  let marketCount: number;
  let marketMakers: any[];

  // 处理数组格式
  if (Array.isArray(level) && level.length >= 2) {
    [price, size, marketCount, marketMakers] = level;
  }
  // 处理对象格式
  else if (typeof level === 'object') {
    price = level['0'] || level.price;
    size = level['1'] || level.size;
    marketCount = level['2'] || level.marketCount || 0;
    marketMakers = level['3'] || level.marketMakers;
  } else {
    return `${levelName}: [格式错误] ${JSON.stringify(level)}`;
  }

  if (price === undefined || size === undefined) {
    return `${levelName}: [数据不完整] ${JSON.stringify(level)}`;
  }

  let result = `${levelName}: $${price} x ${size}`;
  if (marketCount) {
    result += ` (${marketCount}个市场)`;
  }

  // 显示主要市场信息
  if (marketMakers && Array.isArray(marketMakers) && marketMakers.length > 0) {
    const mainMarkets = marketMakers.slice(0, 3); // 显示前3个市场
    const marketInfo = mainMarkets
      .map((market: any) => {
        if (Array.isArray(market) && market.length >= 2) {
          return `${market[0]}:${market[1]}`;
        }
        return null;
      })
      .filter(Boolean)
      .join(', ');
    
    if (marketInfo) {
      result += ` [${marketInfo}]`;
    }
  }

  return result;
}

/**
 * 解析并格式化 CHART_EQUITY 数据
 */
export function parseChartEquity(data: any, logger?: Logger): string {
  if (!data || typeof data !== 'object') {
    return 'Invalid data format';
  }

  const symbol = data.key || data['0'] || '未知股票';
  const open = data['1'];
  const high = data['2'];
  const low = data['3'];
  const close = data['4'];
  const volume = data['5'];
  const chartTime = data['7'];

  const result = [`📊 ${symbol} K线数据:`];

  if (open !== undefined && high !== undefined && low !== undefined && close !== undefined) {
    result.push(`   OHLC: $${open} / $${high} / $${low} / $${close}`);
  }

  if (volume !== undefined) {
    result.push(`   成交量: ${volume.toLocaleString()}`);
  }

  if (chartTime) {
    const timeStr = new Date(chartTime).toLocaleString('zh-CN');
    result.push(`   ⏰ K线时间: ${timeStr}`);
  }

  // 调试信息
  const availableFields = Object.keys(data).filter(key => data[key] !== undefined);
  result.push(`   📋 可用字段: ${availableFields.join(', ')}`);

  return result.join('\n');
}

/**
 * 通用数据验证函数
 */
export function validateStreamData(data: any, service: string): boolean {
  if (!data) {
    console.log(`   ⚠️ ${service}: 数据为空`);
    return false;
  }
  
  if (!Array.isArray(data)) {
    console.log(`   ⚠️ ${service}: 数据不是数组格式，类型: ${typeof data}`);
    return false;
  }
  
  if (data.length === 0) {
    console.log(`   ⚠️ ${service}: 数据数组为空`);
    return false;
  }
  
  return true;
}

/**
 * 高级流数据调试器
 * 提供实时数据监控、统计分析和数据质量评估功能
 */
export class StreamDebugger {
  private stats: Map<string, {
    updateCount: number;
    firstUpdate: number;
    lastUpdate: number;
    totalSize: number;
    errorCount: number;
    qualityScores: number[];
  }> = new Map();

  private options: {
    showRawData: boolean;
    showStatistics: boolean;
    showFieldDetails: boolean;
    showDataQuality: boolean;
    autoAnalyze: boolean;
    statisticsInterval: number;
  };

  constructor(options: Partial<StreamDebugger['options']> = {}) {
    this.options = {
      showRawData: process.env.DEBUG_STREAMER === 'true',
      showStatistics: true,
      showFieldDetails: process.env.DEBUG_FIELDS === 'true',
      showDataQuality: true,
      autoAnalyze: true,
      statisticsInterval: 30000,
      ...options
    };

    if (this.options.showStatistics) {
      this.startStatisticsTimer();
    }
  }

  /**
   * 记录和分析流数据
   */
  logData(service: string, payload: any, customTitle?: string): void {
    const timestamp = new Date().toLocaleString('zh-CN');
    const stats = this.getOrCreateStats(service);
    stats.updateCount++;
    stats.lastUpdate = Date.now();
    
    if (stats.updateCount === 1) {
      stats.firstUpdate = Date.now();
    }

    console.log(`\n[${timestamp}] ${getServiceIcon(service)} ${customTitle || getServiceName(service)} (#${stats.updateCount})`);
    
    if (this.options.showRawData && payload.content) {
      console.log('🔍 原始数据:', JSON.stringify(payload.content, null, 2));
    }
    
    if (validateStreamData(payload.content, service)) {
      payload.content.forEach((item: any, index: number) => {
        this.processDataItem(service, item, index);
      });
      
      stats.totalSize += payload.content.length;
    } else {
      stats.errorCount++;
    }
  }

  /**
   * 处理单个数据项
   */
  private processDataItem(service: string, item: any, index: number): void {
    let output: string;
    let qualityScore = 0;
    
    switch (service) {
      case 'LEVELONE_EQUITIES':
        output = parseLevelOneEquities(item);
        qualityScore = this.assessLevelOneQuality(item);
        break;
      case 'NASDAQ_BOOK':
      case 'NYSE_BOOK':
        output = parseNasdaqBook(item);
        qualityScore = this.assessBookQuality(item);
        break;
      case 'CHART_EQUITY':
        output = parseChartEquity(item);
        qualityScore = this.assessChartQuality(item);
        break;
      default:
        output = `   未知服务数据 #${index + 1}: ${JSON.stringify(item, null, 2)}`;
        qualityScore = 0;
    }
    
    console.log(output);
    
    if (this.options.showDataQuality && qualityScore < 0.8) {
      console.log(`   ⚠️ 数据质量: ${Math.round(qualityScore * 100)}%`);
    }
    
    if (this.options.showFieldDetails) {
      this.showFieldDetails(service, item);
    }
    
    // 记录质量分数
    const stats = this.getOrCreateStats(service);
    stats.qualityScores.push(qualityScore);
    if (stats.qualityScores.length > 100) {
      stats.qualityScores.shift(); // 保留最近100个质量分数
    }
  }

  /**
   * 显示字段详情
   */
  private showFieldDetails(service: string, item: any): void {
    const fieldMappings = FIELD_MAPPINGS[service as keyof typeof FIELD_MAPPINGS];
    if (!fieldMappings) return;

    console.log('   🔍 字段详情:');
    Object.entries(item).forEach(([fieldId, value]) => {
      if (value !== undefined && fieldMappings[fieldId as keyof typeof fieldMappings]) {
        const fieldDef = fieldMappings[fieldId as keyof typeof fieldMappings];
        const displayValue = typeof value === 'object' ? JSON.stringify(value) : value;
        console.log(`     ${fieldId}: ${fieldDef.name} = ${displayValue} (${fieldDef.type})`);
        console.log(`         ${fieldDef.description}`);
      }
    });
  }

  /**
   * 评估 Level 1 数据质量
   */
  private assessLevelOneQuality(item: any): number {
    const criticalFields = ['1', '2', '3', '8']; // 买价、卖价、最新价、成交量
    const importantFields = ['18', '42', '10', '11']; // 涨跌额、涨跌幅、最高价、最低价
    
    let score = 0;
    let maxScore = criticalFields.length * 2 + importantFields.length;
    
    criticalFields.forEach(field => {
      if (item[field] !== undefined && item[field] !== null) {
        score += 2; // 关键字段权重更高
      }
    });
    
    importantFields.forEach(field => {
      if (item[field] !== undefined && item[field] !== null) {
        score += 1;
      }
    });
    
    return score / maxScore;
  }

  /**
   * 评估 Book 数据质量
   */
  private assessBookQuality(item: any): number {
    let score = 0;
    let maxScore = 4;
    
    // 基础字段检查
    ['0', '1'].forEach(field => {
      if (item[field] !== undefined) score += 0.5;
    });
    
    // 买卖盘数据检查
    const bidLevels = item['2'];
    const askLevels = item['3'];
    
    if (Array.isArray(bidLevels) && bidLevels.length > 0) {
      score += 1.5;
      if (bidLevels.length >= 5) score += 0.5; // 深度足够
    }
    
    if (Array.isArray(askLevels) && askLevels.length > 0) {
      score += 1.5;
      if (askLevels.length >= 5) score += 0.5; // 深度足够
    }
    
    return score / maxScore;
  }

  /**
   * 评估 Chart 数据质量
   */
  private assessChartQuality(item: any): number {
    const requiredFields = ['1', '2', '3', '4', '5']; // OHLCV
    let score = 0;
    
    requiredFields.forEach(field => {
      if (item[field] !== undefined && item[field] !== null) {
        score += 1;
      }
    });
    
    return score / requiredFields.length;
  }

  /**
   * 获取或创建统计数据
   */
  private getOrCreateStats(service: string) {
    if (!this.stats.has(service)) {
      this.stats.set(service, {
        updateCount: 0,
        firstUpdate: 0,
        lastUpdate: 0,
        totalSize: 0,
        errorCount: 0,
        qualityScores: []
      });
    }
    return this.stats.get(service)!;
  }

  /**
   * 开始统计计时器
   */
  private startStatisticsTimer(): void {
    setInterval(() => {
      this.printStatistics();
    }, this.options.statisticsInterval);
  }

  /**
   * 打印统计信息
   */
  printStatistics(): void {
    if (this.stats.size === 0) return;
    
    console.log('\n📊 流数据统计信息:');
    console.log('=' .repeat(60));
    
    for (const [service, stats] of this.stats.entries()) {
      if (stats.updateCount === 0) continue;
      
      const runtime = (stats.lastUpdate - stats.firstUpdate) / 1000;
      const avgRate = runtime > 0 ? (stats.updateCount / runtime * 60).toFixed(1) : '0';
      const avgQuality = stats.qualityScores.length > 0 
        ? (stats.qualityScores.reduce((a, b) => a + b, 0) / stats.qualityScores.length * 100).toFixed(1)
        : 'N/A';
      
      console.log(`${getServiceIcon(service)} ${getServiceName(service)}:`);
      console.log(`   更新次数: ${stats.updateCount} (${avgRate}/分钟)`);
      console.log(`   总数据量: ${stats.totalSize} 条记录`);
      console.log(`   错误次数: ${stats.errorCount}`);
      console.log(`   平均质量: ${avgQuality}%`);
      console.log(`   运行时间: ${runtime.toFixed(1)} 秒`);
    }
    
    console.log('=' .repeat(60));
  }

  /**
   * 获取统计摘要
   */
  getStatsSummary(): Record<string, any> {
    const summary: Record<string, any> = {};
    
    for (const [service, stats] of this.stats.entries()) {
      const runtime = (stats.lastUpdate - stats.firstUpdate) / 1000;
      const avgQuality = stats.qualityScores.length > 0 
        ? stats.qualityScores.reduce((a, b) => a + b, 0) / stats.qualityScores.length
        : 0;
      
      summary[service] = {
        updateCount: stats.updateCount,
        totalSize: stats.totalSize,
        errorCount: stats.errorCount,
        avgQuality: Math.round(avgQuality * 100),
        runtime: Math.round(runtime),
        updateRate: runtime > 0 ? Math.round(stats.updateCount / runtime * 60) : 0
      };
    }
    
    return summary;
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats.clear();
  }
}

/**
 * 创建格式化的调试输出 (向后兼容)
 */
export function createDebugLogger(service: string) {
  const streamDebugger = new StreamDebugger();
  return {
    logData: (payload: any, updateCount: number) => {
      streamDebugger.logData(service, payload, `${getServiceName(service)} (#${updateCount})`);
    }
  };
}

/**
 * 获取服务图标
 */
function getServiceIcon(service: string): string {
  const icons: Record<string, string> = {
    'LEVELONE_EQUITIES': '📈',
    'NASDAQ_BOOK': '📚',
    'NYSE_BOOK': '📚',
    'CHART_EQUITY': '📊',
    'CHART_FUTURES': '📊',
    'ACCT_ACTIVITY': '💼'
  };
  return icons[service] || '📊';
}

/**
 * 获取服务中文名称
 */
function getServiceName(service: string): string {
  const names: Record<string, string> = {
    'LEVELONE_EQUITIES': 'Level 1 股票行情',
    'NASDAQ_BOOK': 'NASDAQ Level II 深度',
    'NYSE_BOOK': 'NYSE Level II 深度',
    'CHART_EQUITY': '股票K线数据',
    'CHART_FUTURES': '期货K线数据',
    'ACCT_ACTIVITY': '账户活动'
  };
  return names[service] || service;
}

/**
 * 导出常用的字段映射，方便外部使用
 */
export const FIELD_MAPPINGS = {
  LEVELONE_EQUITIES: LEVELONE_EQUITIES_FIELDS,
  NASDAQ_BOOK: NASDAQ_BOOK_FIELDS,
  CHART_EQUITY: CHART_EQUITY_FIELDS,
  BOOK_PRICE_LEVEL: BOOK_PRICE_LEVEL_FIELDS,
  MARKET_MAKER: MARKET_MAKER_FIELDS
} as const;

/**
 * 获取字段定义
 */
export function getFieldDefinition(service: string, fieldId: string): any {
  const mappings = FIELD_MAPPINGS[service as keyof typeof FIELD_MAPPINGS];
  return mappings?.[fieldId as keyof typeof mappings] || null;
}

// ================================================================================
// 连接状态监控工具
// ================================================================================

/**
 * Streamer 连接状态监控器
 */
export class ConnectionMonitor {
  private connectionHistory: Array<{
    timestamp: number;
    event: 'connected' | 'disconnected' | 'reconnecting' | 'error';
    details?: string;
  }> = [];

  private connectionStats = {
    totalConnections: 0,
    totalDisconnections: 0,
    totalReconnections: 0,
    totalErrors: 0,
    currentUptime: 0,
    lastConnected: 0,
    lastDisconnected: 0
  };

  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * 记录连接事件
   */
  recordEvent(event: 'connected' | 'disconnected' | 'reconnecting' | 'error', details?: string): void {
    const timestamp = Date.now();
    
    this.connectionHistory.push({
      timestamp,
      event,
      details
    });

    // 保留最近100个事件
    if (this.connectionHistory.length > 100) {
      this.connectionHistory.shift();
    }

    // 更新统计
    switch (event) {
      case 'connected':
        this.connectionStats.totalConnections++;
        this.connectionStats.lastConnected = timestamp;
        this.logger?.info('🟢 Streamer 连接成功', { timestamp: new Date(timestamp).toLocaleString() });
        break;
      case 'disconnected':
        this.connectionStats.totalDisconnections++;
        this.connectionStats.lastDisconnected = timestamp;
        this.connectionStats.currentUptime = timestamp - this.connectionStats.lastConnected;
        this.logger?.warn('🔴 Streamer 连接断开', { 
          timestamp: new Date(timestamp).toLocaleString(),
          uptime: this.formatDuration(this.connectionStats.currentUptime),
          details 
        });
        break;
      case 'reconnecting':
        this.connectionStats.totalReconnections++;
        this.logger?.info('🔄 Streamer 重连中', { details });
        break;
      case 'error':
        this.connectionStats.totalErrors++;
        this.logger?.error('❌ Streamer 连接错误', { details });
        break;
    }
  }

  /**
   * 获取连接统计
   */
  getConnectionStats(): any {
    const now = Date.now();
    const currentUptime = this.connectionStats.lastConnected > this.connectionStats.lastDisconnected
      ? now - this.connectionStats.lastConnected
      : 0;

    return {
      ...this.connectionStats,
      currentUptime,
      currentUptimeFormatted: this.formatDuration(currentUptime),
      totalUptimeFormatted: this.formatDuration(this.connectionStats.currentUptime),
      recentEvents: this.connectionHistory.slice(-10).map(event => ({
        ...event,
        timestampFormatted: new Date(event.timestamp).toLocaleString()
      }))
    };
  }

  /**
   * 打印连接统计
   */
  printConnectionStats(): void {
    const stats = this.getConnectionStats();
    
    console.log('\n🔌 连接状态统计:');
    console.log('=' .repeat(50));
    console.log(`📈 总连接次数: ${stats.totalConnections}`);
    console.log(`📉 总断开次数: ${stats.totalDisconnections}`);
    console.log(`🔄 总重连次数: ${stats.totalReconnections}`);
    console.log(`❌ 总错误次数: ${stats.totalErrors}`);
    console.log(`⏱️  当前在线时长: ${stats.currentUptimeFormatted}`);
    
    if (stats.recentEvents.length > 0) {
      console.log('\n📋 最近事件:');
      stats.recentEvents.forEach((event: any) => {
        const icon = event.event === 'connected' ? '🟢' 
                   : event.event === 'disconnected' ? '🔴'
                   : event.event === 'reconnecting' ? '🔄' : '❌';
        console.log(`   ${icon} ${event.timestampFormatted}: ${event.event} ${event.details || ''}`);
      });
    }
    
    console.log('=' .repeat(50));
  }

  /**
   * 格式化持续时间
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

// ================================================================================
// 数据可视化和格式化工具
// ================================================================================

/**
 * 数据可视化工具
 */
export class DataVisualizer {
  /**
   * 创建价格图表的ASCII艺术
   */
  static createPriceChart(prices: number[], width: number = 50, height: number = 10): string {
    if (prices.length === 0) return 'No data available';
    
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    
    if (range === 0) {
      // 所有价格相同的情况
      const chart = Array(height).fill('').map((_, i) => 
        i === Math.floor(height / 2) ? '─'.repeat(width) : ' '.repeat(width)
      );
      return chart.join('\n') + `\n📊 价格: $${prices[0].toFixed(2)} (无变化)`;
    }
    
    const chart: string[][] = Array(height).fill(null).map(() => Array(width).fill(' '));
    
    // 绘制价格线
    for (let x = 0; x < Math.min(width, prices.length); x++) {
      const price = prices[Math.floor(x * prices.length / width)];
      const y = Math.floor((max - price) / range * (height - 1));
      if (y >= 0 && y < height) {
        chart[y][x] = '●';
      }
    }
    
    // 连接点
    for (let x = 1; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (chart[y][x] === '●' && chart[y][x-1] === ' ') {
          // 查找前一个点的位置
          for (let py = 0; py < height; py++) {
            if (chart[py][x-1] === '●') {
              // 画线连接
              const startY = py;
              const endY = y;
              if (Math.abs(startY - endY) > 1) {
                const steps = Math.abs(startY - endY);
                for (let s = 1; s < steps; s++) {
                  const lineY = startY + Math.round((endY - startY) * s / steps);
                  if (lineY >= 0 && lineY < height) {
                    chart[lineY][x-1] = '·';
                  }
                }
              }
              break;
            }
          }
        }
      }
    }
    
    const result = chart.map(row => row.join('')).join('\n');
    return result + `\n📊 范围: $${min.toFixed(2)} - $${max.toFixed(2)} (Δ${((prices[prices.length-1] - prices[0]) / prices[0] * 100).toFixed(2)}%)`;
  }

  /**
   * 创建成交量柱状图
   */
  static createVolumeChart(volumes: number[], width: number = 50, height: number = 5): string {
    if (volumes.length === 0) return 'No volume data';
    
    const maxVolume = Math.max(...volumes);
    if (maxVolume === 0) return 'No trading volume';
    
    const chart: string[][] = Array(height).fill(null).map(() => Array(width).fill(' '));
    
    for (let x = 0; x < Math.min(width, volumes.length); x++) {
      const volume = volumes[Math.floor(x * volumes.length / width)];
      const barHeight = Math.floor(volume / maxVolume * height);
      
      for (let y = height - barHeight; y < height; y++) {
        if (y >= 0) {
          chart[y][x] = '█';
        }
      }
    }
    
    const result = chart.map(row => row.join('')).join('\n');
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    return result + `\n📊 最大成交量: ${this.formatNumber(maxVolume)}, 平均: ${this.formatNumber(avgVolume)}`;
  }

  /**
   * 格式化数字显示
   */
  static formatNumber(num: number): string {
    if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return num.toString();
  }

  /**
   * 创建买卖盘深度可视化
   */
  static createBookVisualization(bidLevels: any[], askLevels: any[], maxLevels: number = 10): string {
    const lines: string[] = [];
    lines.push('📚 Level II 买卖盘深度:');
    lines.push('═'.repeat(60));
    
    // 显示卖盘（从高到低）
    lines.push('💸 卖盘 (Ask Levels):');
    const asks = askLevels.slice(0, maxLevels).reverse();
    asks.forEach((level, index) => {
      const price = level.price || level[0];
      const size = level.size || level[1];
      const sizeBar = '█'.repeat(Math.min(20, Math.floor(size / 1000)));
      lines.push(`   ${(asks.length - index).toString().padStart(2)}: $${price?.toFixed(2)?.padStart(8)} x ${size?.toString()?.padStart(6)} ${sizeBar}`);
    });
    
    lines.push('─'.repeat(60));
    
    // 显示买盘（从高到低）
    lines.push('💰 买盘 (Bid Levels):');
    bidLevels.slice(0, maxLevels).forEach((level, index) => {
      const price = level.price || level[0];
      const size = level.size || level[1];
      const sizeBar = '█'.repeat(Math.min(20, Math.floor(size / 1000)));
      lines.push(`   ${(index + 1).toString().padStart(2)}: $${price?.toFixed(2)?.padStart(8)} x ${size?.toString()?.padStart(6)} ${sizeBar}`);
    });
    
    return lines.join('\n');
  }
}

// ================================================================================
// 性能监控工具
// ================================================================================

/**
 * 性能监控器
 */
export class PerformanceMonitor {
  private metrics: Map<string, {
    count: number;
    totalTime: number;
    minTime: number;
    maxTime: number;
    lastTime: number;
    recentTimes: number[];
  }> = new Map();

  /**
   * 测量函数执行时间
   */
  measureTime<T>(name: string, fn: () => T): T {
    const startTime = performance.now();
    const result = fn();
    const endTime = performance.now();
    
    this.recordTime(name, endTime - startTime);
    return result;
  }

  /**
   * 测量异步函数执行时间
   */
  async measureTimeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startTime = performance.now();
    const result = await fn();
    const endTime = performance.now();
    
    this.recordTime(name, endTime - startTime);
    return result;
  }

  /**
   * 记录执行时间
   */
  recordTime(name: string, time: number): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, {
        count: 0,
        totalTime: 0,
        minTime: Infinity,
        maxTime: 0,
        lastTime: 0,
        recentTimes: []
      });
    }
    
    const metric = this.metrics.get(name)!;
    metric.count++;
    metric.totalTime += time;
    metric.minTime = Math.min(metric.minTime, time);
    metric.maxTime = Math.max(metric.maxTime, time);
    metric.lastTime = time;
    
    // 保留最近20次的时间记录
    metric.recentTimes.push(time);
    if (metric.recentTimes.length > 20) {
      metric.recentTimes.shift();
    }
  }

  /**
   * 获取性能统计
   */
  getPerformanceStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    for (const [name, metric] of this.metrics.entries()) {
      const avgTime = metric.totalTime / metric.count;
      const recentAvg = metric.recentTimes.length > 0
        ? metric.recentTimes.reduce((a, b) => a + b, 0) / metric.recentTimes.length
        : avgTime;
      
      stats[name] = {
        count: metric.count,
        avgTime: Math.round(avgTime * 100) / 100,
        minTime: Math.round(metric.minTime * 100) / 100,
        maxTime: Math.round(metric.maxTime * 100) / 100,
        lastTime: Math.round(metric.lastTime * 100) / 100,
        recentAvg: Math.round(recentAvg * 100) / 100,
        totalTime: Math.round(metric.totalTime)
      };
    }
    
    return stats;
  }

  /**
   * 打印性能统计
   */
  printPerformanceStats(): void {
    const stats = this.getPerformanceStats();
    
    console.log('\n⚡ 性能统计:');
    console.log('=' .repeat(80));
    console.log('操作'.padEnd(25) + '次数'.padEnd(8) + '平均'.padEnd(10) + '最近平均'.padEnd(10) + '最小'.padEnd(10) + '最大'.padEnd(10));
    console.log('─'.repeat(80));
    
    for (const [name, stat] of Object.entries(stats)) {
      console.log(
        name.padEnd(25) +
        stat.count.toString().padEnd(8) +
        `${stat.avgTime}ms`.padEnd(10) +
        `${stat.recentAvg}ms`.padEnd(10) +
        `${stat.minTime}ms`.padEnd(10) +
        `${stat.maxTime}ms`.padEnd(10)
      );
    }
    
    console.log('=' .repeat(80));
  }

  /**
   * 重置性能统计
   */
  resetStats(): void {
    this.metrics.clear();
  }
}
