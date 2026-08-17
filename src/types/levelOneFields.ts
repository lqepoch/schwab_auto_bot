/**
 * Canonical LEVELONE_EQUITIES field contract.
 *
 * Keep one field-id map for request typing, decoding helpers, diagnostics, and UI formatting.
 * Numeric field identifiers are Schwab Streamer wire identifiers; callers should never infer
 * their meaning from positional order.
 */

export const LEVELONE_EQUITIES_FIELDS = {
  '0': { name: 'Symbol', type: 'String', zh: '股票代码' },
  '1': { name: 'Bid Price', type: 'double', zh: '买一价' },
  '2': { name: 'Ask Price', type: 'double', zh: '卖一价' },
  '3': { name: 'Last Price', type: 'double', zh: '最新价' },
  '4': { name: 'Bid Size', type: 'int', zh: '买一量' },
  '5': { name: 'Ask Size', type: 'int', zh: '卖一量' },
  '6': { name: 'Ask ID', type: 'char', zh: '卖盘交易所' },
  '7': { name: 'Bid ID', type: 'char', zh: '买盘交易所' },
  '8': { name: 'Total Volume', type: 'long', zh: '累计成交量' },
  '9': { name: 'Last Size', type: 'long', zh: '最新成交量' },
  '10': { name: 'High Price', type: 'double', zh: '最高价' },
  '11': { name: 'Low Price', type: 'double', zh: '最低价' },
  '12': { name: 'Close Price', type: 'double', zh: '前收盘价' },
  '13': { name: 'Exchange ID', type: 'char', zh: '主上市交易所' },
  '14': { name: 'Marginable', type: 'boolean', zh: '可融资' },
  '15': { name: 'Shortable', type: 'boolean', zh: '可卖空' },
  '16': { name: 'Island Bid', type: 'double', zh: 'Island买价' },
  '17': { name: 'Island Ask', type: 'double', zh: 'Island卖价' },
  '18': { name: 'Net Change', type: 'double', zh: '涨跌额' },
  '19': { name: '52 Week High', type: 'double', zh: '52周最高' },
  '20': { name: '52 Week Low', type: 'double', zh: '52周最低' },
  '21': { name: 'Open Price', type: 'double', zh: '开盘价' },
  '22': { name: 'Island Volume', type: 'long', zh: 'Island成交量' },
  '23': { name: 'Quote Time', type: 'long', zh: '报价时间' },
  '24': { name: 'Trade Time', type: 'long', zh: '成交时间' },
  '25': { name: 'Volatility', type: 'double', zh: '波动率' },
  '26': { name: 'Description', type: 'String', zh: '证券描述' },
  '27': { name: 'Last ID', type: 'char', zh: '成交交易所' },
  '28': { name: 'Digits', type: 'int', zh: '价格精度' },
  '29': { name: 'Open Interest', type: 'long', zh: '未平仓量' },
  '30': { name: 'NAV', type: 'double', zh: '净资产值' },
  '31': { name: 'PE Ratio', type: 'double', zh: '市盈率' },
  '32': { name: 'Dividend Amount', type: 'double', zh: '股息金额' },
  '33': { name: 'Dividend Yield', type: 'double', zh: '股息率' },
  '34': { name: 'Island Bid Size', type: 'int', zh: 'Island买量' },
  '35': { name: 'Island Ask Size', type: 'int', zh: 'Island卖量' },
  '36': { name: 'NAV Time', type: 'long', zh: 'NAV时间' },
  '37': { name: 'Regular Market Quote', type: 'boolean', zh: '常规时段报价标志' },
  '38': { name: 'Regular Market Trade', type: 'boolean', zh: '常规时段成交标志' },
  '39': { name: 'Regular Market Last Price', type: 'double', zh: '常规时段最新价' },
  '40': { name: 'Regular Market Last Size', type: 'int', zh: '常规时段最新成交量' },
  '41': { name: 'Regular Market Trade Time', type: 'long', zh: '常规时段成交时间' },
  '42': { name: 'Regular Market Trade Day Volume', type: 'long', zh: '常规时段成交量' },
  '43': { name: 'Regular Market Net Change', type: 'double', zh: '常规时段涨跌额' },
  '44': { name: 'Security Status', type: 'String', zh: '证券状态' },
  '45': { name: 'Mark', type: 'double', zh: 'Mark价格' },
  '46': { name: 'Quote Time In Long', type: 'long', zh: '报价时间戳' },
  '47': { name: 'Trade Time In Long', type: 'long', zh: '成交时间戳' },
  '48': { name: 'Mark Change In Double', type: 'double', zh: 'Mark涨跌额' },
  '49': { name: 'Mark Percent Change In Double', type: 'double', zh: 'Mark涨跌幅' },
  '50': { name: 'Regular Market Percent Change In Double', type: 'double', zh: '常规时段涨跌幅' },
  '51': { name: 'Delayed', type: 'boolean', zh: '延迟行情标志' },
  '52': { name: 'Realtime Entitled', type: 'boolean', zh: '实时行情权限' },
  '53': { name: 'Asset Main Type', type: 'String', zh: '资产主类型' },
  '54': { name: 'Asset Sub Type', type: 'String', zh: '资产子类型' },
} as const;

export type LevelOneEquityFieldId = keyof typeof LEVELONE_EQUITIES_FIELDS;
export type LevelOneEquityFieldSelection = string | readonly LevelOneEquityFieldId[];

export interface LevelOneEquitiesFields {
  '0'?: string;
  '1'?: number;
  '2'?: number;
  '3'?: number;
  '4'?: number;
  '5'?: number;
  '6'?: string;
  '7'?: string;
  '8'?: number;
  '9'?: number;
  '10'?: number;
  '11'?: number;
  '12'?: number;
  '13'?: string;
  '14'?: boolean;
  '15'?: boolean;
  '16'?: number;
  '17'?: number;
  '18'?: number;
  '19'?: number;
  '20'?: number;
  '21'?: number;
  '22'?: number;
  '23'?: number;
  '24'?: number;
  '25'?: number;
  '26'?: string;
  '27'?: string;
  '28'?: number;
  '29'?: number;
  '30'?: number;
  '31'?: number;
  '32'?: number;
  '33'?: number;
  '34'?: number;
  '35'?: number;
  '36'?: number;
  '37'?: boolean;
  '38'?: boolean;
  '39'?: number;
  '40'?: number;
  '41'?: number;
  '42'?: number;
  '43'?: number;
  '44'?: string;
  '45'?: number;
  '46'?: number;
  '47'?: number;
  '48'?: number;
  '49'?: number;
  '50'?: number;
  '51'?: boolean;
  '52'?: boolean;
  '53'?: string;
  '54'?: string;
  key?: string;
}

/** Chinese display names derived directly from the canonical contract. */
export const LEVEL_ONE_FIELD_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(LEVELONE_EQUITIES_FIELDS).map(([id, definition]) => [id, definition.zh]),
);

/**
 * Preserve the historical export for callers that translate exchange identifiers.
 * The map is intentionally partial; unknown venues remain visible as the raw wire value.
 */
export const EXCHANGE_CODES: Record<string, string> = {
  XNYS: '纽约证券交易所',
  XNAS: '纳斯达克',
  ARCX: 'NYSE Arca',
  XADF: 'FINRA ADF',
  EDGX: 'CBOE EDGX',
  BATS: 'CBOE BZX',
  IEX: 'IEX Exchange',
};

/**
 * Kept for source compatibility. Security Status is an opaque broker value here;
 * no speculative translation is applied without an explicit verified contract.
 */
export const TRADING_STATUS_CODES: Record<string, string> = {};

/**
 * Serialize and validate a LEVELONE_EQUITIES field selection.
 * String input remains supported for compatibility, but every token is checked against
 * the canonical field-id table so typos cannot silently alter a production subscription.
 */
export function serializeLevelOneEquityFields(
  fields: LevelOneEquityFieldSelection | undefined,
): string | undefined {
  if (fields === undefined) return undefined;
  const raw = typeof fields === 'string' ? fields.split(',') : [...fields];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of raw) {
    const id = String(item).trim();
    if (!id) continue;
    if (!(id in LEVELONE_EQUITIES_FIELDS)) {
      throw new Error(`Unsupported LEVELONE_EQUITIES field id: ${id}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  if (normalized.length === 0) {
    throw new Error('LEVELONE_EQUITIES fields must contain at least one valid field id');
  }
  return normalized.join(',');
}

/** Human-readable formatter for the canonical Level One equities payload. */
export function formatLevelOneData(data: LevelOneEquitiesFields): string {
  const lines: string[] = [];
  const symbol = data.key ?? data['0'] ?? '未知';
  lines.push(`📈 ${symbol} 实时行情:`);

  if (data['3'] !== undefined) lines.push(`   最新价: $${data['3']}`);
  if (data['21'] !== undefined) lines.push(`   开盘价: $${data['21']}`);
  if (data['10'] !== undefined) lines.push(`   最高价: $${data['10']}`);
  if (data['11'] !== undefined) lines.push(`   最低价: $${data['11']}`);
  if (data['12'] !== undefined) lines.push(`   前收盘价: $${data['12']}`);

  if (data['1'] !== undefined) {
    lines.push(`   买一价: $${data['1']}${data['4'] !== undefined ? ` x ${data['4']}` : ''}`);
  }
  if (data['2'] !== undefined) {
    lines.push(`   卖一价: $${data['2']}${data['5'] !== undefined ? ` x ${data['5']}` : ''}`);
  }

  if (data['18'] !== undefined) {
    const prefix = data['18'] >= 0 ? '+' : '';
    lines.push(`   涨跌额: ${prefix}${data['18']}`);
  }
  if (data['50'] !== undefined) {
    const prefix = data['50'] >= 0 ? '+' : '';
    lines.push(`   常规时段涨跌幅: ${prefix}${data['50']}%`);
  }

  if (data['8'] !== undefined) lines.push(`   累计成交量: ${data['8'].toLocaleString()}`);
  if (data['9'] !== undefined) lines.push(`   最新成交量: ${data['9']}`);
  if (data['45'] !== undefined) lines.push(`   Mark: $${data['45']}`);

  if (data['7']) lines.push(`   买盘交易所: ${EXCHANGE_CODES[data['7']] ?? data['7']}`);
  if (data['6']) lines.push(`   卖盘交易所: ${EXCHANGE_CODES[data['6']] ?? data['6']}`);
  if (data['27']) lines.push(`   成交交易所: ${EXCHANGE_CODES[data['27']] ?? data['27']}`);
  if (data['44']) lines.push(`   证券状态: ${TRADING_STATUS_CODES[data['44']] ?? data['44']}`);

  const quoteTime = data['46'] ?? data['23'];
  if (quoteTime !== undefined && Number.isFinite(quoteTime)) {
    lines.push(`   报价时间: ${new Date(quoteTime).toLocaleString('zh-CN')}`);
  }

  return lines.join('\n');
}

/** Add stable human-readable field labels without changing the raw payload. */
export function addFieldNames(data: LevelOneEquitiesFields): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const fieldName = LEVEL_ONE_FIELD_NAMES[key];
    result[fieldName ? `${key}(${fieldName})` : key] = value;
  }
  return result;
}
