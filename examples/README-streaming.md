# Streamer examples

`stream-levelone.ts` 用于查看 Schwab Level One 行情流，并支持原始、命名字段和格式化输出。

```bash
node examples/stream-levelone.ts QQQ
OUTPUT_MODE=raw node examples/stream-levelone.ts QQQ
OUTPUT_MODE=named node examples/stream-levelone.ts AAPL,MSFT
OUTPUT_MODE=formatted node examples/stream-levelone.ts QQQ,SPY
```

常用字段映射、交易状态与交易所辅助函数通过正式 package export 暴露：

```typescript
import {
  LevelOneEquitiesFields,
  formatLevelOneData,
  addFieldNames,
  LEVEL_ONE_FIELD_NAMES,
  TRADING_STATUS_CODES,
  EXCHANGE_CODES,
} from 'schwab-owokit/streamer-fields';
```

这些脚本用于开发诊断。生产 Streamer 生命周期、重连、ACK 跟踪和订阅状态通过 SDK 公共 API 管理。
