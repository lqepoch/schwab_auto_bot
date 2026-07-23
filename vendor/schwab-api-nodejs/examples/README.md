# 示例脚本

本目录包含若干可执行的 TypeScript 示例，帮助快速验证 SDK：

- `authorize-and-refresh.ts`：首次授权或刷新访问令牌。首次运行打印 OAuth 授权链接，随后使用回调 code 换取令牌。
- `fetch-quotes.ts`：调用 Market Data REST API 查询批量行情，默认 `AAPL,QQQ`，可通过命令行传入自定义代码。
- `download-price-history.ts`：下载指定标的的历史价格数据，默认拉取 AAPL 的最近 10 天 5 分钟蜡烛。
- `stream-levelone.ts`：建立 Streamer 连接并订阅 Level 1 股票行情，演示事件监听与主动断开。
- `stream-account-activity.ts`：自动获取首个账户并订阅账户活动推送，实时打印服务器通知。

在运行脚本前，请在根目录创建 `.env` 并设置以下变量：

```
SCHWAB_CLIENT_ID=<应用 Client ID>
SCHWAB_CLIENT_SECRET=<应用 Client Secret>
SCHWAB_REDIRECT_URI=<OAuth 回调地址>
SCHWAB_TOKEN_PATH=.schwab_tokens.json # 可选，默认当前工作目录
```

随后执行以下命令完成初始化：

```bash
npm install
npm run setup    # 交互式生成 .env 文件
npm run build
```

示例脚本可直接通过 `tsx` 运行，无需手动编译：

```bash
npm run example:authorize -- --open
npm run example:quotes -- TSLA,MSFT
npm run example:history -- AAPL 20
npm run example:stream -- QQQ,SPY
npm run example:account-stream
```

其中 `--open` 参数用于自动打开浏览器授权；若在没有图形界面的环境执行，可去掉该标记并手动访问脚本打印的 URL。

如需在构建产物上运行，可参考 `README.md` 中的命令示例。
