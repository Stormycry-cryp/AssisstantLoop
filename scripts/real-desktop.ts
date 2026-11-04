// Real desktop acceptance is opt-in. Keep one bounded temporary home; do not
// remove journals while a desktop turn could still be alive.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { threadOf } from "../plugins/codex-desktop/session.ts";
const [thread, cwd, flag] = process.argv.slice(2);
assert.equal(flag, "--run", "用法：node scripts/real-desktop.ts <专用桌面会话> <目录> --run");
threadOf(thread);
const home = join(tmpdir(), "agent-autoloop-desktop-check");
assert.ok(!existsSync(home), "上次验收目录仍在，请先核实其中桌面任务是否结束");
mkdirSync(home, { mode: 0o700 });
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    sources: { test: { name: "桌面验收" } },
    channels: {},
    agents: {
      desktop: {
        name: "桌面验收",
        worker: "test",
        use: "codex-desktop",
        command: ["thread", thread],
        access: "edit",
        timeout: 3,
        effort: "low",
      },
    },
    rules: [
      {
        name: "桌面验收",
        when: { source: "test", types: ["check"] },
        to: "desktop",
        cwd,
        prompt: "这是只读接入验收，不调用工具，不写文件，不联网。只回复“桌面纳管通过”",
        tell: "never",
      },
      {
        name: "停止验收",
        when: { source: "test", types: ["cancel"] },
        to: "desktop",
        cwd,
        prompt: "这是取消验收。在可信工作目录运行 sleep 20，不写文件，不联网，等待该命令结束后只回复“等待完成”",
        tell: "never",
      },
    ],
  }),
  { mode: 0o600 },
);
const hub = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");
const server = serve(0);
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const owner = hubClient(url, hub.addKey("owner", "me")),
  source = hubClient(url, hub.addKey("source", "test"));
const worker = createWorker({ hub: hubClient(url, hub.addKey("worker", "test")), name: "test", wait: 0, capacity: 1 });
const deadline = Date.now() + 240000;
async function until(test: (s: any) => boolean) {
  while (Date.now() < deadline) {
    await worker.tick();
    const state = await owner.state();
    if (state.runs.some((r: any) => r.state === "failed")) throw new Error("桌面执行失败");
    if (test(state)) return state;
    await delay(200);
  }
  throw new Error("桌面验收超时，保留执行记录");
}
try {
  await source.event({ id: "one", type: "check", subject: "acceptance" });
  let state = await until((s) => s.runs.filter((r: any) => r.state === "done").length === 1);
  await source.event({ id: "two", type: "check", subject: "acceptance" });
  state = await until((s) => s.runs.filter((r: any) => r.state === "done").length === 2);
  const runs = state.runs;
  assert.equal(runs[0].session, runs[1].session);
  assert.ok(runs.every((r: any) => r.summary === "桌面纳管通过"));
  await source.event({ id: "stop", type: "cancel", subject: "cancellation" });
  await until(() =>
    worker.entries().some((e) => {
      const p = join(e.dir, "desktop-state.json");
      return existsSync(p) && JSON.parse(readFileSync(p, "utf8")).phase === "running";
    }),
  );
  const run = worker.entries()[0].run;
  await owner.cancel(run);
  state = await until((s) => s.runs.find((r: any) => r.id === run)?.state === "cancelled");
  assert.equal(worker.entries().length, 0);
  console.log(
    JSON.stringify({
      desktop: true,
      runs: state.runs.map((r: any) => ({ id: r.id, state: r.state, summary: r.summary })),
      resumed: true,
      confirmedStop: true,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  hub.db.close();
  if (!worker.entries().length) rmSync(home, { recursive: true, force: true });
  else console.error(`验收未完成，保留受保护执行记录：${home}`);
}
