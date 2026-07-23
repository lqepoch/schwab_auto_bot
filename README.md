# Schwab Auto Bot

Node.js 24 / TypeScript 常驻调度器，功能基线来自 `schwabdev-enterprise` 的
`1d761e6a43ab2ecfc0d92c49a0ffa30f6b5f9d8e`。订单快照、活动订阅、补买、卖出与 Replace
全部由 Node 直接调用 Schwab REST API；不依赖 Python、SQLite 或订单数据库。

首次只登录（会写入本机明文 `state/schwab-auth.json`，该目录被 Git 忽略）：

```powershell
$env:SCHWAB_APP_KEY = '...'
$env:SCHWAB_APP_SECRET = '...'
$env:SCHWAB_CALLBACK_URL = 'https://127.0.0.1'
npm run auth:login
```

```powershell
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
node .\node_vertical_cli\src\main.ts --confirm-live I_UNDERSTAND
```

只读取一次真实 Schwab 订单快照、绝不 Preview、Submit 或 Replace：

```powershell
node .\node_vertical_cli\src\main.ts --read-only --once
```

默认行为：

- 启动时只认领当前仍在工作的 QQQ/SPY 0DTE 买单，不把历史成交作为补买事件。
- 已认领买单的成交数量增加后，按原始限价立即补一张；同策略同价工作量达到 3 时刷新最旧买单。
- 两次完整对账之间，买卖成交直接更新进程内库存；约每 110 秒读取一次持仓并纠正内存状态。
- 启动时先处理全部可卖库存，卖出队列处理后才启动 SPY 755–795 整体刷新。
- SPY 755–795 每轮开头只读取一次完整订单快照，冻结候选后逐单 Preview + Replace，失败直接跳过；轮末最多等待 5 秒。
- 每个买单、卖单和整体刷新候选都是独立异步任务；Preview 可并行，最终券商写入统一串行。
- 所有 Node Schwab REST 请求共享每分钟 100 次硬上限；整体刷新到 95 次时先让路给成交补买和卖单。
- 约每 110 秒的纠偏只读取持仓，不重复读取完整订单；轻量成交轮询只查询最近 5 分钟，开轮完整快照保留 1 小时。
- 每 0.5 秒仅在本地分别检查每个策略的退出条件，不产生 REST 请求；各策略自己的最近买入成交过去 30 秒，或库存达到 5 时，以 0.99 卖出全部当前库存。
- 卖出评估前最多每 5 秒合并读取一次账户持仓，所有策略共享该快照；不会为每张卖单各自 GET，且可纠正成交事件造成的短暂内存偏差。
- 新建卖单前若完整订单快照超过 5 秒，所有策略共享刷新一次订单列表并重新判断，接管操作员手动挂出的卖单，避免重复卖出。
- 每个垂直策略只保留一个工作中卖单；已有卖单会被接管并按最大可卖库存更新，多余卖单被取消。
- 工作中卖单每 5 秒检查数量并 Replace，未挂成功的策略也各自按 5 秒冷却重试；任务真正执行前重新读取共享库存，同一次 Replace 同时刷新并扩量。
- 库存为零时取消残留卖单；库存数量不一致且原生 Replace 连续 3 次 Preview 失败时，取消旧单并由同一策略按最新完整库存重建唯一卖单。
- `.state/send-evidence.jsonl` 只是在真实发送前追加一条最小证据，不参与查询或调度。
