import open from "open";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginLogin, login, status } from "./provider.ts";

async function openBrowser(url: string): Promise<void> {
  await open(url);
}

type CallbackInput = NodeJS.ReadableStream & { unref?: () => void };

export type InteractiveLoginDependencies = {
  beginLogin?: typeof beginLogin;
  login?: typeof login;
  openBrowser?: (url: string) => void | Promise<void>;
  readCallbackUrl?: () => Promise<string>;
  output?: Pick<NodeJS.WritableStream, "write">;
};

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

export async function runInteractiveLogin({
  beginLogin: startLogin = beginLogin,
  login: completeLogin = login,
  openBrowser: launchBrowser = openBrowser,
  readCallbackUrl: readCallback = readCallbackUrl,
  output = process.stdout,
}: InteractiveLoginDependencies = {}): Promise<void> {
  const { state, authorizationUrl } = startLogin();
  // Always show the one-time authorization URL. Headless Linux, SSH sessions,
  // containers and locked-down desktops may have no usable GUI opener even
  // when the process itself is otherwise fully functional.
  output.write(`OAuth 授权地址: ${authorizationUrl}\n`);
  try {
    await launchBrowser(authorizationUrl);
    output.write("已尝试使用系统默认浏览器打开 OAuth 授权页。\n");
  } catch {
    output.write("自动打开浏览器失败；请手动打开上面的 OAuth 授权地址。\n");
  }
  output.write("完成授权后，请将完整回调 URL 粘贴到此终端。\n");
  await completeLogin(await readCallback(), state);
  output.write("登录完成；Token 已写入本机 state/schwab-auth.json。\n");
}

export async function runAuthCli(argv = process.argv): Promise<void> {
  const command = argv[2] || "status";
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await status())}\n`);
  } else if (command === "login" || command === "relogin") {
    if (command === "relogin" && (argv[3] !== "--confirm" || argv[4] !== "REAUTHORIZE_SCHWAB")) {
      throw new Error("重登录必须传入 --confirm REAUTHORIZE_SCHWAB");
    }
    await runInteractiveLogin();
  } else {
    throw new Error("用法: node src/automation/auth/cli.ts [status|login|relogin --confirm REAUTHORIZE_SCHWAB]");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runAuthCli();
}
