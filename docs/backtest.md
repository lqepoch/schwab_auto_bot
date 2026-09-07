# 只读 1 分钟历史回测

`src/backtest/` 是与 Schwab 自动交易运行时隔离的研究模块。它只读取被
manifest 精确指定且带 SHA-256 的本地文件或 OSS 对象，输出 JSON 审计/回测
artifact；不会导入 `src/automation/`，不会调用 Schwab，也没有 broker 写入
能力。

## 复用与边界

- 条件读取、SHA-256、gzip、JSON/JSONL/CSV 和 Node 子进程使用 Node 24
  标准能力；确定性 JSON 使用 `src/backtest/fingerprints.ts`。
- OSS archive 的 Parquet 解码复用 `hyparquet@1.30.0` 与
  `hyparquet-compressors@1.1.1`；它们在 Node 中解析 archive 内的压缩列，运行时
  不需要另起 Python/Arrow 服务。
- OSS 适配器采用官方文档示例路线的 `ali-oss@6.23.0`，以
  `authorizationV4: true` 创建客户端。正常 manifest/catalog reader 只暴露精确
  对象 `HEAD`/`GET`；独立的 current-universe discovery adapter 才能在双确认后对
  每个显式 `symbol/year/` 前缀发起 `listV2(delimiter="/")`，不提供 `PUT`/`DELETE`。
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

成分股代码与 provider 的交易代码是两个不同的身份层，不能因字符串看起来相似就
自动替换或去掉 `.`、`-`。catalog 的 `universe.symbols` 必须是实际 bars 中的
provider symbol；若上游快照使用了其他代码，调用方必须先生成一个独立、哈希固定的
symbol-resolution receipt（原代码、provider 代码、理由、查询证据）。无法交易的
escrow/CVR/现金/期货等持仓也必须有单独 exclusion receipt，不能悄悄从
`current-constituents` 删除。

S&P 500、Nasdaq-100 和 Russell 3000 若要分别回测，快照还必须保留每个 symbol 的
index-membership 标签；只保存三个来源的去重并集不能在事后可靠地恢复各指数成员。若
策略需要权重，快照还要冻结权重和 rebalancing 规则；本模块不会暗中假设市值权重或
等权重。

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

为兼容已归档的历史对象，Parquet 内 `session=intraday` 被狭义映射为
`regular`：它是 archive v1 对同一官方时段桶的旧标签。`premarket`/`postmarket`
不会被该映射吞并；如需把 session 声明升级为交易所日历覆盖证明，必须另存可复核
的日历 receipt。

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

`--backtest-env-file` 可按逗号提供多个受保护文件，按从左到右加载（进程已设置的变量仍有
最高优先级）。因此可把非敏感 endpoint/bucket 放在用户根 `.env`，把 OSS access
key 留在专用 market-data `.env`；两者都不会被提交，也不会写入 artifact。当前已
配置的 bucket endpoint 必须保留 `https://` 前缀，例如
`https://stock-lq.oss-ap-southeast-1-internal.aliyuncs.com`。

如果 endpoint 已经是 `bucket.oss-...` 形式的精确 bucket 域名，设置
`OSS_ENDPOINT_STYLE=bucket` 或现有的 `MARKET_DATA_S3_ENDPOINT_STYLE=bucket`。
reader 会使用 OSS CNAME 模式，避免 SDK 再次拼接 bucket；未设置时也会按 hostname
自动识别。服务 endpoint 则使用 `service`。这只影响传输地址，不能改变 manifest
中的 bucket/key 身份，也不会给正常回测运行时增加 LIST/PUT/DELETE 权限。

```bash
npm run backtest:preflight -- \
  --manifest /path/to/2016-manifest.json \
  --backtest-env-file /path/to/oss.env \
  --output-dir .artifacts/backtest/2016
npm run backtest:audit -- \
  --manifest /path/to/2016-manifest.json \
  --backtest-env-file /path/to/oss.env --allow-network \
  --output-dir .artifacts/backtest/2016
npm run backtest:run -- \
  --manifest /path/to/2016-manifest.json --symbol AAPL \
  --backtest-env-file /path/to/root.env,/path/to/oss-credentials.env --allow-network \
  --output-dir .artifacts/backtest/2016
```

使用 archive 原始 manifest 时，先执行一次精确 import。该操作只会对所给
`manifest.json` 发起 HEAD/GET，计算其 hash，并由 manifest 的逻辑 key 推导一次
不可变的 `bars.parquet` key；运行时不会 LIST bucket：

```bash
npm run backtest -- import-archive \
  --archive-manifest-uri oss://stock-lq/EXACT/PATH/manifest.json \
  --manifest-out .artifacts/backtest/aapl-2016-manifest.json \
  --session regular --feed sip --allow-network \
  --backtest-env-file /path/to/root.env,/path/to/oss-credentials.env \
  --output-dir .artifacts/backtest/archive-import
```

这个 import 生成的是单标的 `proxy` manifest，刻意不能冒充完整指数。完整 S&P
500、Nasdaq-100 或 Russell 3000 的回测，须把“当前成分”快照（含 source、hash 和
symbols）与每个 archive shard 组成一个精确 catalog；`current-constituents` 意味着
明确存在幸存者偏差，不能替换成历史成分。

catalog reader 对 `run --symbol` 只读取该 symbol/date 相交的 shard，适合逐标的
验证、因子计算或把结果作为后续组合引擎的输入。它不会把当前的
`long-only-cash-equity-v1` 参考模拟包装成多资产指数策略：全体成分的十年分钟线应由
流式/分区组合引擎或预聚合日线层处理，并显式提供 weights、rebalance、成交模型、
成本和 corporate-actions receipt。`audit`/未指定 symbol 的 `parity` 会读取所有声明
shard，artifact 会明确给出相应 warning。

### 冻结当前成分与生成 catalog

当前成分不是 S&P/Nasdaq/Russell 的自动全集。调用方必须先提供 OSS 中已经存在的、
带 SHA-256 的 current snapshot manifest；discovery 只读取该 snapshot 和精确 archive
manifest，并把每一个 `symbol/year` 的 prefix、delimiter、分页和 revision 结果写入
冻结 JSON。`--allow-network` 与 `--allow-list-discovery` 缺一不可；缺失 revision、多个
revision、alias 或意外对象都会得到 `UNVERIFIED`，不会选择 latest/current 或任一 revision。

```bash
npm run backtest:discover-universe -- \
  --universe-manifest-uri oss://BUCKET/EXACT/SNAPSHOT-MANIFEST.json \
  --archive-root-uri oss://BUCKET/EXACT/ARCHIVE-ROOT \
  --start-year 2016 --end-year 2025 \
  --allow-network --allow-list-discovery \
  --backtest-env-file /path/to/oss.env \
  --discovery-out /path/to/current-universe-discovery.json \
  --output-dir .artifacts/backtest/current-universe-discovery
```

正常 `audit`/`run` 不会 LIST。只有人工审查 discovery JSON 为 `PASS` 后，才可离线
materialize；它要求每个 action receipt 的文件 SHA-256 由命令行显式提供，并验证
receipt 的 symbols、since/until、`commandFingerprint`、`dataFingerprint` 和 action 文件
hash，并验证这些 receipt 覆盖 discovery 的每个
symbol 与每个年份。可以把多个不重叠批次用逗号传入；缺 coverage、command/data fingerprint
或重复/越界行动会
fail-closed，不会生成 catalog 或 manifest：

```bash
npm run backtest:materialize-universe-catalog -- \
  --discovery /path/to/current-universe-discovery.json \
  --actions-receipt /path/to/batch-001/alpaca-actions-receipt.json,/path/to/batch-002/alpaca-actions-receipt.json \
  --actions-receipt-sha256 RECEIPT_SHA256_1,RECEIPT_SHA256_2 \
  --catalog-out /path/to/current-universe-catalog.json \
  --actions-out /path/to/current-universe-actions.json \
  --manifest-out /path/to/current-universe-manifest.json \
  --output-dir .artifacts/backtest/current-universe-materialize
```

2599 个 symbol 不应塞进一个未经审查的超长 provider 命令。用 `--symbols-file` 每行
一个、不改写代码的文件，按人工分批分别运行 `fetch-actions`，保留每批 receipt；再把
所有 receipt/hash 传给上面的 materialize。`--symbols-file` 会拒绝小写、重复和别名
代码；不要用脚本自动把 `BRK.B` 替换为 `BRK-B`。

### 企业行动 receipt

用已有 Alpaca market-data 凭证获取企业行动时，必须显式允许网络；CLI 会
使用 `ALPACA_API_KEY`/`ALPACA_SECRET_KEY`（也兼容 `APCA_*`、
`ALPACA_MARKET_DATA_*` 和现有 `ALPACA_PAPER_*` 环境变量），只执行只读
corporate-actions 查询。当多组变量同时存在时，显式 `ALPACA_*`/`APCA_*` 优先，
其次为 `ALPACA_PAPER_*`，最后才是 `ALPACA_MARKET_DATA_*`，避免失效的旧数据键
覆盖有效的 Paper 数据访问键。

```bash
npm run backtest:fetch-actions -- \
  --symbols AAPL,MSFT --since 2016-01-01 --until 2016-12-31 \
  --backtest-env-file /home/ecs-user/github/stock_trading_bot/.env \
  --allow-network --max-pages 10000 \
  --actions-out /path/to/2016-alpaca-actions.json \
  --output-dir .artifacts/backtest/2016-actions
```

该命令保存 action 文件 SHA-256、coverage 和 CLI 查询 receipt；不能把 fixture 或本地静态
检查升级为真实 provider 证据。实时获取到的 provider corporate-actions 只证明
当前响应，不是 2016 当时的 point-in-time corporate-action 证据；必须把 receipt
固定到 manifest 后再用于可复现 run。

archive 已声明 `raw`、`feed=sip` 时，还可用同一 Alpaca CLI 做原始分钟线抽样或全年
比较。比较只要求 archive 已声明的 SIP 行逐行出现在 provider 响应中；provider 返回
的盘前/盘后行会报告为 `providerOutOfScopeRows`，不会错误当成 archive 缺行，也不会
据此声称已独立验证交易日历覆盖：

```bash
ALPACA_LIVE_TRADE=false npm run backtest -- provider-parity \
  --manifest .artifacts/backtest/aapl-2016-manifest.json --symbol AAPL \
  --start 2016-01-04T14:30:00Z --end 2016-12-30T20:59:00Z \
  --allow-network --max-pages 300 \
  --backtest-env-file /path/to/root.env,/path/to/oss-credentials.env \
  --output-dir .artifacts/backtest/aapl-2016-provider-parity
```

2016 数据对比需要两个各自有精确 manifest 的数据源（例如 OSS catalog 与
本地导出），命令如下；没有两个真实 manifest 时不得声称 parity 完成：

```bash
npm run backtest:parity -- \
  --left /path/to/2016-oss-manifest.json \
  --right /path/to/2016-reference-manifest.json \
  --backtest-env-file /path/to/oss.env --allow-network \
  --output-dir .artifacts/backtest/2016-parity
```
