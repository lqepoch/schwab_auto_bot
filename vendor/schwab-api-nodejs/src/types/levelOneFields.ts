/**
 * Level One Equities 流数据字段映射和定义
 * 这些数字字段对应 Schwab API 中的实时股票行情数据
 */

export interface LevelOneEquitiesFields {
  /** 字段 0: 股票代码 (Symbol) */
  '0'?: string;
  /** 字段 1: 最新成交价 (Last Price) - 当前最新的成交价格 */
  '1'?: number;
  /** 字段 2: 买一价 (Bid Price) - 最高买入报价 */
  '2'?: number;
  /** 字段 3: 卖一价 (Ask Price) - 最低卖出报价 */
  '3'?: number;
  /** 字段 4: 买一量 (Bid Size) - 买一价对应的数量 */
  '4'?: number;
  /** 字段 5: 卖一量 (Ask Size) - 卖一价对应的数量 */
  '5'?: number;
  /** 字段 6: 买盘总量 (Bid ID) */
  '6'?: string;
  /** 字段 7: 卖盘总量 (Ask ID) */
  '7'?: string;
  /** 字段 8: 累计成交量 (Total Volume) - 当日累计成交股数 */
  '8'?: number;
  /** 字段 9: 最新成交量 (Last Size) - 最新一笔成交的股数 */
  '9'?: number;
  /** 字段 10: 成交时间 (Trade Time) */
  '10'?: number;
  /** 字段 11: 报价时间 (Quote Time) */
  '11'?: number;
  /** 字段 12: 最高价 (High Price) - 当日最高成交价 */
  '12'?: number;
  /** 字段 13: 最低价 (Low Price) - 当日最低成交价 */
  '13'?: number;
  /** 字段 14: 买盘 Tick (Bid Tick) */
  '14'?: string;
  /** 字段 15: 收盘价 (Close Price) - 前一交易日收盘价 */
  '15'?: number;
  /** 字段 16: 交易状态/市场状态 (Exchange ID) - 如 'D'=延迟, 'P'=预市, 'K'=盘中, 'Q'=收盘等 */
  '16'?: string;
  /** 字段 17: 可融资性 (Marginable) */
  '17'?: boolean;
  /** 字段 18: 涨跌幅 (Net Change) - 相对于前收盘价的涨跌金额 */
  '18'?: number;
  /** 字段 19: 52周最高价 (52 Week High) */
  '19'?: number;
  /** 字段 20: 52周最低价 (52 Week Low) */
  '20'?: number;
  /** 字段 21: 市盈率 (PE Ratio) */
  '21'?: number;
  /** 字段 22: 股息收益率 (Dividend Yield) */
  '22'?: number;
  /** 字段 23: 股息金额 (Dividend Amount) */
  '23'?: number;
  /** 字段 24: 股息日期 (Dividend Date) */
  '24'?: string;
  /** 字段 25: 除息日期 (Ex-Dividend Date) */
  '25'?: string;
  /** 字段 26: 市场资本化 (Market Cap) */
  '26'?: number;
  /** 字段 27: 正则化市场价值 (Regular Market Last Price) */
  '27'?: number;
  /** 字段 28: 正则化市场涨跌 (Regular Market Net Change) */
  '28'?: number;
  /** 字段 29: 正则化市场涨跌百分比 (Regular Market Percent Change) */
  '29'?: number;
  /** 字段 30: 正则化市场成交量 (Regular Market Trade Volume) */
  '30'?: number;
  /** 字段 31: 正则化市场成交时间 (Regular Market Trade Time) */
  '31'?: number;
  /** 字段 32: 正则化市场交易日期 (Regular Market Trade Day) */
  '32'?: number;
  /** 字段 33: 开盘价 (Open Price) - 当日开盘价 */
  '33'?: number;
  /** 字段 34: 实时数据时间戳 (Quote Time in Long) - 行情数据的时间戳(毫秒) */
  '34'?: number;
  /** 字段 35: 成交时间戳 (Trade Time in Long) - 最新成交的时间戳(毫秒) */
  '35'?: number;
  /** 字段 36: Mark价格 (Mark) */
  '36'?: number;
  /** 字段 37: Mark变化 (Mark Change) */
  '37'?: number;
  /** 字段 38: Mark百分比变化 (Mark Percent Change) */
  '38'?: number;
  /** 字段 39: 买盘交易所 (Bid Market Center) - 提供最佳买价的交易所 */
  '39'?: string;
  /** 字段 40: 卖盘交易所 (Ask Market Center) - 提供最佳卖价的交易所 */
  '40'?: string;
  /** 字段 41: 成交交易所 (Last Market Center) - 最新成交发生的交易所 */
  '41'?: string;
  /** 字段 42: 涨跌百分比 (Percent Change) - 相对于前收盘价的涨跌百分比 */
  '42'?: number;
  /** 字段 43: 数字化根 (Digits) */
  '43'?: number;
  /** 字段 44: 安全性 (Security Status) */
  '44'?: number;
  /** 字段 45: 波动性 (Volatility) */
  '45'?: number;
  /** 字段 46: 货币 (Currency) */
  '46'?: string;
  /** 字段 47: 产品 (Product) */
  '47'?: string;
  /** 字段 48: 交易单位 (Trading Unit) */
  '48'?: number;
  /** 字段 49: HTB数量 (HTB Quantity) */
  '49'?: number;
  /** 字段 50: 最终价格 (Final) */
  '50'?: number;
  /** 字段 51: 可复制 (Replicable) */
  '51'?: number;
  /** 字段 52: 指数 (Index) */
  '52'?: number;
  /** 字段 53: VWAP (Volume Weighted Average Price) - 成交量加权平均价 */
  '53'?: number;
  /** 字段 54: 未平仓合约 (Open Interest) */
  '54'?: number;
  /** 股票代码标识符 */
  key?: string;
}

/**
 * 字段名称映射表 - 用于将数字字段转换为中文描述
 */
export const LEVEL_ONE_FIELD_NAMES: Record<string, string> = {
  '0': '股票代码',
  '1': '最新价',
  '2': '买一价',
  '3': '卖一价', 
  '4': '买一量',
  '5': '卖一量',
  '6': '买盘ID',
  '7': '卖盘ID',
  '8': '累计成交量',
  '9': '最新成交量',
  '10': '成交时间',
  '11': '报价时间',
  '12': '最高价',
  '13': '最低价',
  '14': '买盘Tick',
  '15': '前收盘价',
  '16': '交易状态',
  '17': '可融资',
  '18': '涨跌额',
  '19': '52周最高',
  '20': '52周最低',
  '21': '市盈率',
  '22': '股息收益率',
  '23': '股息金额',
  '24': '股息日期',
  '25': '除息日期',
  '26': '市值',
  '27': '正常市场价',
  '28': '正常市场涨跌',
  '29': '正常市场涨跌%',
  '30': '正常市场成交量',
  '31': '正常市场成交时间',
  '32': '正常市场交易日',
  '33': '开盘价',
  '34': '报价时间戳',
  '35': '成交时间戳',
  '36': 'Mark价格',
  '37': 'Mark变化',
  '38': 'Mark变化%',
  '39': '买盘交易所',
  '40': '卖盘交易所',
  '41': '成交交易所',
  '42': '涨跌百分比',
  '43': '精度位数',
  '44': '安全状态',
  '45': '波动率',
  '46': '货币',
  '47': '产品类型',
  '48': '交易单位',
  '49': 'HTB数量',
  '50': '最终价格',
  '51': '可复制标识',
  '52': '指数',
  '53': 'VWAP',
  '54': '未平仓合约',
  'key': '股票代码'
};

/**
 * 交易状态代码映射
 */
export const TRADING_STATUS_CODES: Record<string, string> = {
  'D': '延迟数据',
  'P': '盘前交易', 
  'K': '盘中交易',
  'Q': '收盘后',
  'R': '正常交易',
  'H': '暂停交易',
  'T': '交易结束'
};

/**
 * 交易所代码映射
 */
export const EXCHANGE_CODES: Record<string, string> = {
  'XNYS': '纽约证券交易所',
  'XNAS': '纳斯达克',
  'ARCX': 'NYSE Arca',
  'XADF': 'FINRA ADF',
  'EDGX': 'CBOE EDGX',
  'BATS': 'CBOE BZX',
  'IEX': 'IEX Exchange'
};

/**
 * 格式化Level One数据为可读格式
 */
export function formatLevelOneData(data: LevelOneEquitiesFields): string {
  const lines: string[] = [];
  const symbol = data.key || '未知';
  
  lines.push(`📈 ${symbol} 实时行情:`);
  
  // 基本价格信息
  if (data['1'] !== undefined) lines.push(`   最新价: $${data['1']}`);
  if (data['33'] !== undefined) lines.push(`   开盘价: $${data['33']}`);
  if (data['12'] !== undefined) lines.push(`   最高价: $${data['12']}`);
  if (data['13'] !== undefined) lines.push(`   最低价: $${data['13']}`);
  
  // 买卖盘信息
  if (data['2'] !== undefined && data['4'] !== undefined) {
    lines.push(`   买一价: $${data['2']} x ${data['4']}`);
  }
  if (data['3'] !== undefined && data['5'] !== undefined) {
    lines.push(`   卖一价: $${data['3']} x ${data['5']}`);
  }
  
  // 涨跌信息
  if (data['18'] !== undefined) {
    const changeStr = data['18'] >= 0 ? `+$${data['18']}` : `-$${Math.abs(data['18'])}`;
    lines.push(`   涨跌额: ${changeStr}`);
  }
  if (data['42'] !== undefined) {
    const pctStr = data['42'] >= 0 ? `+${data['42']}%` : `${data['42']}%`;
    lines.push(`   涨跌幅: ${pctStr}`);
  }
  
  // 成交量信息
  if (data['8'] !== undefined) lines.push(`   累计成交量: ${data['8'].toLocaleString()}`);
  if (data['9'] !== undefined) lines.push(`   最新成交量: ${data['9']}`);
  
  // 交易所信息
  if (data['40']) {
    const exchange = EXCHANGE_CODES[data['40']] || data['40'];
    lines.push(`   卖盘交易所: ${exchange}`);
  }
  if (data['41']) {
    const exchange = EXCHANGE_CODES[data['41']] || data['41'];
    lines.push(`   成交交易所: ${exchange}`);
  }
  
  // 状态信息
  if (data['16']) {
    const status = TRADING_STATUS_CODES[data['16']] || data['16'];
    lines.push(`   交易状态: ${status}`);
  }
  
  // 时间戳信息
  if (data['34']) {
    const time = new Date(data['34']).toLocaleString('zh-CN');
    lines.push(`   数据时间: ${time}`);
  }
  
  return lines.join('\n');
}

/**
 * 将原始数据转换为带字段名称的对象
 */
export function addFieldNames(data: LevelOneEquitiesFields): Record<string, any> {
  const result: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(data)) {
    const fieldName = LEVEL_ONE_FIELD_NAMES[key];
    if (fieldName) {
      result[`${key}(${fieldName})`] = value;
    } else {
      result[key] = value;
    }
  }
  
  return result;
}
