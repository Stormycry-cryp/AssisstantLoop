// Natural replies must stay attached to the shown question/task, while interpretation stays
// separate from authority. A replay must reuse its committed decision, not ask the model twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge, blankState, renderCard, type Card } from "../plugins/weixin/bridge.ts";
import { makeSnapshot, parseDecision, type Decision } from "../plugins/weixin/conversation.ts";
import { Frontdesk, contextFor } from "../plugins/weixin/frontdesk.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup as setupHome } from "./helpers.ts";

const account = { token: "private-token", owner: "owner", account: "bot", base: "https://ilinkai.weixin.qq.com" };
const card: Card & { rule: string; createdAt: string } = {
  id: 7,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "选一个颜色",
  text: "想用蓝色还是绿色？",
  options: ["蓝色", "绿色"],
  result: null,
  rule: "微信 Codex 任务",
  createdAt: "2026-11-04T00:00:00.000Z",
};
const action = (kind: string, over: object = {}) => ({
  kind,
  card: null,
  choice: null,
  run: null,
  agent: null,
  subject: null,
  title: null,
  ...over,
});
const message = (text: string, id = "one") => ({
  from_user_id: "owner",
  message_type: 1,
  message_id: id,
  context_token: "private-context",
  item_list: [{ type: 1, text_item: { text } }],
});
function fixture(plan: Decision) {
  const state = blankState();
  state.deliveries["7"] = { ref: "original-ref", version: 1, state: "open" };
  const view: any = {
    totals: { running: 0, queued: 0, doneToday: 0 },
    cards: [card],
    recentCards: [],
    runs: [
      {
        id: 8,
        rule: "微信 Codex 任务",
        agent: "codex",
        state: "done",
        summary: "等你选颜色",
        events: [{ source: "weixin", subject: "wx-color", type: "task.codex", summary: "选择颜色" }],
      },
    ],
  };
  const answers: any[] = [],
    events: any[] = [],
    sent: string[] = [];
  let interpretations = 0;
  const deps = {
    source: {
      async event(value: any) {
        events.push(value);
        return { routed: ["微信 Codex 任务"] };
      },
    },
    owner: {
      async state() {
        return view;
      },
      async cancel() {
        return {};
      },
    },
    channel: {
      async answer(id: number, value: any) {
        answers.push({ id, ...value });
        return { changed: true };
      },
      async delivered() {},
      async failed() {},
    },
    async send(text: string) {
      sent.push(text);
    },
    save() {},
    async interpret(_input: any) {
      interpretations++;
      return plan;
    },
  };
  const bridge = new Bridge(account, state, deps);
  return { bridge, state, view, deps, sent, events, answers, interpretations: () => interpretations };
}

test("Wechat conversation: rendered questions invite ordinary replies without card numbers or command syntax", () => {
  const text = renderCard(card);
  assert.match(text, /蓝色.*绿色|蓝色[\s\S]*绿色/);
  assert.doesNotMatch(text, /回答 7|#7|回复.*[序编]号/);
});

test("Wechat desktop: only a registered desktop executor can receive an explicit request", async () => {
  const f = fixture({
    reply: "我交给桌面里的 Codex",
    actions: [action("start", { agent: "desktop", title: "桌面检查" }) as any],
  });
  f.view.agents = [{ id: "codex-desktop", use: "codex-desktop" }];
  await f.bridge.inbound(message("让桌面 Codex 看一下这份资料"));
  assert.equal(f.events[0]?.type, "task.desktop");
  assert.equal(f.events[0]?.detail, "让桌面 Codex 看一下这份资料");
  const unconfigured = fixture({ reply: "", actions: [] });
  const snap = makeSnapshot("让桌面处理", unconfigured.state, unconfigured.view);
  assert.throws(() =>
    parseDecision({ reply: "好", actions: [action("start", { agent: "desktop", title: "桌面检查" })] }, snap),
  );
});

test("Wechat conversation: executor recommendations are visible and remain available to the next reply", () => {
  const f = fixture({ reply: "", actions: [] });
  f.view.cards = [{ ...card, recommend: 1 }];
  assert.match(renderCard(f.view.cards[0]), /我建议：绿色/);
  assert.equal(makeSnapshot("按你建议的", f.state, f.view).questions[0].recommend, 1);
});

test("Wechat conversation: natural approval preserves the exact words and the original delivery reference", async () => {
  const f = fixture({ reply: "好，就用绿色，其他地方保持不动。", actions: [action("answer", { card: 7 }) as any] });
  await f.bridge.inbound(message("那就绿色吧，其他地方不动"));
  assert.deepEqual(f.answers, [{ id: 7, text: "那就绿色吧，其他地方不动", by: "owner", ref: "original-ref" }]);
  assert.equal(f.events.length, 0);
  assert.equal(f.interpretations(), 1);
  assert.ok(f.state.dialogue?.history.some((item) => item.text.includes("其他地方不动")));
});

test("Wechat conversation: thanks and clarification do not become business tasks or approvals", async () => {
  const f = fixture({ reply: "不客气，我在。", actions: [] });
  await f.bridge.inbound(message("谢谢啦"));
  assert.equal(f.events.length, 0);
  assert.equal(f.answers.length, 0);
  assert.equal(f.sent.at(-1), "不客气，我在");
});

test("Wechat conversation: a follow-up uses the existing task and passes the untouched request", async () => {
  const f = fixture({
    reply: "好，我接着调整刚才那一版。",
    actions: [action("followup", { subject: "wx-color", agent: "codex" }) as any],
  });
  await f.bridge.inbound(message("刚才那个再圆一点，别改颜色"));
  assert.equal(f.events[0].subject, "wx-color");
  assert.equal(f.events[0].type, "task.codex");
  assert.equal(f.events[0].detail, "刚才那个再圆一点，别改颜色");
});

test("Wechat conversation: replay reuses a frozen decision after a lost reply without repeating the model", async () => {
  const f = fixture({
    reply: "我来整理这份资料。",
    actions: [action("start", { agent: "codex", title: "整理资料" }) as any],
  });
  let broken = true;
  f.deps.send = async (text) => {
    if (broken) throw new Error("reply disconnected");
    f.sent.push(text);
  };
  await assert.rejects(f.bridge.inbound(message("帮我整理资料")));
  broken = false;
  await f.bridge.inbound(message("帮我整理资料"));
  assert.equal(f.interpretations(), 1);
  assert.equal(f.events.length, 1);
});

test("Wechat conversation: unseen cards, unrelated tasks, unsupported agents and invented permissions are refused", () => {
  const f = fixture({ reply: "", actions: [] });
  const snapshot = makeSnapshot("继续", f.state, f.view);
  for (const invalid of [
    action("answer", { card: 99 }),
    action("followup", { subject: "other-task", agent: "codex" }),
    action("start", { agent: "pi", title: "猜测用户想用 Opus" }),
    { ...action("start", { agent: "codex", title: "工作" }), cwd: "/private" },
  ])
    assert.throws(() => parseDecision({ reply: "好", actions: [invalid] }, snapshot));
  assert.ok(!JSON.stringify(snapshot).includes("private-context"));
  assert.ok(!JSON.stringify(snapshot).includes("original-ref"));
});

test("Wechat conversation: a question closed during interpretation cannot be answered again", async () => {
  const f = fixture({ reply: "好", actions: [action("answer", { card: 7 }) as any] });
  f.deps.interpret = async () => {
    f.view.cards = [];
    return { reply: "好", actions: [action("answer", { card: 7 }) as any] };
  };
  await f.bridge.inbound(message("绿色吧"));
  assert.equal(f.answers.length, 0);
  assert.match(f.sent.at(-1)!, /已经|刚刚/);
});

test("Wechat conversation: the host delivers original text as tool data without a preliminary model tool call", () => {
  const f = fixture({ reply: "", actions: [] });
  const snapshot = makeSnapshot("绿色吧", f.state, f.view);
  const context = contextFor(snapshot);
  assert.deepEqual(context.tools, []);
  assert.ok(!context.systemPrompt.includes("绿色吧"));
  const supplied: any = context.messages.at(-1);
  assert.deepEqual(JSON.parse(supplied.content[0].text), snapshot);
  assert.equal(supplied.role, "toolResult");
  assert.throws(() => contextFor({ ...snapshot, message: "x".repeat(129 * 1024) }));
});

test("Wechat conversation: an independent Pi runtime is reused with low reasoning and no execution tools", async () => {
  let loads = 0;
  const seen: any[] = [];
  const frontdesk = new Frontdesk({
    load: async () => {
      loads++;
      return {
        model: { id: "deepseek-v4.1-flash" },
        complete: async (context: any, options: any) => {
          seen.push({ context, options });
          return { stopReason: "stop", content: [{ type: "text", text: '{"reply":"在，你说。","actions":[]}' }] };
        },
      };
    },
  });
  try {
    const f = fixture({ reply: "", actions: [] });
    for (const message of ["在不", "谢谢"])
      assert.equal((await frontdesk.interpret(makeSnapshot(message, f.state, f.view))).reply, "在，你说。");
    assert.equal(loads, 1);
    for (const { context, options } of seen) {
      assert.equal(options.reasoning, "low");
      assert.deepEqual(context.tools, []);
      assert.equal(context.messages.length, 3);
      assert.ok(options.maxTokens <= 2048);
    }
  } finally {
    await frontdesk.close();
  }
});

test("Wechat conversation: Pi failures, truncation and tool calls cannot masquerade as a completed reply", async () => {
  const f = fixture({ reply: "", actions: [] });
  for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
    const desk = new Frontdesk({
      load: async () => ({
        model: { id: "deepseek-v4.1-flash" },
        complete: async () => ({ stopReason, content: [{ type: "text", text: '{"reply":"已完成","actions":[]}' }] }),
      }),
    });
    try {
      await assert.rejects(desk.interpret(makeSnapshot("继续", f.state, f.view)), /尚未执行/);
    } finally {
      await desk.close();
    }
  }
});

test("Wechat conversation: real hub resumes natural answers with qualifiers and sends one final result", async () => {
  const home = mkdtempSync(join(tmpdir(), "weixin-natural-core-"));
  const rules = join(home, "rules.json");
  writeFileSync(
    rules,
    JSON.stringify({
      sources: { weixin: { name: "微信本人" } },
      agents: { codex: { name: "Codex", worker: "test", use: "command", command: ["echo", "unused"] } },
      channels: { weixin: { name: "微信", answerers: ["owner"] } },
      rules: [
        {
          name: "微信任务",
          when: { source: "weixin", types: ["task.codex"] },
          to: "codex",
          cwd: home,
          prompt: "处理资料中的任务",
          tell: "always",
          parallel: 1,
        },
      ],
      elsewhere: [],
    }),
  );
  setupHome("weixin-natural", rules);
  const runtime = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const server = serve(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = (kind: "source" | "channel" | "owner" | "worker", name: string) =>
    hubClient(url, runtime.addKey(kind, name));
  const source = client("source", "weixin"),
    channel = client("channel", "weixin"),
    owner = client("owner", "owner"),
    worker = client("worker", "test");
  const state = blankState();
  const sent: string[] = [];
  const bridge = new Bridge(account, state, {
    source,
    channel,
    owner,
    send: async (text) => {
      sent.push(text);
    },
    save() {},
    interpret: async (snapshot) =>
      snapshot.questions.length
        ? {
            reply: "好，蓝色，布局保持原样。",
            actions: [action("answer", { card: snapshot.questions[0].id, choice: 0 }) as any],
          }
        : { reply: "我来处理这张卡片。", actions: [action("start", { agent: "codex", title: "制作卡片" }) as any] },
  });
  const drain = async () => {
    for (let i = 0; i < 6; i++) {
      const { card } = await channel.nextCard(0);
      if (!card) return;
      await bridge.deliver(card);
    }
    assert.fail("unexpected repeated delivery");
  };
  try {
    await bridge.inbound(message("帮我制作一张卡片"));
    const { job } = await worker.work({ claim: "first", wait: 0, running: [], capacity: true });
    await worker.result(job.run, job.token, {
      outcome: "done",
      session: "same-session",
      summary: "需要选择颜色",
      ask: [{ title: "卡片配色", text: "用蓝色还是绿色？", options: ["蓝色", "绿色"], key: "color" }],
    });
    await drain();
    assert.equal(sent.length, 2);
    await bridge.inbound(message("蓝色吧，但布局别改", "answer"));
    const { job: resumed } = await worker.work({ claim: "resume", wait: 0, running: [], capacity: true });
    assert.equal(resumed.session, "same-session");
    assert.equal(resumed.context.answers[0].choice, 0);
    assert.equal(resumed.context.answers[0].text, "蓝色吧，但布局别改");
    await drain();
    assert.equal(sent.length, 3);
    await worker.result(resumed.run, resumed.token, { outcome: "done", summary: "已完成蓝色卡片，保留原布局。" });
    await drain();
    assert.equal(sent.filter((text) => text.includes("已完成蓝色卡片")).length, 1);
    assert.equal(sent.length, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
