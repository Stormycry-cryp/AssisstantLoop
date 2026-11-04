import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { blocked, parseSession } from "./protocol.ts";
import type { BridgeInput } from "./runner.ts";

type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  access: "read" | "edit" | "full";
  model?: string;
  effort?: string;
  folder: string;
  contextFile: string;
  command?: string[];
};
type Reading = { session?: string; text?: string; finished?: boolean; error?: string };
const prefix = () => path.join(homedir(), ".local/share/opus-agent");

export default {
  command(turn: Turn) {
    if (turn.access !== "full") throw new Error("Pi 共享宿主只支持完整权限，规则必须明确设置 access: full");
    if (turn.command?.length) throw new Error("本机 Pi 适配器不接受替换命令，请使用已安装的共享入口");
    if (Buffer.byteLength(turn.prompt) > 256 * 1024) throw new Error("Pi 单轮提示词超过 256 KiB");
    // Attempts and a worker's fresh-session fallback must retain the same native input identity.
    const run = path.basename(turn.folder).replace(/-\d+$/, "");
    const requestId = `autoloop-${createHash("sha256")
      .update(JSON.stringify([path.dirname(turn.folder), run, turn.cwd, turn.prompt]))
      .digest("hex")}`;
    const input: BridgeInput = {
      prefix: prefix(),
      cwd: turn.cwd,
      prompt: turn.prompt,
      requestId,
      ...(turn.resume && { resume: turn.resume }),
      ...(turn.model && { model: turn.model }),
      ...(turn.effort && { effort: turn.effort }),
      contextFile: turn.contextFile,
    };
    mkdirSync(turn.folder, { recursive: true, mode: 0o700 });
    const file = path.join(turn.folder, "pi-ui-input.json");
    writeFileSync(`${file}.tmp`, `${JSON.stringify(input)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return [
      process.execPath,
      "--disable-warning=ExperimentalWarning",
      path.join(import.meta.dirname, "runner.ts"),
      file,
    ];
  },
  read(stdout: string, code: number | null, _stderr: string): Reading {
    const reading: Reading = {};
    for (const line of stdout.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.session) {
          parseSession(event.session);
          reading.session = event.session;
        }
        if (event.type === "result" && typeof event.text === "string" && event.text.trim()) {
          reading.text = event.text;
          reading.finished = true;
        }
      } catch {
        /* A growing output file can end in a partial line. */
      }
    }
    if (code !== null && !reading.text) {
      reading.text = blocked("Pi 接入进程中断，完成状态未知", `原会话：${reading.session ?? "尚未收到线程身份"}`);
      reading.finished = true;
    }
    return reading;
  },
  link(session: string) {
    // Before native ready, the worker briefly reports its own provisional UUID.
    if (/^[a-f\d-]{36}$/i.test(session)) return "http://127.0.0.1:3774/";
    return parseSession(session).url;
  },
  check() {
    try {
      const text = execFileSync(path.join(prefix(), "bin/opus-agent-ui"), ["models"], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 512 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const catalog = JSON.parse(text);
      if (
        !catalog.providers?.some(
          (provider: any) => provider.installed && provider.enabled && provider.auth?.status === "authenticated",
        )
      ) {
        return "Pi 宿主未就绪：先打开 Opus Agent App 并检查模型连接";
      }
      return null;
    } catch {
      return "连不上 Pi 共享宿主：先启动 Opus Agent App，再运行 opus-agent-ui models";
    }
  },
};
