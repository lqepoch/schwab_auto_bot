import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginLogin, login, status } from "./auth.ts";

function openBrowser(url: string): void {
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

type CallbackInput = NodeJS.ReadableStream & { unref?: () => void };

export async function readCallbackUrl(
  input: CallbackInput = process.stdin,
  output: Pick<NodeJS.WritableStream, "write"> = process.stdout,
): Promise<string> {
  output.write("粘贴完整回调 URL 后按 Enter: ");
  return new Promise((resolveCallback, reject) => {
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("error", onError);
    };
    const onData = (data: Buffer | string): void => {
      cleanup();
      input.pause();
      input.unref?.();
      resolveCallback(data.toString().trim());
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    input.once("data", onData);
    input.once("error", onError);
    input.resume();
  });
}

export async function runAuthCli(argv = process.argv): Promise<void> {
  const command = argv[2] || "status";
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await status())}\n`);
  } else if (command === "login" || command === "relogin") {
    if (command === "relogin" && (argv[3] !== "--confirm" || argv[4] !== "REAUTHORIZE_SCHWAB")) {
      throw new Error("重登录必须传入 --confirm REAUTHORIZE_SCHWAB");
    }
    const { state, authorizationUrl } = beginLogin();
    openBrowser(authorizationUrl);
    await login(await readCallbackUrl(), state);
    process.stdout.write("登录完成；Token 已写入本机 state/schwab-auth.json。\n");
  } else {
    throw new Error("用法: node src/auth_cli.ts [status|login|relogin --confirm REAUTHORIZE_SCHWAB]");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runAuthCli();
}
