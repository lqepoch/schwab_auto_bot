# Schwab Auto Bot

面向 Schwab 的 Node.js 24 自动化调度器。它的运行时只有一个入口：`src/main.ts`。

项目已将 `vendor/schwab-api-nodejs` 中的 HTTP 传输层直接纳入主调用链：账户、订单、Preview、Submit、Replace 与 Cancel 都先经过同一配额准入，再使用 SDK 传输层发出一次物理请求。没有第二个 `node_vertical_cli` 运行入口，也不需要 Python、SQLite 或单独安装 vendor SDK。

## 安全边界

- 默认拒绝真实写入；只有精确传入 `--confirm-live I_UNDERSTAND` 才会启动真实自动交易循环。
- `--read-only` 禁止 Preview、Submit、Replace 和 Cancel；`--once` 在一次账户与订单快照后退出。
- `--disable-sell-orders` 是显式的 live 运行时开关：禁止自动卖单的 Submit、Replace 与 Cancel，并停用所有 exit worker；已有工作卖单保持不变，订单与持仓仍会只读对账。
- 所有 SDK 请求的内置重试均关闭。配额、429 退避、写入串行化和未知写入结果由主程序统一控制，避免一次逻辑请求产生未计量的 broker 请求。
- `ACCT_ACTIVITY` 流消息仅触发 REST 订单对账；成交与终态只以 Schwab REST 订单快照为准。首个活动事件在 250ms 合并后发起高优先级轻量成交同步，不会等待正在进行的完整订单刷新；连续、无可解析详情的活动流最多每 1.5 秒确认一次，避免确认风暴耗尽补买和卖单所需的 API 配额。
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

如需继续维护买单、但完全关闭自动卖出功能，显式传入：

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND --disable-sell-orders
```

该开关不撤销或修改已存在的工作卖单；它只阻止本次运行创建、Replace 或 Cancel 卖单。执行审计日志会记录 `exit.automation.disabled`，而买单与只读订单/持仓对账保持可用。

当前策略处理配置标的的当日到期两腿垂直价差；启动时要求且只允许一个 Schwab linked account。

## 策略参数与执行时间

默认只有纽约时间工作日 09:15（开盘前 15 分钟）至 15:45（收盘前 15 分钟）的区间允许 Preview、Submit、Replace 与 Cancel。窗口外仍会执行只读订单/持仓对账，但不会产生任何 broker 写入。

默认策略标的为 `QQQ,SPY`，行权价范围为 720–790。净买入价是策略硬规则：每张订单数量固定为 1，价格只能是 0.82–0.92；`--entry-notional-min` 与 `--entry-notional-max` 仅接受 `82` 与 `92`，不能用于改变此范围。日常启动无需传入这些默认参数，也无需传入默认执行时间：

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND
```

仅在需要覆盖默认值时才传入对应参数。例如：

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND `
  --underlyings QQQ,SPY `
  --strike-min 720 --strike-max 790
```

如需为每个标的设定一个或多个独立刷新行权价范围，使用 `--refresh-strike-ranges`。格式为逗号分隔的 `标的:最小行权价:最大行权价`；同一标的可重复出现。每个垂直价差的两条腿都必须完整落在其中一个范围内，才会被发现、刷新、补买或通过写入前校验：

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND `
  --refresh-strike-ranges SPY:750:795,SPY:800:820,QQQ:685:790 `
  --disable-sell-orders `
  --repeat-buy-at-order-price
```

使用 `--refresh-strike-ranges` 时不能同时传入 `--underlyings`、`--strike-min` 或 `--strike-max`；范围外的已有工作单只会记录 `POLICY_ALERT`，不会被自动修改或撤销。

`--execution-start` 与 `--execution-end` 默认分别为 `09:15` 和 `15:45`（纽约时间）；只在需要变更执行窗口时传入，例如 `--execution-start 09:30 --execution-end 15:30`。

整体刷新每轮完成后默认间隔 5 秒。fixed-price 模式的每个候选订单在进入 Preview/Replace 链路前，默认至少间隔 2 秒；可用 `--fixed-price-refresh-interval-seconds <秒数>` 覆盖。例如传入 `--fixed-price-refresh-interval-seconds 3` 时，每个候选订单的刷新起始间隔至少为 3 秒。每个固定价刷新轮会等待该轮已入队的策略完成，并且同一策略在该轮至多 Replace 一次；完整订单对账不会将其重复入队。最近 60 秒的已准入 API 调用量达到压力阈值时，配额控制仍会把间隔从 0.7 秒逐步提高到 1.2 秒，因此实际间隔始终取 CLI 值与配额间隔中的较大者。可选 `--max-refresh-rounds <正整数>` 限制普通刷新轮次；省略时无限刷新，传入 `3` 时第三个完整刷新轮结束后受控退出。108 RPM 准入、Preview、最终写入串行化和卖单优先级仍是不可绕过的硬边界。每一轮开始都会读取一次完整订单列表；该快照同时供本轮所有候选筛选与原生 Replace 使用，不会在每次 Replace 前发起 `/orders/{orderId}` 的额外 GET。订单列表与账户、持仓属于不同 Schwab 端点，不能合成单一 HTTP 请求；程序会复用这份完整快照，避免同轮重复读取。没有可用 ID 或刷新失败时，该候选在本轮失败，下一轮从新的完整快照重新判断。

所有自动写入在 Preview 前都执行固定订单策略校验：买单必须是配置标的的 0DTE 双腿垂直价差，价格仅允许 0.82–0.92，数量必须为 1；卖单也必须是 0DTE、数量为 1，价格固定为 0.99。完整订单快照发现仍在工作的违规买/卖单时，程序只会发出 `POLICY_ALERT`，写入终端日志及 `.state/policy-alerts.jsonl`，不会静默撤销外部订单。任何不符合规则的自动 Preview、Submit 或 Replace 都会在发送 Schwab 请求前被拒绝。

### 净价探索与收敛

买单不再保留固定 `0.90` 锚单。每个 0DTE 垂直组合独立维护逻辑订单、订单版本和代际，并把状态保存到 `.state/net-price-explorer.json`；原生 Replace 产生的新 broker order ID 不会改变逻辑订单年龄。

- 只有 Schwab 父级垂直订单完整成交、数量为 1，且 `orderActivityCollection.executionLegs` 可解出精确的实际组合净借记价时，才会产生成交事件。缺少完整执行回报、非整分价格或范围外实际成交价都会失败关闭，不会猜测或补单。
- 同组合、同实际净成交价的完整成交在滚动 10 秒内按非重叠的两两配对消费；第二张成交立即使旧代际未执行动作失效。单张成交先回补同价；单订单模式的双成交生成 `[P-0.01, P-0.01]`，之后的双成交生成 `[P-0.01, P, P]`，并始终裁剪到 0.82–0.92。
- 两订单代际按 `T+0/T+2/T+4/T+6/T+10` 执行下探、同价刷新与恢复；三订单代际按 `T+0/T+2/T+4/T+4.2/T+6/T+8/T+8.2/T+10` 执行。三订单的 `T+6` 依据前两张是否成交决定延迟回补价格。
- 每组工作中的买单最多 3 张。新增候选先争取较低探索价；已有工作单只占槽位，不会被静默撤销。普通轮次按低价、逻辑年龄、逻辑序号排序，组合之间在每轮开始时随机冻结顺序；绑定微时间表动作优先于普通 5 秒组内间隔。

只在需要覆盖刷新节奏时才传入对应参数，例如：

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND `
  --order-cooldown-seconds 2 `
  --round-cooldown-seconds 10
```

### 重复买单价格来源开关

默认不传该开关：探索分桶、回补与下一代订单一律使用 Schwab `executionLegs` 解出的实际组合净成交价。只有在明确传入 `--repeat-buy-at-order-price` 后，完整成交订单才改为使用其原始买入限价；该模式仍要求父级订单完整成交且数量为 1，但故意不读取执行腿成交价，因此价格改善不会改变重复买单或后续探索订单的价格。

```powershell
node .\src\main.ts --confirm-live I_UNDERSTAND --repeat-buy-at-order-price
```

With `--repeat-buy-at-order-price`, the bot disables only price exploration, generation expansion, and price-changing repricing. It maintains at most one working opening order per strategy, repeatedly uses native Replace at that order's existing limit price, and replenishes one new opening order at the submitted limit price after a newly confirmed opening fill. The confirmed refill has priority over sell refreshes and ordinary opening refreshes, but not over an already executing final broker write. Before Preview it reserves the strategy's single refill slot, so simultaneous activity and full-snapshot observations of the same fill cannot submit duplicate buys; a rejected refill is cooled down for 30 seconds. The fixed-price fill path is independent of the exploration mode's ten-second pairing window: during a running bot it accepts every newly confirmed in-range fill, while a fresh start recovers only fills from the preceding 60 seconds and ignores older lookback history. Consumed fill IDs are persisted in `.state/fixed-price-cycle.json`, so a hot switch cannot repeat an already handled fill. The independent exit worker and its sell-first priority remain active.

While an `ACCT_ACTIVITY` wake-up is awaiting its REST fill confirmation, and for five seconds after a confirmed refill is queued, ordinary low-priority opening refreshes may Preview but defer their final broker write. This leaves the serial write gate available for the newly confirmed refill without stopping normal refreshes when there is no fill activity.

固定价刷新在每轮起始及刷新进行中的完整订单确认后，直接按当下订单状态重算有效策略集合，不依赖上一次结果的增量推断。行权价完整位于 `--strike-min` 至 `--strike-max` 内的新工作买单会加入正在进行的刷新轮；已经取消、替换或不再是该策略当前工作买单的订单，会在写入前跳过。卖出 worker 使用相同范围：当前订单确认时会立即为新发现的可卖策略建立独立 worker，但不会重置已存在策略自己的卖单刷新计时器；没有仓位的已取消策略不会继续被调度。

### 独立卖出触发与流动性处理

每个 0DTE 垂直组合都有独立、持久化的卖出评估 worker，不会被其他组合的卖出动作阻塞。每次 worker 唤醒都会先用新鲜的持仓快照核对该组合可平数量；账户级持仓读取最多在 1 秒内合并一次，不会改变各组的独立触发与写入决策。倒计时只从 Schwab 确认的开仓 `FILLED` 订单的 `closeTime` 开始；发现仓位、工作买单或缺少确认成交时间均不会启动 30 秒倒计时。该组最后一次完整买入成交会重置 30 秒空窗倒计时；连续 30 秒没有新的买入成交且有仓位时，worker 挂一张数量等于全部可平仓仓位的卖单。某组合可平仓仓位达到 5 张时不等待倒计时，立即触发全仓卖出。每组同时最多保留一张活动卖单，且每次刷新都会把数量替换为最新可平仓仓位。

卖单价格固定为 0.99。正常刷新间隔为 8 秒，每个策略由自己的定时器维持；全局 5 秒发现循环只创建新 worker，绝不会重置已有策略的刷新或重试时间。卖出 Replace、无工作卖单的 Submit、以及老卖单取消后重建，在真正 Preview 前都会用统一的账户级持仓快照重算可平数量；同一秒内所有策略和排队写入共用一次持仓 REST 读取，而不是每张卖单额外请求。卖出提交在入队、必要的完整订单对账之后、以及真正 Preview 前都会重新确认该策略没有工作卖单；同一策略的提交任务也只能单飞，因此延迟 REST 快照或旧队列任务不会创建重复卖单。若 Schwab Preview 拒绝同一卖单更新，程序会冷却该精确 Replace 并记入 `exit.preview-retry-deferred`，避免反复无效 Preview 耗尽配额；但每张已工作至少 90 秒的卖单都有独立的 10 秒重建重试周期：取消→完整订单对账→共享持仓重算→Preview→新提交。不同策略可并发准备，最终 broker 写入仍保持单串行以隔离未知写入结果。期间其他策略的卖单和新成交补买仍保持独立运行。程序会保存最近的组合模板至 `.state/exit-templates.json`，因此热切换后仍能为已有仓位恢复独立卖出 worker。

如果 Schwab 对新的买入 `Preview` 明确返回资金、现金或购买力不足，程序会暂停该组买入/买单刷新并先进入 15 秒流动性卖出倒计时；倒计时结束后以全仓卖单启动，并以 5 秒间隔强制刷新两轮，随后恢复正常 8 秒节奏。卖出写入优先于买入和买单刷新。该触发及每轮结果会写入执行审计日志中的 `exit.liquidity-*`、`exit.worker-*` 与 `exit.gate` 事件。

### 执行审计日志与受控热切换

每次启动都会创建独立、追加写入的 JSONL 审计文件：`.state/executions/<UTC日期>/<runId>.jsonl`。每行均包含 UTC 时间、`runId`、事件类型和结构化数据；不会写入 token 或账户 hash。日志覆盖订单首次发现及状态/成交数量变化、Schwab 的成交时间、订单腿与价格、Preview、最终 Submit/Replace/Cancel、未知写入结果、探索器成交分桶、代际触发、已排队的下一步动作、动作执行/跳过原因，以及运行启动、控制停止和退出。

终端默认只显示启动/停止、安全告警、失败及业务动作；固定价成功换单显示为 `2026-07-29 22:40:04 刷新 SPY 745/746 Put Replace 0.90`。`ACCT_ACTIVITY` 唤醒、完整订单快照和零成交确认属于内部诊断，继续写入 JSONL 审计文件但不输出到终端。禁卖单模式不会维护 `.state/exit-templates.json`。

当前运行实例及其日志路径记录在 `.state/runtime/active-run.json`。查看当前实例和实时分析日志：

```powershell
Get-Content .\.state\runtime\active-run.json -Raw | ConvertFrom-Json
Get-Content .\.state\executions\<日期>\<runId>.jsonl -Wait
```

同一个工作目录一次只允许一个 bot 实例（包括只读模式）。启动时会原子创建 `.state/runtime/active-run.lock`；若锁的所属 PID 仍在运行，新实例会以 `RUNTIME_INSTANCE_ACTIVE` 失败并且不会覆盖 `active-run.json`、策略状态或审计上下文。异常退出留下的锁仅在所属 PID 已不存在时才会自动回收；无法验证锁的内容时保持失败关闭。

热切换仅用于已完成验证并合并到 `main`、且当前工作目录已快进到该 `main` 的更新。脚本会向旧进程发送受控停止请求；旧进程停止接收新的动作、持久化探索状态并等待已经进入串行写入队列的请求完成后才退出。确认旧 PID 退出后，脚本以原来的 Node 路径和启动参数启动当前 `main` 版本；若旧进程未在超时内退出，脚本失败且绝不启动第二个交易进程。

```powershell
.\scripts\hot-switch.ps1
```

如只需暂停且不重启：

```powershell
.\scripts\hot-switch.ps1 -StopOnly
```

首次使用热切换前，必须先用本版本启动一次 bot，让它写入 `.state/runtime/active-run.json`。更新操作的安全顺序固定为：在独立 worktree 修改与测试 → 创建并合并 PR 到 `main` → 主工作目录快进到远程 `main` 并再次验证 → 运行热切换脚本。这样新进程始终运行已合并的主线代码。

### 资金不足后的回补恢复

探索买单在 Schwab `Preview` 明确返回资金、现金或购买力不足时，不会再被当作完成并永久消费。该逻辑订单会保留在探索状态中，15 秒后节流重试；资金恢复后无需等待新的成交事件即可继续提交。启动、热切换或旧版本留下的“未成交且没有 broker order ID”的逻辑买单，也会在下一次独立刷新轮按现有三张上限恢复为 `ensure` 动作。审计日志使用 `explorer.action.deferred-for-funding` 记录延迟原因与下一次重试时间。

## 验证

For a working 0.99 exit whose price, quantity, and remaining quantity already
match the strategy target, the bot records `exit.refresh-noop` instead of
sending an identical Replace that Schwab rejects.  It still replaces an exit
when any of those values differs.

Working opening orders continue to use native Schwab Replace and are never
canceled by maintenance. Each closing order that remains working for at least
90 seconds has its own 10-second guarded recreate retry: cancel (even while a
periodic order refresh is running), full REST
reconciliation, verify no working order remains for that strategy, then Preview
and submit. Eligible exits prepare concurrently, but the final broker write
remains serialized for UNKNOWN-result safety. Working opening orders are never
canceled by this maintenance path.

```powershell
npm run check
npm test
```

测试覆盖 SDK 传输整合的关键边界：保留 Schwab 写入响应的 `Location` 订单 ID、失败请求绝不由 SDK 隐式重试、执行窗口与周重登录边界。
