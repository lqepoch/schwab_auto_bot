# 只读 1 分钟历史回测

`src/backtest/` 是与 Schwab 自动交易运行时隔离的研究模块。它只读取被
manifest 精确指定且带 SHA-256 的本地文件或 OSS 对象，输出 JSON 审计/回测
artifact；不会导入 `src/automation/`，不会调用 Schwab，也没有 broker 写入
能力。

## 复用与边界

- 条件读取、SHA-256、gzip、JSON/JSONL/CSV 和 Node 子进程使用 Node 24
  标准能力；确定性 JSON 使用 `src/backtest/fingerprints.ts`。
- OSS 适配器采用官方文档示例路线的 `ali-oss@6.23.0`，以
  `authorizationV4: true` 创建客户端。适配器只暴露精确对象 `HEAD`/`GET`；
  不提供 `LIST`、`PUT`、`DELETE`。
- Alpaca 企业行动通过已安装的 Alpaca CLI 的
  `alpaca data corporate-actions` 读取，而不是绕过 CLI 的 HTTP 请求。CLI
  参数和响应以本机 `--help`/`--schema` 为准，结果必须保存为带查询指纹的
  receipt。当前 CLI 的 grouped 响应（例如 `forward_splits`、
  `reverse_splits`、`cash_dividends`）和现金分红的 `rate` 字段会被明确归一化；
  未知 group/type 或 group 与行内 type 不一致会 fail-closed。
- LEAN 没有接入：本仓库没有 LEAN 数据格式/运行时，LEAN 本地 CLI 需要
  Docker、额外数据转换和 QuantConnect 组织权限；引入它不会缩小本任务的
  可审计边界。

## Manifest 与数据身份

manifest 锁定 dataset、`feed=alpaca`、`timeframe=1m`、session、调整模式、
日期范围、universe 和一个精确 `sourceObject`。`sourceObject` 的 URI 禁止
`latest`、`current`、glob 和 query；其 `sha256`、schema、format、compression
必须与读取内容一致。

大规模数据必须使用 `kind: "catalog"` 的 JSON catalog。catalog 本身带哈希，
每个 shard 另外带 URI、哈希、schema、format、compression、日期 bounds 和
symbols。运行指定 `--symbol` 时，reader 先按 symbol/date 选择 shard，再读取
所选对象；不会为了单标的下载整个 S&P/Nasdaq/Russell 数据集。audit/parity
未指定 symbol 时会读全部声明 shard，artifact 会写出
`CATALOG_AUDIT_READS_ALL_DECLARED_SHARDS` 警告。

universe 必须声明 `source`、fingerprint 和 completeness。`proxy` 只能表示
fixture/demo 代理，不能表示完整指数成分；本模块不会自行抓取或声称拥有
当前 S&P 500、Nasdaq 或 Russell 3000 全集。`current-constituents` 只有在
调用方提供并哈希固定快照后才可使用。

## 复权与企业行动

`corporateActions.appliesToBars` 的定义是：企业行动的价格影响是否已经包含
在 manifest 指定的 bars 中。

- `false`：bars 必须是 raw；manifest 必须指向哈希固定的企业行动文件，参考
  simulator 对 split/dividend 各应用一次。
- `true`：bars 已经反映这些行动；行动文件只作为审计证据，simulator 不再
  应用，避免 adjusted bars + actions 双重调整。
- raw bars + `mode: "none"`：audit 是 `UNVERIFIED`，`backtest:run` 直接
  fail-closed；不会把没有行动证据的 raw 数据当成 total-return 结果。
- `adjustmentMode: "unknown"`、未知行动类型、重复行动和不匹配哈希都会
  fail-closed。

Alpaca 的 `forward_split`/`reverse_split`/`cash_dividend` 会明确归一化为
 内部 `split`/`dividend`；其他类型拒绝，不会猜测。当前实现不把 yfinance
作为运行时隐式 fallback；如需补齐，应先生成可复核、带 hash 的本地 receipt
文件，再在 manifest 中显式引用。

`session` (`regular`、`extended`、`all`) 也是数据声明，不是交易所日历证明。
当前 artifact 会写 `session.verification=DECLARED_UNVERIFIED` 和对应 warning；
模块不会暗中把 bars 当作已过滤的常规交易时段。

## 命令与证据

所有命令默认不联网。`audit`、`parity` 的 `BLOCKED`、`FAIL` 或
`UNVERIFIED` 状态会以非零退出码结束，避免自动化把缺配置或不完整证据当作
成功；错误 JSON 只包含错误码，不打印密钥或原始 provider 错误。

使用仓库内 demo fixture（仅 AAPL 代理，不代表指数成分）：

```bash
npm install
npm run backtest:preflight -- \
  --manifest examples/backtest/demo-manifest.json \
  --output-dir .artifacts/backtest/demo
npm run backtest:audit -- \
  --manifest examples/backtest/demo-manifest.json \
  --output-dir .artifacts/backtest/demo
npm run backtest:run -- \
  --manifest examples/backtest/demo-manifest.json \
  --symbol AAPL --initial-cash 100 \
  --output-dir .artifacts/backtest/demo
```

demo manifest 使用 raw bars 和本地 fixture 企业行动，因此 run 是可复现的
price-plus-cash-dividend 参考模拟；它不是投资建议、完整市场回测或 provider
验收。首次买入按整股成交，内部仓位使用六位小数 micro-shares，因此 3:2
等拆股不会截断 fractional shares；artifact 中保留 manifest/data/action fingerprints、source objects、
warnings、assumptions、trades 和 metrics。

对真实 OSS 数据，先准备调用方自己的受保护环境文件。优先使用
`OSS_ENDPOINT`、`OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、
`OSS_ACCESS_KEY_SECRET`，可选 `OSS_SECURITY_TOKEN`。为兼容仓库已有 market-data
部署环境，reader 也接受 `MARKET_DATA_S3_ENDPOINT`、`MARKET_DATA_S3_REGION`、
`MARKET_DATA_S3_BUCKET`、`ALIBABACLOUD_ACCESS_KEY_ID` 和
`ALIBABACLOUD_SECRET_ACCESS_KEY`；前一组 `OSS_*` 有更高优先级。不要把文件提交
仓库，也不要使用 LIST 找“最新”对象；把具体 `oss://bucket/exact-key` 和哈希写入
manifest 后再执行：

如果 endpoint 已经是 `bucket.oss-...` 形式的精确 bucket 域名，设置
`OSS_ENDPOINT_STYLE=bucket` 或现有的 `MARKET_DATA_S3_ENDPOINT_STYLE=bucket`。
reader 会使用 OSS CNAME 模式，避免 SDK 再次拼接 bucket；未设置时也会按 hostname
自动识别。服务 endpoint 则使用 `service`。这只影响传输地址，不能改变 manifest
中的 bucket/key 身份，也不会给运行时增加 LIST/PUT/DELETE 权限。

```bash
npm run backtest:preflight -- \
  --manifest /path/to/2016-manifest.json \
  --env-file /path/to/oss.env \
  --output-dir .artifacts/backtest/2016
npm run backtest:audit -- \
  --manifest /path/to/2016-manifest.json \
  --env-file /path/to/oss.env --allow-network \
  --output-dir .artifacts/backtest/2016
npm run backtest:run -- \
  --manifest /path/to/2016-manifest.json --symbol AAPL \
  --env-file /path/to/oss.env --allow-network \
  --output-dir .artifacts/backtest/2016
```

当前没有在仓库中配置 OSS endpoint/bucket/access key；没有配置时 preflight
明确返回 `BLOCKED`，audit 不会伪造 2016 数据已验证。

用已有 Alpaca market-data 凭证获取企业行动时，必须显式允许网络；CLI 会
使用 `ALPACA_API_KEY`/`ALPACA_SECRET_KEY`（也兼容 `APCA_*`、
`ALPACA_MARKET_DATA_*` 和现有 `ALPACA_PAPER_*` 环境变量），只执行只读
corporate-actions 查询。当多组变量同时存在时，显式 `ALPACA_*`/`APCA_*` 优先，
其次为 `ALPACA_PAPER_*`，最后才是 `ALPACA_MARKET_DATA_*`，避免失效的旧数据键
覆盖有效的 Paper 数据访问键。

```bash
npm run backtest:fetch-actions -- \
  --symbols AAPL,MSFT --since 2016-01-01 --until 2016-12-31 \
  --env-file /home/ecs-user/github/stock_trading_bot/.env \
  --allow-network --max-pages 10 \
  --actions-out /path/to/2016-alpaca-actions.json \
  --output-dir .artifacts/backtest/2016-actions
```

该命令保存 action 文件 SHA-256 和 CLI 查询 receipt；不能把 `alpaca doctor`
失败、fixture 或本地静态检查升级为真实 provider 证据。当前已知共享环境的
Alpaca 凭证探测返回 HTTP 401，因此该命令仍应按 `UNVERIFIED_PROVIDER_ERROR`
处理，不能重试成验收结论。

2016 数据对比需要两个各自有精确 manifest 的数据源（例如 OSS catalog 与
本地导出），命令如下；没有两个真实 manifest 时不得声称 parity 完成：

```bash
npm run backtest:parity -- \
  --left /path/to/2016-oss-manifest.json \
  --right /path/to/2016-reference-manifest.json \
  --env-file /path/to/oss.env --allow-network \
  --output-dir .artifacts/backtest/2016-parity
```
