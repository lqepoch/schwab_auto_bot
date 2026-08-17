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
npm install
npm run typecheck
npm run typecheck:test
npm run build
npm test
```
`npm test` 会先检查测试代码类型，再构建并自动发现 `test/*.test.ts` 与 `test/*.test.mjs`。该 SDK 尚未发布到 npm registry，因此不要使用 `npm install schwab-owokit`。`dist/` 和 `node_modules/` 是本地构建产物，不应提交。

### 2. 初始化 SDK

先按部署环境配置 `SCHWAB_CLIENT_ID`、`SCHWAB_CLIENT_SECRET`、`SCHWAB_REDIRECT_URI` 等环境变量。构建后从本地 package 的入口导入：

```ts
import { SchwabOwokit, createConsoleLogger } from './dist/public.js';

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

## 新增 SDK 完整性边界

### 只读 Gateway 与响应 metadata

`sdk.gateway` 是明确的只读 facade：账户号会先通过 `GET /accounts/accountNumbers` 解析为 Schwab 所需 hash，当前已覆盖并返回 `{ data, metadata }` 的端点为：Trader 的 `GET /accounts`、`GET /accounts/{accountNumber}`、`GET /accounts/{accountNumber}/orders`、`GET /accounts/{accountNumber}/orders/{orderId}`，以及 Market Data 的 `GET /quotes`、`GET /{symbol}/quotes`。`metadata` 保留原始 `Headers`、status、requestId、method、完整 URL、correlation id 和 allow-list rate-limit 解析值。

Gateway 当前不宣称覆盖全部 REST 只读端点。跨账户订单、transactions、user preferences、option chains/expiration、price history、movers、market hours、instruments 及标准化/派生期权报价仍直接使用 `sdk.trader` / `sdk.marketData`；这些 documented raw REST GET 均提供对应的 `get*WithResponse` metadata variant，标准化/派生方法仍只返回 body。Gateway 没有 `previewOrder`、`placeOrder`、`replaceOrder` 或 `cancelOrder`，不会接入或改变根项目的 Preview、WAL、写入闸门、UnknownOutcome 和单次物理写入路径。

默认 TokenStore 仍是 owner-only 文件实现；可通过 `SchwabOwokitOptions.tokenStore` 注入 `TokenStoreAdapter`（仅 `load`/`save`），SDK 不模拟 KMS/keychain。adapter 读取失败、保存失败或无法证明令牌完整时必须返回 null/抛错并 fail-closed。

HttpResponse 和 SchwabApiError 统一保留 requestId、method、URL、status、原始 Headers、correlation id 与 rate-limit 解析结果；敏感头不会进入错误 JSON。`GET` 的 401 refresh 语义保留，mutation 不透明自动重试。

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

随附 Schwab Data API 文档明确所有市场服务支持 `VIEW`，`ACCT_ACTIVITY` 例外只支持 `SUBS`/`UNSUBS`；因此 `MarketDataStreamClient` 暴露各市场服务的 typed `view*` wrapper，但不提供 `viewAccountActivity`。`LEVELONE_EQUITIES` 继续保留 `streamer-fields` 的 canonical exports，同时通过 `streamer-contracts` 纳入统一 service map；本地 manifest 中的 field id 都在发包前校验，未知 additive payload fields 仍 passthrough。

`streamer-snapshot` 提供 opt-in、可取消的 async iterator 和 bounded queue，不宣称原生 complex option book 或交易执行报价。缓存只接受文档顺序证据：CHART_EQUITY/ACCT_ACTIVITY 使用 documented sequence；CHART_FUTURES 虽标为 All Sequence 但没有独立 sequence 字段，只使用字段 `1` Chart Time，缺失时 fail-closed，不伪造连续序列。socket generation 切换会隔离旧代数据。

可从 package root 按 ACK 结果类型捕获：`import { StreamerCommandError, StreamerCommandTimeoutError, StreamerCommandNotSentError } from './dist/public.js';`

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
  gateway/           只读账户/订单/行情 facade（不含写操作）
  clients/           Trader & Market Data REST 客户端
  streamer/          WebSocket 客户端与实时市场数据封装
  types/             官方文档映射的 TypeScript 类型与全服务 field contracts
  contracts/         本地 endpoint/service/schema parity manifest
  utils/             公共工具，如 HttpClient
```

稳定的 root/subpath 导入包括 `schwab-owokit/streamer-contracts`、`schwab-owokit/streamer-snapshot`、`schwab-owokit/gateway`、`schwab-owokit/token-store` 和 `schwab-owokit/contract-manifest`。`npm run typecheck`、`npm run typecheck:test` 与 `npm test` 会在本地 fixture 上执行；parity manifest 锁定 client method、runtime schema 和 Streamer service/field contract，但不替代真实 Schwab entitlement、权限或 live API 验证。默认测试不会连接 Schwab，也不会发送 broker 请求。

## 许可

此项目默认为私有使用，若需开源发布请补充 License 文件。
