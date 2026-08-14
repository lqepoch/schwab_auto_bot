# Schwab API Streamer 调试指南

本指南提供了 Schwab API 实时数据流的完整调试信息，包括字段定义、数据结构和使用示例。

## 📋 目录

- [快速开始](#快速开始)
- [数据源概述](#数据源概述)
- [字段定义](#字段定义)
- [调试工具](#调试工具)
- [常见问题](#常见问题)
- [示例代码](#示例代码)

## 🚀 快速开始

### 基本使用

```bash
# 运行多数据源监控示例
npx tsx examples/stream-multi-data-sources.ts QQQ

# 启用详细调试信息
DEBUG_STREAMER=true npx tsx examples/stream-multi-data-sources.ts QQQ,AAPL,MSFT
```

### 导入调试工具

```typescript
import { 
  createDebugLogger, 
  parseLevelOneEquities, 
  parseNasdaqBook, 
  parseChartEquity,
  validateStreamData,
  FIELD_MAPPINGS 
} from '../src/utils/debugUtils.js';
```

## 📊 数据源概述

### Level 1 股票行情 (LEVELONE_EQUITIES)

**用途**: 提供股票的基础实时行情数据
**更新类型**: Change (仅变化数据)
**主要字段**: 54个官方字段

#### 核心数据字段
- **价格信息**: 最新价、买价、卖价、开盘价、最高价、最低价、收盘价
- **成交信息**: 成交量、最后成交量、买卖量
- **统计信息**: 涨跌额、涨跌幅、52周高低点
- **时间信息**: 报价时间、成交时间
- **其他信息**: 交易所代码、证券状态、波动率等

#### 数据示例
```json
{
  "key": "QQQ",
  "1": 602.15,     // 买价
  "2": 602.20,     // 卖价  
  "3": 602.18,     // 最新价
  "8": 431518,     // 成交量
  "18": -0.055,    // 涨跌额
  "42": -0.009,    // 涨跌幅
  "delayed": false,
  "assetMainType": "ETF"
}
```

### Level II Book 深度数据 (NASDAQ_BOOK)

**用途**: 提供 NASDAQ 市场的买卖盘深度信息
**更新类型**: Whole (完整数据快照)
**主要字段**: 4个核心字段 + 多层级子结构

#### 数据结构
```
NASDAQ_BOOK
├── 0: Symbol (股票代码)
├── 1: Market Snapshot Time (快照时间戳)
├── 2: Bid Side Levels (买盘层级数组)
│   └── [Price, Size, MarketCount, [MarketMakers]]
└── 3: Ask Side Levels (卖盘层级数组)
    └── [Price, Size, MarketCount, [MarketMakers]]
```

#### 价格层级子结构
```
Price Level
├── 0: Price (价格)
├── 1: Aggregate Size (总数量)  
├── 2: Market Maker Count (做市商数量)
└── 3: Market Makers Array (做市商数组)
    └── [MarketMakerID, Size, QuoteTime]
```

#### 数据示例
```json
{
  "key": "QQQ",
  "1": 1758629376886,
  "2": [  // 买盘
    [602.15, 1430, 9, [
      ["NSDQ", 630, 29318158],
      ["arcx", 100, 29318159],
      ["batx", 100, 29318159]
    ]]
  ],
  "3": [  // 卖盘
    [602.20, 830, 7, [
      ["NSDQ", 230, 29318158],
      ["edgx", 200, 29318159]
    ]]
  ]
}
```

### Chart K线数据 (CHART_EQUITY)

**用途**: 提供股票的分钟级K线数据
**更新类型**: All Sequence (完整序列)
**主要字段**: 9个字段

#### 核心字段
- **OHLC**: 开盘价、最高价、最低价、收盘价
- **成交量**: 分钟成交量
- **时间**: 图表时间戳、序列号

#### 数据示例
```json
{
  "key": "QQQ",
  "1": 602.10,     // 开盘价
  "2": 602.25,     // 最高价
  "3": 602.05,     // 最低价
  "4": 602.20,     // 收盘价
  "5": 15420,      // 成交量
  "7": 1758629340000  // 时间戳
}
```

### Chart K线数据 (CHART_FUTURES) 的顺序边界

本地随附的 Schwab Data API 文档把 `CHART_FUTURES` 标为 **All Sequence**，但该服务的字段表没有独立的 Sequence 字段，只有字段 `1` **Chart Time**。因此快照缓存不会猜测或合成连续序列：只把每行字段 `1` 的文档时间作为顺序证据；缺少该字段的行会以 `uncertain-order` 丢弃。相同 Chart Time 但字段内容不同的修正行仍可合并，只有行指纹完全相同才判定为重复。

`ACCT_ACTIVITY` 的 `seq` 与 `key` 位于编号字段之外，且必须和字段 `1`（账户）、`2`（消息类型）、`3`（消息数据）一起存在；不符合该本地文档形状的旧式/部分 fixture 不会进入 generation-scoped 快照。重新连接会清空旧代缓存并重置允许的序列起点，不能把旧代活动消息写入新代。

## 🔧 调试工具

### 创建调试器

```typescript
import { createDebugLogger } from '../src/utils/debugUtils.js';

const debugger = createDebugLogger('LEVELONE_EQUITIES');

// 在数据回调中使用
sdk.streamer.on('data', (payload) => {
  if (payload.service === 'LEVELONE_EQUITIES') {
    debugger.logData(payload, updateCount++);
  }
});
```

### 解析单个数据项

```typescript
import { parseLevelOneEquities, parseNasdaqBook } from '../src/utils/debugUtils.js';

// 解析 Level 1 数据
const level1Output = parseLevelOneEquities(dataItem);
console.log(level1Output);

// 解析 Book 数据  
const bookOutput = parseNasdaqBook(dataItem);
console.log(bookOutput);
```

### 字段定义查询

```typescript
import { FIELD_MAPPINGS, getFieldDefinition } from '../src/utils/debugUtils.js';

// 获取所有 Level 1 字段定义
const level1Fields = FIELD_MAPPINGS.LEVELONE_EQUITIES;

// 查询特定字段
const fieldDef = getFieldDefinition('LEVELONE_EQUITIES', '18');
console.log(fieldDef); // { name: 'Net Change', type: 'double', description: '...' }
```

## 🔍 字段定义

### LEVELONE_EQUITIES 完整字段列表

| 字段 | 名称 | 类型 | 描述 |
|------|------|------|------|
| 0 | Symbol | String | 股票代码 |
| 1 | Bid Price | double | 买入价 |
| 2 | Ask Price | double | 卖出价 |
| 3 | Last Price | double | 最新成交价 |
| 4 | Bid Size | int | 买入量 |
| 5 | Ask Size | int | 卖出量 |
| 8 | Total Volume | long | 总成交量 |
| 9 | Last Size | long | 最后成交量 |
| 10 | High Price | double | 最高价 |
| 11 | Low Price | double | 最低价 |
| 12 | Close Price | double | 前收盘价 |
| 18 | Net Change | double | 涨跌额 |
| 21 | Open Price | double | 开盘价 |
| 42 | Regular Market Trade Day Volume | long | 正常交易时段成交量 |

*完整的54个字段定义请参考 `src/utils/debugUtils.ts`*

### NASDAQ_BOOK 字段列表

| 字段 | 名称 | 类型 | 描述 |
|------|------|------|------|
| 0 | Symbol | String | 股票代码 |
| 1 | Market Snapshot Time | long | 市场快照时间戳 |
| 2 | Bid Side Levels | Array | 买盘价格层级 |
| 3 | Ask Side Levels | Array | 卖盘价格层级 |

### 价格层级子字段

| 字段 | 名称 | 类型 | 描述 |
|------|------|------|------|
| 0 | Price | double | 价格 |
| 1 | Aggregate Size | int | 聚合数量 |
| 2 | Market Maker Count | int | 做市商数量 |
| 3 | Market Makers Array | Array | 做市商数组 |

## 💡 使用技巧

### 1. 启用详细调试

```bash
# 设置环境变量显示详细字段信息
export DEBUG_STREAMER=true
npx tsx examples/stream-multi-data-sources.ts QQQ
```

### 2. 过滤特定字段

```typescript
// 仅订阅关键字段以减少数据量
sdk.marketDataStream.subscribeLevelOneEquities({ 
  keys: 'QQQ',
  fields: '0,1,2,3,8,18,42'  // 仅订阅核心字段
});
```

### 3. 处理数据验证

```typescript
import { validateStreamData } from '../src/utils/debugUtils.js';

if (validateStreamData(payload.content, payload.service)) {
  // 数据有效，继续处理
  payload.content.forEach(item => {
    // 处理每个数据项
  });
}
```

## ❓ 常见问题

### Q: 为什么某些字段显示 undefined？

A: 字段值为 undefined 通常表示：
1. 该字段在当前更新中没有变化（Level 1 使用变化更新）
2. 市场状态不支持该字段（如盘后时间的某些统计数据）
3. 订阅的字段列表中未包含该字段

### Q: Book 数据为什么显示 "结构异常"？

A: 这个问题已在新版本中修复。确保使用最新的解析函数：
```typescript
import { parseNasdaqBook } from '../src/utils/debugUtils.js';
```

### Q: Chart 数据订阅失败怎么办？

A: Chart 数据可能因以下原因失败：
1. 市场已收盘
2. 该股票不支持实时K线数据
3. 用户权限不足

这是正常现象，可以继续使用其他数据源。

### Q: 如何理解做市商代码？

A: 常见的做市商代码：
- `NSDQ`: NASDAQ
- `arcx`: NYSE Arca
- `edgx`: EDGX Exchange
- `batx`: BATS Exchange
- `phlx`: NASDAQ PHLX

## 📝 示例代码

### 完整的多数据源监控

```typescript
import { createSdk } from './shared.js';
import { createDebugLogger } from '../src/utils/debugUtils.js';

async function main() {
  const sdk = createSdk();
  await sdk.connectStreamer();

  // 创建调试器
  const debuggers = {
    level1: createDebugLogger('LEVELONE_EQUITIES'),
    book: createDebugLogger('NASDAQ_BOOK'),
    chart: createDebugLogger('CHART_EQUITY')
  };

  let updateCounts = { level1: 0, book: 0, chart: 0 };

  // 数据处理
  sdk.streamer.on('data', (payload) => {
    switch (payload.service) {
      case 'LEVELONE_EQUITIES':
        debuggers.level1.logData(payload, ++updateCounts.level1);
        break;
      case 'NASDAQ_BOOK':
        debuggers.book.logData(payload, ++updateCounts.book);
        break;
      case 'CHART_EQUITY':
        debuggers.chart.logData(payload, ++updateCounts.chart);
        break;
    }
  });

  // 订阅数据
  sdk.marketDataStream.subscribeLevelOneEquities({ 
    keys: 'QQQ,AAPL',
    fields: '0,1,2,3,4,5,8,9,18,42'
  });
  
  sdk.marketDataStream.subscribeNasdaqBook({ 
    keys: 'QQQ,AAPL',
    fields: '0,1,2,3'
  });
}

main().catch(console.error);
```

### 自定义数据处理

```typescript
import { parseLevelOneEquities, FIELD_MAPPINGS } from '../src/utils/debugUtils.js';

sdk.streamer.on('data', (payload) => {
  if (payload.service === 'LEVELONE_EQUITIES') {
    payload.content.forEach(item => {
      // 使用内置解析器
      const formatted = parseLevelOneEquities(item);
      console.log(formatted);
      
      // 或者自定义处理
      const price = item['3'];  // 最新价
      const volume = item['8']; // 成交量
      const change = item['18']; // 涨跌额
      
      if (price && volume) {
        console.log(`${item.key}: $${price} Vol:${volume} Change:${change || 'N/A'}`);
      }
    });
  }
});
```

## 📚 相关文档

- [Schwab API 官方文档](../schwab-api-document/)
- [调试工具源码](../src/utils/debugUtils.ts)
- [示例代码](../examples/stream-multi-data-sources.ts)

## 🤝 贡献

如果发现字段定义有误或需要添加新的调试功能，欢迎提交 PR 或 Issue。

所有字段定义均基于 Schwab API 官方文档，如有更新请及时同步。
