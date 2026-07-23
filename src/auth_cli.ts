import { spawn } from "node:child_process";
import { beginLogin, login, status } from "./auth.ts";

function openBrowser(url: string): void {
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

async function readLine(): Promise<string> {
  process.stdout.write("粘贴完整回调 URL 后按 Enter: ");
  return new Promise((resolve) => process.stdin.once("data", (data) => resolve(data.toString("utf8").trim())));
}

const command = process.argv[2] || "status";
if (command === "status") {
  process.stdout.write(`${JSON.stringify(await status())}\n`);
} else if (command === "login") {
  const { state, authorizationUrl } = beginLogin();
  openBrowser(authorizationUrl);
  await login(await readLine(), state);
  process.stdout.write("登录完成；Token 已写入本机 state/schwab-auth.json。\n");
} else {
  throw new Error("用法: node src/auth_cli.ts [status|login]");
}
