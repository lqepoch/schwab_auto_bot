# schwab-owokit

一个面向 Charles Schwab Trader / Market Data REST / Streamer API 的 TypeScript SDK，适配 Node.js ≥ 24。SDK 当前作为仓库内的私有本地 package 维护，构建产物位于 `dist/`。

## 功能概览

- ✅ OAuth2 授权码流程：生成授权 URL、换取令牌、自动刷新、落盘缓存
- ✅ REST 只读调用自动处理 401：令牌过期会透明刷新后重试；交易写入不会透明重发
- ✅ Trader REST API：账户、订单、交易记录、偏好设置等全部端点
- ✅ Market Data REST API：报价、期权链、历史行情、市场时间、标的信息
- ✅ Streamer WebSocket：Level One/Book/Chart/筛选器/账户活动实时推送
- ✅ 中文注释 & 类型提示：调用体验对照官方字段

## 快速开始

### 1. 安装、构建和测试

```bash
npm --prefix vendor/schwab-api-nodejs install
npm --prefix vendor/schwab-api-nodejs run typecheck
npm --prefix vendor/schwab-api-nodejs run typecheck:test
npm --prefix vendor/schwab-api-nodejs run build
npm --prefix vendor/schwab-api-nodejs test
```
`npm test` 会先检查测试代码类型，再构建并自动发现 `test/*.test.ts` 与 `test/*.test.mjs`。该 SDK 尚未发布到 npm registry，因此不要使用 `npm install schwab-owokit`。`dist/` 和 `node_modules/` 是本地构建产物，不应提交。

### 2. 初始化 SDK

先按部署环境配置 `SCHWAB_CLIENT_ID`、`SCHWAB_CLIENT_SECRET`、`SCHWAB_REDIRECT_URI` 等环境变量。构建后从本地 package 的入口导入：

```ts
import { SchwabOwokit, createConsoleLogger } from './vendor/schwab-api-nodejs/dist/public.js';

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

如果希望由脚本自动打开授权链接，可调用 `await sdk.openAuthorizeUrl()`。`examples/` 下的文件是源码参考，核心 package 没有声明 `example:*` npm scripts。

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

// 下单；成功结果包含 201、Location、orderId 与 Schwab correlation id
const placed = await sdk.trader.placeOrder(accountHash, {
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
console.log(placed.orderId, placed.location, placed.correlationId);

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
  includeUnderlyingQuote: true,
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

请求会发送 Schwab 官方的 `includeUnderlyingQuote` query key；旧的 `includeQuotes` 仅作为 deprecated alias 接受，绝不会发送到服务端。

Market Data REST 数据结构定义在 `src/types/marketData.ts`，涵盖官方示例中的所有字段。

## Streamer 实时行情示例

```ts
await sdk.connectStreamer();

sdk.streamer.on('data', (payload) => {
  // 统一处理 data 数组，payload.service 可区分服务类型
  console.log(payload.service, payload.content);
});

// 订阅 QQQ Level 1 行情（默认字段）
await sdk.marketDataStream.subscribeLevelOneEquities({ keys: 'QQQ' });

// 订阅股票分时图，1 分钟频率，回溯 1 天
await sdk.marketDataStream.subscribeChartEquity({ keys: 'QQQ', frequency: '1', period: '1' });

// 订阅 NASDAQ Level II 深度
await sdk.marketDataStream.subscribeNasdaqBook({ keys: 'AAPL', fields: '0,1,2' });
```

如需取消订阅，可直接使用 `sdk.streamer.send({ requests: [...] })` 发送 `UNSUBS` 命令，或调用 `sdk.disconnectStreamer()` 断开当前连接。
`StreamerClient` 会在断线后自动重新登录并恢复已记录的订阅，同时监控 Schwab 的心跳包，在检测到“僵尸连接”时会主动关闭
socket 并触发重连。

`subscribe()` / `unsubscribe()` 返回的 Promise 会按命令校验 Streamer ACK：兼容通用成功码 `0`，并接受 Schwab 文档规定的 `SUBS=26`、`UNSUBS=27`、`ADD=28`、`VIEW=29`；`LOGIN` 只接受 `0`。拒绝响应、命令/服务不匹配、连接断开和 ACK 超时都会 reject。非零且不匹配的 ACK 是明确拒绝，会回滚该次 canonical mutation；连接断开或 ACK 超时是未知结果，会保留期望的 canonical state 并受控重连，以完整 `SUBS` 对账后才再次报告 ready。底层 `sdk.streamer.send()` 仍是原始发送接口，不提供 ACK 语义。重连恢复会等待每个 service 的完整 `SUBS` ACK 后才报告 ready，不代表已经收到新行情。

可从 package root 按 ACK 结果类型捕获：`import { StreamerCommandError, StreamerCommandTimeoutError, StreamerCommandNotSentError } from './vendor/schwab-api-nodejs/dist/public.js';`

## 错误处理

- REST API：统一抛出 `SchwabApiError`，包含状态码、请求 URL、响应头以及解析后的错误详情（自动提取 `errors[].detail` / `message` 字段）。
- OAuth：刷新失败时只有仍未过期的访问令牌可以短暂 fallback；过期令牌或 `invalid_grant` 会抛出 `ReauthRequiredError`（`SCHWAB_REAUTH_REQUIRED`），必须重新授权。
- Trader 写入：`placeOrder`、`replaceOrder`、`cancelOrder` 与 `previewOrder` 都只发送一次物理请求，不生成或推断客户端幂等键。`placeOrder`、`replaceOrder`、`cancelOrder` 遇到网络错误或 5xx，或创建/替换响应缺少有效 `Location`，会抛出 `UnknownOutcomeError`（`SCHWAB_UNKNOWN_OUTCOME`）；`previewOrder` 保持单次请求并按普通 REST 错误返回。调用方必须先对账再决定下一步。
- Streamer：`StreamerClient` 提供 `error`、`close` 事件；`autoReconnect` 为 true 时会自动重连。
- 日志：默认的 `ConsoleLogger` 会记录每一步操作，可通过 `logLevel` 控制详略，或注入自定义实现（如写入文件/集中式日志）。

## 示例脚本

`examples/` 目录提供首次授权、行情查询和 Streamer 订阅的源码参考，不是核心 package scripts；核心 package 没有声明 `example:*` npm scripts。请在调用方选择并配置 TypeScript runner 后再运行这些文件。

## 文件结构

```
package.json        本地 package 元数据与 build/typecheck/test scripts
package-lock.json   npm 依赖锁定
tsconfig.json       NodeNext ESM strict declaration build 配置
test/               Node test 契约测试
dist/               build 生成目录（不提交）
src/
  auth/              OAuth 相关逻辑
  clients/           Trader & Market Data REST 客户端
  streamer/          WebSocket 客户端与实时市场数据封装
  types/             官方文档映射的 TypeScript 类型
  utils/             公共工具，如 HttpClient
```

## 许可

此项目默认为私有使用，若需开源发布请补充 License 文件。
