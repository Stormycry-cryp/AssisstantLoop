import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Adapter } from "../../worker/agents.ts";
import { loadJson, saveJson } from "./storage.ts";
import { pipe, threadOf, session, inputFile, stateFile, readState, reconcile } from "./session.ts";

export default {
  command(turn) {
    if (Buffer.byteLength(turn.prompt) > 128 * 1024) throw new Error("桌面任务提示超过128KiB");
    if (turn.command?.length && (turn.command.length !== 2 || turn.command[0] !== "thread"))
      throw new Error("桌面接入只接受可信配置中绑定的会话");
    const binding = turn.command?.[1];
    if (binding) threadOf(binding);
    const resume = binding ?? (turn.resume ? threadOf(turn.resume) : null);
    mkdirSync(turn.folder, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256")
      .update(JSON.stringify([turn.prompt, resume, turn.cwd, turn.access, turn.model, turn.effort]))
      .digest("hex");
    const previous = readState(turn.folder);
    const old = existsSync(inputFile(turn.folder)) ? loadJson(inputFile(turn.folder)) : undefined;
    if (previous && old?.digest !== digest && previous.phase !== "done")
      throw new Error("原桌面任务尚未核实结束，不派第二次");
    const key = old?.digest === digest ? old.key : randomUUID();
    saveJson(inputFile(turn.folder), {
      prompt: turn.prompt,
      cwd: turn.cwd,
      access: turn.access,
      resume,
      key,
      digest,
      ...(turn.model && { model: turn.model }),
      ...(turn.effort && { effort: turn.effort }),
    });
    if (!previous || old?.digest !== digest) saveJson(stateFile(turn.folder), { phase: "prepared", key });
    return [
      process.execPath,
      "--disable-warning=ExperimentalWarning",
      path.join(import.meta.dirname, "runner.ts"),
      turn.folder,
    ];
  },
  read(stdout, code) {
    const reading: any = {};
    for (const line of stdout.split("\n"))
      try {
        const event = JSON.parse(line);
        if (event.session) reading.session = session(threadOf(event.session));
        if (event.type === "result" && event.text?.trim())
          Object.assign(reading, { text: event.text, finished: true, ...(event.usage && { usage: event.usage }) });
      } catch {}
    if (code !== null && !reading.text) reading.error = "桌面转接已退出，等待桌面端核实实际状态";
    return reading;
  },
  link(value) {
    try {
      return `codex://threads/${threadOf(value)}`;
    } catch {
      return "codex://";
    }
  },
  check() {
    return process.platform !== "darwin"
      ? "当前桌面接入已验收macOS，其他系统尚未适配"
      : existsSync(pipe())
        ? null
        : "先打开桌面 Codex，再连接 AutoLoop";
  },
  reconcile,
} satisfies Adapter;
