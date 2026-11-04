import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Access } from "../../worker/agents.ts";

export function binary() {
  const roots = [path.join(homedir(), "Applications"), "/Applications"];
  for (const root of roots)
    for (const name of ["ChatGPT.app", "Codex.app"]) {
      for (const tail of [
        "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "Contents/Resources/codex",
      ]) {
        const file = path.join(root, name, tail);
        if (existsSync(file)) return file;
      }
    }
  const found = execFileSync(process.env.SHELL ?? "/bin/sh", ["-lc", "command -v codex"], {
    encoding: "utf8",
    timeout: 5000,
  })
    .trim()
    .split("\n")
    .at(-1);
  if (!found || !existsSync(found)) throw new Error("找不到 Codex 程序，请先安装桌面应用");
  return found;
}
export async function catalog<T = any>(method: string, params: any): Promise<T> {
  if (!["thread/start", "thread/list", "thread/read", "thread/name/set"].includes(method))
    throw new Error("不支持的会话资料操作");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CODEX_") && key !== "CODEX_HOME") delete env[key];
  const proc = spawn(binary(), ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], env });
  let buffer = "";
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let bytes = 0;
  const fail = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  const timer = setTimeout(() => {
    fail(new Error("读取桌面会话资料超时"));
    proc.kill("SIGTERM");
  }, 15000);
  proc.on("error", fail);
  proc.on("exit", () => fail(new Error("Codex 会话资料接口已关闭")));
  proc.stderr.on("data", () => {});
  proc.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) {
      fail(new Error("会话资料超过8MiB"));
      proc.kill("SIGTERM");
      return;
    }
    buffer += chunk;
    for (;;) {
      const n = buffer.indexOf("\n");
      if (n < 0) break;
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      try {
        const m = JSON.parse(line),
          p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.error) p.reject(new Error(String(m.error.message).slice(0, 300)));
          else p.resolve(m.result);
        }
      } catch {}
    }
  });
  const call = (method: string, params: any) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    await call("initialize", {
      clientInfo: { name: "agent-autoloop-desktop", version: "1" },
      capabilities: { experimentalApi: true },
    });
    proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const result = await call(method, params);
    if (method === "thread/start") {
      // An empty app-server thread is not durable. Persist a host marker without
      // starting inference, then let the desktop own every actual task turn.
      await call("thread/inject_items", {
        threadId: result.thread.id,
        items: [
          {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: "这是由 AutoLoop 创建的桌面任务会话，实际需求由后续受信规则提交。当前尚未开始执行任何业务任务。",
              },
            ],
          },
        ],
      });
      await call("thread/name/set", { threadId: result.thread.id, name: "AutoLoop 桌面任务" });
    }
    return result;
  } finally {
    clearTimeout(timer);
    proc.stdin.end();
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
export async function newThread(cwd: string, access: Access) {
  return catalog("thread/start", {
    cwd,
    historyMode: "paginated",
    ephemeral: false,
    sandbox: access === "read" ? "read-only" : access === "edit" ? "workspace-write" : "danger-full-access",
    approvalPolicy: "never",
    serviceName: "agent-autoloop-desktop",
  });
}
export function openThread(id: string) {
  if (!/^[a-f\d-]{36}$/i.test(id)) return Promise.reject(new Error("桌面会话编号不符"));
  return new Promise<void>((resolve, reject) =>
    execFile("open", ["-g", `codex://threads/${id}`], { timeout: 5000 }, (e) =>
      e ? reject(new Error("无法打开桌面 Codex 会话")) : resolve(),
    ),
  );
}
