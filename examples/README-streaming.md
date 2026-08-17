# Schwab API 流数据示例使用说明

## Level One 股票行情流数据

`stream-levelone.ts` 示例现在提供了三种不同的数据显示格式，帮助您更好地理解 Schwab API 返回的流数据。

### 运行方式

```bash
# 默认监听 QQQ，使用格式化输出
npm run example:stream-levelone

# 监听指定股票，如 AAPL
npm run example:stream-levelone AAPL

# 监听多只股票
npm run example:stream-levelone "AAPL,MSFT,GOOGL"

# 使用不同的输出格式
OUTPUT_MODE=raw npm run example:stream-levelone QQQ
OUTPUT_MODE=named npm run example:stream-levelone QQQ  
OUTPUT_MODE=formatted npm run example:stream-levelone QQQ
```

### 输出格式说明

#### 1. 格式化输出 (默认)
- 以易读的方式显示股票行情信息
- 包含中文字段名称和格式化的价格、成交量等信息
- 同时显示原始字段数据便于调试

#### 2. 原始数据输出 (`OUTPUT_MODE=raw`)
- 显示 Schwab API 返回的原始 JSON 数据
- 适合开发调试和数据分析

#### 3. 带名称输出 (`OUTPUT_MODE=named`)
- 显示所有字段及其中文名称
- 方便理解每个数字字段的含义

### 主要字段含义

| 字段编号 | 中文名称 | 说明 | 示例 |
|---------|---------|------|------|
| 1 | 最新价 | 当前最新成交价 | 596.8 |
| 2 | 买一价 | 最高买入报价 | 596.82 |
| 3 | 卖一价 | 最低卖出报价 | 596.79 |
| 4 | 买一量 | 买一价对应数量 | 5 |
| 5 | 卖一量 | 卖一价对应数量 | 1 |
| 8 | 累计成交量 | 当日累计成交股数 | 745863 |
| 9 | 最新成交量 | 最新一笔成交股数 | 1 |
| 16 | 交易状态 | D=延迟, P=盘前, K=盘中, Q=收盘 | D |
| 18 | 涨跌额 | 相对前收盘价涨跌金额 | 1.47 |
| 33 | 开盘价 | 当日开盘价 | 596.8 |
| 34 | 数据时间戳 | 行情数据时间戳(毫秒) | 1758287269418 |
| 40 | 卖盘交易所 | 提供最佳卖价的交易所 | XNYS |
| 41 | 成交交易所 | 最新成交的交易所 | ARCX |
| 42 | 涨跌百分比 | 相对前收盘价涨跌百分比 | 0.24860579 |

### 交易所代码

| 代码 | 交易所名称 |
|------|-----------|
| XNYS | 纽约证券交易所 |
| XNAS | 纳斯达克 |
| ARCX | NYSE Arca |
| XADF | FINRA ADF |
| EDGX | CBOE EDGX |
| IEX  | IEX Exchange |

### 交易状态代码

| 代码 | 状态说明 |
|------|----------|
| D | 延迟数据 |
| P | 盘前交易 |
| K | 盘中交易 |
| Q | 收盘后 |
| R | 正常交易 |
| H | 暂停交易 |
| T | 交易结束 |

### 开发使用

如果您在开发中需要处理 Level One 数据，可以导入相关的类型和工具函数：

```typescript
import { 
  LevelOneEquitiesFields, 
  formatLevelOneData, 
  addFieldNames,
  LEVEL_ONE_FIELD_NAMES,
  TRADING_STATUS_CODES,
  EXCHANGE_CODES 
} from 'schwab-api-nodejs';

// 格式化显示数据
const formatted = formatLevelOneData(levelOneData);
console.log(formatted);

// 添加字段名称
const withNames = addFieldNames(levelOneData);

// 获取字段中文名称
const fieldName = LEVEL_ONE_FIELD_NAMES['1']; // "最新价"
```

这样您就可以轻松理解和处理 Schwab API 返回的实时股票行情数据了！
