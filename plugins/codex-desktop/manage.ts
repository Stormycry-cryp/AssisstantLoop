import { homedir } from "node:os";
import path from "node:path";
import { catalog, openThread } from "./catalog.ts";
import { DesktopIPC } from "./ipc.ts";
import { pipe, threadOf } from "./session.ts";
import { busy } from "./protocol.ts";
import { loadJson, saveJson } from "./storage.ts";

const home = process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop");
const [command, id] = process.argv.slice(2);
try {
  if (command === "list") {
    const result = await catalog("thread/list", {
      limit: 20,
      sortKey: "updated_at",
      modelProviders: [],
      sourceKinds: ["appServer", "exec", "cli", "vscode"],
    });
    console.log(
      JSON.stringify(
        {
          threads: result.data.map((t: any) => ({
            id: t.id,
            title: t.name || t.preview?.slice(0, 80) || "未命名",
            cwd: t.cwd,
            status: t.status?.type,
          })),
          nextCursor: result.nextCursor,
        },
        null,
        2,
      ),
    );
  } else if (command === "attach" || command === "new") {
    const file = process.env.AGENT_AUTOLOOP_RULES ?? path.join(home, "rules.json"),
      rules = loadJson(file),
      agent = rules.agents?.["codex-desktop"];
    if (!agent || agent.use !== "codex-desktop") throw new Error("请先登记桌面执行者 codex-desktop");
    if (command === "new") {
      delete agent.command;
    } else {
      const thread = threadOf(id);
      await openThread(thread);
      const ipc = new DesktopIPC(pipe());
      try {
        await ipc.connect();
        await ipc.follow(thread);
        if (busy(ipc.state)) throw new Error("桌面会话仍在进行中，未接管或修改它");
        if (typeof ipc.state.cwd !== "string") throw new Error("未收到桌面工作目录");
        agent.command = ["thread", thread];
        for (const rule of rules.rules) if (rule.to === "codex-desktop") rule.cwd = ipc.state.cwd;
      } finally {
        ipc.close();
      }
    }
    // Rules are protected user configuration. Keep one explicit backup, never put it in source.
    saveJson(path.join(home, "codex-desktop-rules.previous.json"), loadJson(file));
    saveJson(file, rules);
    console.log(
      command === "attach" ? "已绑定选定桌面会话，后续桌面任务将在这里继续" : "已切回新建桌面会话，原聊天与记录均保留",
    );
  } else throw new Error("用法：node plugins/codex-desktop/manage.ts list | attach <会话编号> | new");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
