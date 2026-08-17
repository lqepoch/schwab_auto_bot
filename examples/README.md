# SDK examples

本目录只保留可直接在 Node.js 24 源码模式运行的 SDK 示例。示例属于开发/诊断入口，不进入自动交易生产运行时，也不会被 `npm start` 自动加载。

## 环境

在仓库根目录创建 `.env`，或通过进程环境设置：

```text
SCHWAB_CLIENT_ID=<应用 Client ID>
SCHWAB_CLIENT_SECRET=<应用 Client Secret>
SCHWAB_REDIRECT_URI=<OAuth 回调地址>
SCHWAB_TOKEN_PATH=.schwab_tokens.json
```

安装锁定依赖并执行类型检查：

```bash
npm ci --ignore-scripts
npm run typecheck:examples
```

## 可执行入口

```bash
node examples/authorize-and-refresh.ts
node examples/fetch-quotes.ts TSLA,MSFT
node examples/download-price-history.ts AAPL 20
node examples/stream-levelone.ts QQQ,SPY
node examples/stream-account-activity.ts
node examples/stream-chart-equity.ts
node examples/stream-level2-book.ts
node examples/stream-multi-data-sources.ts
node examples/stream-stable-connection.ts
node examples/debug-stream-data.ts
node examples/debug-level2-detailed.ts
node examples/debug-user-preferences-and-entitlements.ts
```

授权、行情、Streamer 示例会访问 Schwab API；执行前确认凭据和 API 权限。它们不调用自动下单模块，也不作为生产守护进程部署。
