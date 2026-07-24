# Schwab Auto Bot

面向 Schwab 的 Node.js 24 自动化调度器。它的运行时只有一个入口：`src/main.ts`。

项目已将 `vendor/schwab-api-nodejs` 中的 HTTP 传输层直接纳入主调用链：账户、订单、Preview、Submit、Replace 与 Cancel 都先经过同一配额准入，再使用 SDK 传输层发出一次物理请求。没有第二个 `node_vertical_cli` 运行入口，也不需要 Python、SQLite 或单独安装 vendor SDK。

## 安全边界

- 默认拒绝真实写入；只有精确传入 `--confirm-live I_UNDERSTAND` 才会启动真实自动交易循环。
- `--read-only` 禁止 Preview、Submit、Replace 和 Cancel；`--once` 在一次账户与订单快照后退出。
- 所有 SDK 请求的内置重试均关闭。配额、429 退避、写入串行化和未知写入结果由主程序统一控制，避免一次逻辑请求产生未计量的 broker 请求。
- `ACCT_ACTIVITY` 流消息仅触发 REST 订单对账；成交与终态只以 Schwab REST 订单快照为准。
- 写入前必须有 Schwab Preview；最终 broker 写入由单一写入闸门串行化。失败或缺少 broker `Location` 订单 ID 的写入会进入未知结果隔离，不会自动重发。

## 安装

```powershell
cd D:\UE_Project\schwab_auto_bot
npm install
```

需要 Node.js 24 或更高版本。

## 首次 OAuth 登录

在同一个 PowerShell 会话中设置 Schwab 开发者应用凭据：

```powershell
$env:SCHWAB_APP_KEY = '...'
$env:SCHWAB_APP_SECRET = '...'
$env:SCHWAB_CALLBACK_URL = 'https://127.0.0.1'
npm run auth:login
```

命令会打开授权页。完成后将地址栏中的完整回调 URL 粘贴回终端。认证状态与 token 可用性可通过下列命令检查：

```powershell
npm run auth:status
```

真实策略采用北京时间每周一 06:00 为一周边界。首次升级到该策略版本后，以及每个新周期的第一次真实运行前，都必须重新完成一次 OAuth 授权；同一周内其余运行复用这次授权。命令如下：

```powershell
npm run auth:relogin
```

`auth:status` 中的 `weeklyReauthRequired: true` 表示真实写入会被拒绝；只读命令不受影响。

完成回调 URL 粘贴并出现“登录完成”后，`auth:login` 和 `auth:relogin` 会自动退出并返回 PowerShell 提示符；不需要手动按 `Ctrl+C`。

认证文件默认写入 `state/schwab-auth.json`（已被 Git 忽略）。它包含 client secret 与 token，必须按敏感凭据保护；可通过 `SCHWAB_BOT_AUTH_FILE` 指向受保护的绝对路径。

## 运行

先使用只读单次检查验证账户关联和订单快照：

```powershell
node .\src\main.ts --read-only --once
```

只读常驻模式可用于观察账户活动与对账，使用 `Ctrl+C` 停止：

```powershell
node .\src\main.ts --read-only
```

以下命令会执行真实自动化写入，包括 Preview、Submit、Replace 和 Cancel。仅在策略、账户、市场时段及风险边界均已人工确认后使用：

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND
```

当前策略处理配置标的的当日到期两腿垂直价差；启动时要求且只允许一个 Schwab linked account。

## 策略参数与执行时间

默认只有纽约时间工作日 09:15（开盘前 15 分钟）至 15:45（收盘前 15 分钟）的区间允许 Preview、Submit、Replace 与 Cancel。窗口外仍会执行只读订单/持仓对账，但不会产生任何 broker 写入。

默认策略标的为 `QQQ,SPY`，行权价范围为 720–790，入场单名义金额范围为 84–90；对于一张期权合约，这对应买入价 0.84–0.90。日常启动无需传入这些默认参数，也无需传入默认执行时间：

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND
```

仅在需要覆盖默认值时才传入对应参数。例如：

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND `
  --underlyings QQQ,SPY `
  --strike-min 720 --strike-max 790 `
  --entry-notional-min 84 --entry-notional-max 90
```

`--execution-start` 与 `--execution-end` 默认分别为 `09:15` 和 `15:45`（纽约时间）；只在需要变更执行窗口时传入，例如 `--execution-start 09:30 --execution-end 15:30`。

整体刷新每轮只读取一次完整订单快照，直接使用其中的 broker order ID 执行原生 Replace；不会在每次 Replace 前发起 `/orders/{orderId}` 的额外 GET。没有可用 ID 或刷新失败时，该候选在本轮失败，下一轮从新的完整快照重新判断。

## 验证

```powershell
npm run check
npm test
```

测试覆盖 SDK 传输整合的关键边界：保留 Schwab 写入响应的 `Location` 订单 ID、失败请求绝不由 SDK 隐式重试、执行窗口与周重登录边界。
