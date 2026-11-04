// Protects the owner's task entry from other senders, replayed messages, ambiguous answers,
// leaked credentials, lost delivery acknowledgments, and cursor advancement before acceptance.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bridge, blankState, renderCard, type Card } from "../plugins/weixin/bridge.ts";
import { api, loadJson, saveJson, trustedBase } from "../plugins/weixin/client.ts";
import { setup as setupHome } from "./helpers.ts";

const account = { token: "private-token", owner: "owner", account: "bot", base: "https://ilinkai.weixin.qq.com" };
const message = (text: string, id = "msg-1", from = "owner") => ({
  from_user_id: from,
  to_user_id: "bot",
  message_id: id,
  message_type: 1,
  context_token: "private-context",
  item_list: [{ type: 1, text_item: { text } }],
});
const card: Card = {
  id: 7,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "怎么处理",
  text: "请选择",
  options: ["继续", "取消"],
  result: null,
};
function setup() {
  const state = blankState();
  const events: any[] = [],
    answers: any[] = [],
    sent: any[] = [];
  const view = { cards: [card], runs: [], totals: { running: 0, queued: 0, doneToday: 0 } };
  const deps = {
    source: {
      async event(event: any) {
        events.push(event);
        return { routed: ["微信"] };
      },
    },
    owner: {
      async state() {
        return view;
      },
      async cancel(id: number) {
        return { id };
      },
    },
    channel: {
      async answer(id: number, body: any) {
        answers.push({ id, ...body });
        return { changed: true };
      },
      async delivered() {},
      async failed() {},
    },
    async send(text: string, id: string) {
      sent.push({ text, id });
    },
    save() {},
  };
  return { bridge: new Bridge(account, state, deps), state, deps, view, events, answers, sent };
}

test("Weixin: only the QR-bound owner can submit work or update the reply token", async () => {
  const f = setup();
  await f.bridge.inbound(message("删除所有文件", "foreign", "stranger"));
  assert.equal(f.events.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.context, "");
  await f.bridge.inbound(message("codex 整理资料"));
  assert.equal(f.events[0].type, "task.codex");
  assert.equal(f.events[0].detail, "整理资料");
  assert.ok(!("cwd" in f.events[0]));
  assert.equal(f.state.context, "private-context");
});

test("Weixin: replay does not create another task; unknown acceptance reuses the same native event ID", async () => {
  const f = setup();
  let fail = true;
  const original = f.deps.source.event;
  f.deps.source.event = async (value) => {
    const result = await original(value);
    if (fail) throw new Error("response lost");
    return result;
  };
  await assert.rejects(f.bridge.inbound(message("pi 画一张界面")));
  fail = false;
  await f.bridge.inbound(message("pi 画一张界面"));
  await f.bridge.inbound(message("pi 画一张界面"));
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0].id, f.events[1].id);
  assert.equal(f.events[1].type, "task.pi");
});

test("Weixin: answers carry the verified sender and original delivered reference", async () => {
  const f = setup();
  await f.bridge.deliver(card);
  await f.bridge.inbound(message("回答 7 2"));
  assert.deepEqual(f.answers, [{ id: 7, choice: 1, by: "owner", ref: "autoloop-card-7" }]);
  await f.bridge.inbound(message("回答 8 1", "m2"));
  assert.equal(f.answers.length, 1);
});

test("Weixin: a bare digit requires exactly one delivered open question", async () => {
  const f = setup();
  await f.bridge.deliver(card);
  f.view.cards.push({ ...card, id: 8 });
  await f.bridge.deliver({ ...card, id: 8 });
  await f.bridge.inbound(message("1"));
  assert.equal(f.answers.length, 0);
  assert.match(f.sent.at(-1).text, /回答.*编号/);
  f.view.cards.pop();
  await f.bridge.inbound(message("继续", "m2"));
  assert.equal(f.answers[0].choice, 0);
});

test("Weixin: a lost hub delivery acknowledgement does not resend a confirmed local delivery", async () => {
  const f = setup();
  let broken = true;
  f.deps.channel.delivered = async () => {
    if (broken) throw new Error("hub disconnected");
  };
  await assert.rejects(f.bridge.deliver(card));
  broken = false;
  await f.bridge.deliver(card);
  assert.equal(f.sent.length, 1);
  await f.bridge.deliver({ ...card, version: 2, ref: "autoloop-card-7", state: "done", result: "已执行" });
  assert.match(f.sent.at(-1).text, /已执行/);
});

test("Weixin: the long-poll cursor moves only after every message has been accepted", async () => {
  const f = setup();
  f.deps.source.event = async () => {
    throw new Error("hub disconnected");
  };
  await assert.rejects(f.bridge.batch({ get_updates_buf: "next", msgs: [message("做一件事")] }));
  assert.equal(f.state.cursor, "");
});

test("Weixin: new-task subjects are stable on replay and agents stay selected for follow-ups", async () => {
  const f = setup();
  await f.bridge.inbound(message("新任务 pi 设计页面"));
  await f.bridge.inbound(message("再改一下颜色", "m2"));
  assert.equal(f.events[1].type, "task.pi");
  assert.equal(f.events[0].subject, f.events[1].subject);
  await f.bridge.inbound(message("新任务 codex 检查代码", "m3"));
  assert.notEqual(f.events[0].subject, f.events[2].subject);
});

test("Weixin: callback controls do not come from quoted text or outgoing bot messages", async () => {
  const f = setup();
  await f.bridge.inbound({ ...message("停止 3"), message_type: 2 });
  await f.bridge.inbound({
    ...message("你好", "m2"),
    item_list: [{ type: 99, ref_msg: { message_item: { type: 1, text_item: { text: "回答 7 1" } } } }],
  });
  assert.equal(f.answers.length, 0);
  assert.equal(f.events.length, 0);
});

test("Weixin: private state is bounded, atomically replaceable, and no credentials appear in cards", () => {
  const root = mkdtempSync(join(tmpdir(), "autoloop-weixin-"));
  try {
    const file = join(root, "state.json");
    saveJson(file, blankState());
    assert.equal(loadJson(file).cursor, "");
    assert.throws(() => saveJson(file, { value: "x".repeat(300 * 1024) }), /上限/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).cursor, "");
    assert.match(renderCard(card), /蓝色|继续/);
    assert.doesNotMatch(renderCard(card), /回答 7 1/);
    assert.ok(!renderCard(card).includes("http://127"));
    for (const url of [
      "http://ilinkai.weixin.qq.com",
      "https://evil.test",
      "https://ilinkai.weixin.qq.com@evil.test",
      "https://ilinkai.weixin.qq.com:444",
    ])
      assert.throws(() => trustedBase(url));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Weixin: the transport uses the iLink token header, rejects API errors, and bounds responses", async () => {
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer private-token");
    assert.equal(req.headers.authorizationtype, "ilink_bot_token");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ errcode: -14, errmsg: "not included in the public error" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await assert.rejects(
      api({ ...account, base: `http://127.0.0.1:${address.port}` }, "getupdates", {}, undefined, true),
      /-14/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Weixin: 64-bit platform message IDs remain exact, so deduplication cannot merge adjacent messages", async () => {
  const server = createServer((_req, res) =>
    res.end('{"msgs":[{"message_id":9223372036854775806},{"message_id":9223372036854775807}]}'),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await api({ ...account, base: `http://127.0.0.1:${port}` }, "getupdates", {}, undefined, true);
    assert.deepEqual(
      result.msgs.map((m: any) => m.message_id),
      ["9223372036854775806", "9223372036854775807"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Weixin: real hub routes the message, verifies the answer, resumes the same session, and queues completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-weixin-core-"));
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
  setupHome("weixin-core", rules);
  const runtime = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const server = serve(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const key = (kind: "source" | "channel" | "owner" | "worker", name: string) => runtime.addKey(kind, name);
  const url = `http://127.0.0.1:${port}`;
  const source = hubClient(url, key("source", "weixin"));
  const channel = hubClient(url, key("channel", "weixin"));
  const owner = hubClient(url, key("owner", "owner"));
  const worker = hubClient(url, key("worker", "test"));
  const sent: string[] = [];
  const bridge = new Bridge(account, blankState(), {
    source,
    channel,
    owner,
    send: async (text) => {
      sent.push(text);
    },
    save() {},
  });
  try {
    await bridge.inbound(message("codex 给我一个选择"));
    const { job } = await worker.work({ claim: "first", wait: 0, running: [], capacity: true });
    assert.equal(job.context.events[0].detail, "给我一个选择");
    await worker.result(job.run, job.token, {
      outcome: "done",
      session: "original-session",
      summary: "提出了问题",
      ask: [{ title: "颜色", text: "选一个", options: ["蓝色", "绿色"], key: "color" }],
    });
    let asked: any;
    for (let i = 0; i < 3; i++) {
      const { card } = await channel.nextCard(0);
      if (!card) break;
      await bridge.deliver(card);
      if (card.kind === "ask") asked = card;
    }
    assert.ok(asked);
    await bridge.inbound(message(`回答 ${asked.id} 1`, "answer"));
    const resumed = (await worker.work({ claim: "second", wait: 0, running: [], capacity: true })).job;
    assert.equal(resumed.session, "original-session");
    assert.equal(resumed.context.answers[0].choice, 0);
    await worker.result(resumed.run, resumed.token, { outcome: "done", summary: "选了蓝色，完成" });
    for (let i = 0; i < 4; i++) {
      const { card } = await channel.nextCard(0);
      if (!card) break;
      await bridge.deliver(card);
    }
    assert.ok(sent.some((text) => text.includes("选了蓝色，完成")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
