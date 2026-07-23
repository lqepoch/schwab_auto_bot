# schwab-owokit

一个面向 Charles Schwab Trader / Market Data REST / Streamer API 的 TypeScript SDK，适配 Node.js ≥ 18（已在 Node.js 22 环境下测试构建）。

## 功能概览

- ✅ OAuth2 授权码流程：生成授权 URL、换取令牌、自动刷新、落盘缓存
- ✅ REST 调用自动处理 401：令牌过期会透明刷新后重试
- ✅ Trader REST API：账户、订单、交易记录、偏好设置等全部端点
- ✅ Market Data REST API：报价、期权链、历史行情、市场时间、标的信息
- ✅ Streamer WebSocket：Level One/Book/Chart/筛选器/账户活动实时推送
- ✅ 中文注释 & 类型提示：调用体验对照官方字段

## 快速开始

### 1. 安装

```bash
npm install schwab-owokit
```

### 2. 初始化 SDK

推荐先运行内置向导生成 `.env`：

```bash
npm run setup
```

该命令会交互式询问 `SCHWAB_CLIENT_ID`、`SCHWAB_CLIENT_SECRET`、`SCHWAB_REDIRECT_URI` 等必填信息，
并自动写入项目根目录的 `.env`。如需修改配置，可随时重新运行命令覆盖旧值。

然后可以直接从环境变量创建 SDK，并开启日志输出：

```ts
import { SchwabOwokit, createConsoleLogger } from 'schwab-owokit';

const sdk = SchwabOwokit.fromEnvironment({
  logLevel: 'info',
  logger: createConsoleLogger({ scope: 'Demo' }),
  streamer: {
    autoReconnect: true,
    reconnectDelayMs: 2_000,
  },
});
```

`logLevel` 支持 `debug`、`info`、`warn`、`error`，可根据调试阶段动态调整输出量。
如需接入第三方日志系统，可传入自定义实现的 `logger` 对象，只要提供 `debug/info/warn/error/child` 方法即可。

### 3. 首次授权

```ts
// 1) 将 URL 打开到浏览器，用户登录后会重定向带回 code
const url = sdk.createAuthorizeUrl({ state: 'optional-state', scope: 'read account openid' });
console.log('请在浏览器打开：', url);

// 2) 拿到回调中的 ?code=xxx 后，执行兑换
await sdk.exchangeCodeForToken(receivedCode);
```

如果希望由脚本自动打开授权链接，可调用 `await sdk.openAuthorizeUrl()`，或在示例脚本中追加 `--open` 参数：

```bash
npm run example:authorize -- --open
```

之后 SDK 会把令牌保存到 `.schwab_tokens.json`，后续启动直接调用 `sdk.getAccessToken()` 会自动刷新。

> ℹ️ 默认的令牌文件会写入当前进程的工作目录（`process.cwd()`）。在部署到服务端或定时任务时，建议通过 `SCHWAB_TOKEN_PATH`
> 环境变量或 `tokenStorePath` 配置显式指定一个稳定的绝对路径，以避免工作目录变化导致无法找到缓存令牌。

## Trader REST API 示例

```ts
// 获取账号映射（第一步，拿到 hashValue）
const accounts = await sdk.trader.getAccountNumbers();
const accountHash = accounts[0]?.hashValue;

// 查询账户余额/持仓
const accountDetail = await sdk.trader.getAccount(accountHash, { fields: 'positions' });

// 预览下单
const preview = await sdk.trader.previewOrder(accountHash, {
  orderStrategyType: 'SINGLE',
  session: 'NORMAL',
  duration: 'DAY',
  orderType: 'LIMIT',
  price: 100,
  orderLegCollection: [
    {
      orderLegType: 'EQUITY',
      instruction: 'BUY',
      quantity: 1,
      instrument: { symbol: 'AAPL', assetType: 'EQUITY' },
    },
  ],
});

// 下单
await sdk.trader.placeOrder(accountHash, {
  orderStrategyType: 'SINGLE',
  session: 'NORMAL',
  duration: 'DAY',
  orderType: 'MARKET',
  orderLegCollection: [
    {
      orderLegType: 'EQUITY',
      instruction: 'BUY',
      quantity: 1,
      instrument: { symbol: 'AAPL', assetType: 'EQUITY' },
    },
  ],
});

// 查询交易流水
const transactions = await sdk.trader.getTransactions(accountHash, {
  startDate: '2024-05-01T00:00:00.000Z',
  endDate: '2024-05-31T23:59:59.000Z',
  types: 'TRADE',
});
```

所有 Trader REST 方法的中文注释均位于 `src/clients/trader.ts`，可对照官方文档理解每个字段含义。

## Market Data REST API 示例

```ts
// 拉取批量行情
const quotes = await sdk.marketData.getQuotes({ symbols: ['AAPL', 'QQQ'], fields: ['quote', 'fundamental'] });

// 查询期权链，获取近月近价行权价
const optionChain = await sdk.marketData.getOptionChains({
  symbol: 'AAPL',
  strategy: 'SINGLE',
  strikeCount: 2,
  includeQuotes: true,
});

// 获取历史 K 线
const history = await sdk.marketData.getPriceHistory({
  symbol: 'AAPL',
  periodType: 'month',
  period: 1,
  frequencyType: 'daily',
  frequency: 1,
});

// 查询市场开闭市时间
const hours = await sdk.marketData.getMarkets({ markets: ['equity', 'option'], date: '2024-05-20' });

// 检索标的
const instruments = await sdk.marketData.searchInstruments({ symbol: 'AAPL,BAC', projection: 'symbol-search' });
```

Market Data REST 数据结构定义在 `src/types/marketData.ts`，涵盖官方示例中的所有字段。

## Streamer 实时行情示例

```ts
await sdk.connectStreamer();

sdk.streamer.on('data', (payload) => {
  // 统一处理 data 数组，payload.service 可区分服务类型
  console.log(payload.service, payload.content);
});

// 订阅 QQQ Level 1 行情（默认字段）
sdk.marketDataStream.subscribeLevelOneEquities({ keys: 'QQQ' });

// 订阅股票分时图，1 分钟频率，回溯 1 天
sdk.marketDataStream.subscribeChartEquity({ keys: 'QQQ', frequency: '1', period: '1' });

// 订阅 NASDAQ Level II 深度
sdk.marketDataStream.subscribeNasdaqBook({ keys: 'AAPL', fields: '0,1,2' });
```

如需取消订阅，可直接使用 `sdk.streamer.send({ requests: [...] })` 发送 `UNSUBS` 命令，或调用 `sdk.disconnectStreamer()` 断开当前连接。
`StreamerClient` 会在断线后自动重新登录并恢复已记录的订阅，同时监控 Schwab 的心跳包，在检测到“僵尸连接”时会主动关闭
socket 并触发重连。

## 错误处理

- REST API：统一抛出 `SchwabApiError`，包含状态码、请求 URL、响应头以及解析后的错误详情（自动提取 `errors[].detail` / `message` 字段）。
- OAuth：刷新失败时 `TokenManager` 会打印警告并继续使用旧令牌，或在缓存缺失时抛出错误提示开发者重新授权。
- Streamer：`StreamerClient` 提供 `error`、`close` 事件；`autoReconnect` 为 true 时会自动重连。
- 日志：默认的 `ConsoleLogger` 会记录每一步操作，可通过 `logLevel` 控制详略，或注入自定义实现（如写入文件/集中式日志）。

## 示例脚本

`examples/` 目录提供常见场景脚本（首次授权、行情查询、Streamer 订阅）。配置好环境变量后：

```bash
npm run example:authorize -- --open
npm run example:quotes -- AAPL,QQQ
npm run example:history -- TSLA 20
npm run example:stream -- QQQ
npm run example:account-stream
```

其中 `--open` 标记会尝试自动打开浏览器完成授权，若在服务器环境下可移除该参数。
脚本内部均引用 `SchwabOwokit` 并包含必要注释，可直接复制为自己的项目入口。

## 文件结构

```
src/
  auth/              OAuth 相关逻辑
  clients/           Trader & Market Data REST 客户端
  streamer/          WebSocket 客户端与实时市场数据封装
  types/             官方文档映射的 TypeScript 类型
  utils/             公共工具，如 HttpClient
```

## 许可

此项目默认为私有使用，若需开源发布请补充 License 文件。
