// Persona changes must not rewrite requests, lose personal context on history rotation,
// or turn a once-per-night sleep nudge into a repeated interruption after restart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge, blankState } from "../plugins/weixin/bridge.ts";
import { makeSnapshot } from "../plugins/weixin/conversation.ts";
import { formatReply } from "../plugins/weixin/personality.ts";

test("Assistant: plain short lines without headings, bullets, full stops or extra emoji", () => {
  const text = formatReply("## 已处理。\n- **结果正常**。\n" + "一".repeat(65) + "🙂🙂");
  assert.doesNotMatch(text, /[。#*]|^- /m);
  assert.ok(text.split("\n").every((line) => Array.from(line).length <= 30));
  assert.equal((text.match(/🙂/gu) ?? []).length, 1);
  assert.ok(text.includes("结果正常"));
});

function setup(plan: any) {
  const state = blankState();
  const sent: string[] = [],
    events: any[] = [];
  const deps = {
    now: () => Date.parse("2026-11-04T15:30:00Z"),
    owner: { state: async () => ({ cards: [], runs: [], totals: {} }), cancel: async () => ({}) },
    source: {
      event: async (value: any) => {
        events.push(value);
        return { routed: ["微信"] };
      },
    },
    channel: { answer: async () => ({}), delivered: async () => {}, failed: async () => {} },
    send: async (text: string) => {
      sent.push(text);
    },
    save() {},
    interpret: async () => plan,
  };
  return {
    state,
    deps,
    sent,
    events,
    bridge: new Bridge(
      { token: "fake", owner: "owner", account: "bot", base: "https://ilinkai.weixin.qq.com" },
      state,
      deps,
    ),
  };
}
const message = (text: string, id: string) => ({
  from_user_id: "owner",
  message_type: 1,
  message_id: id,
  item_list: [{ type: 1, text_item: { text } }],
});

test("Assistant: reply formatting leaves the original submitted request intact", async () => {
  const f = setup({
    reply: "好。\n我来整理。",
    actions: [{ kind: "start", card: null, choice: null, run: null, agent: "codex", subject: null, title: "整理笔记" }],
  });
  await f.bridge.inbound(message("帮我整理笔记，但别删文件。", "one"));
  assert.equal(f.events[0].detail, "帮我整理笔记，但别删文件。");
  assert.equal(f.sent[0], "好\n我来整理");
});

test("Assistant: bounded personal memories survive recent-history rotation and state reload", async () => {
  const f = setup({ reply: "记下了", actions: [], remember: ["使用者喜欢喝无糖咖啡"] });
  await f.bridge.inbound(message("我喜欢喝无糖咖啡", "one"));
  f.state.dialogue!.history = [];
  const snapshot = makeSnapshot("记得我喝什么吗", JSON.parse(JSON.stringify(f.state)), { cards: [], runs: [] });
  assert.deepEqual(snapshot.memories, ["使用者喜欢喝无糖咖啡"]);
  assert.equal(snapshot.history.length, 0);
});

test("Assistant: a sleep nudge is sent once per Shanghai night, including after midnight", async () => {
  const f = setup({ reply: "好", actions: [], sleepNudge: "忙完早点睡" });
  await f.bridge.inbound(message("还在忙", "one"));
  f.deps.now = () => Date.parse("2026-11-04T17:30:00Z");
  await f.bridge.inbound(message("再改一点", "two"));
  assert.equal(f.sent.filter((text) => text.includes("早点睡")).length, 1);
  const reloaded = JSON.parse(JSON.stringify(f.state));
  assert.equal(makeSnapshot("在忙", reloaded, { cards: [], runs: [] }, f.deps.now()).night.mayRemind, false);
  f.deps.now = () => Date.parse("2026-11-05T15:30:00Z");
  await f.bridge.inbound(message("又在忙", "three"));
  assert.equal(f.sent.filter((text) => text.includes("早点睡")).length, 2);
});
