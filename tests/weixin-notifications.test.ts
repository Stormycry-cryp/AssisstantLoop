// One receipt can finish an old question, open another and create a summary.
// Those transport events must not become several reworded reminders in chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge, blankState, type Card } from "../plugins/weixin/bridge.ts";
import { Frontdesk } from "../plugins/weixin/frontdesk.ts";
import { makeSnapshot } from "../plugins/weixin/conversation.ts";
const at = "2026-11-04T10:40:00.000Z";
const card = (id: number, kind: string, state: string, extra = {}): Card => ({
  id,
  kind,
  state,
  version: 1,
  ref: null,
  title: "核对截图",
  text: "已看到内存页，等CPU页",
  options: kind === "ask" ? ["继续", "收尾"] : [],
  result: null,
  rule: "检查",
  createdAt: at,
  ...extra,
});
function setup(cards: Card[], recentCards: Card[] = []) {
  const state = blankState(),
    sent: string[] = [],
    ack: number[] = [];
  let renders = 0;
  const deps = {
    owner: { state: async () => ({ cards, recentCards, runs: [] }), cancel: async () => ({}) },
    source: { event: async () => ({}) },
    channel: {
      answer: async () => ({}),
      delivered: async (id: number) => {
        ack.push(id);
      },
      failed: async () => {},
    },
    send: async (text: string) => {
      sent.push(text);
    },
    save() {},
    interpret: async () => ({ reply: "在", actions: [] }),
    present: async () => {
      renders++;
      return "图看到了，等你补CPU页";
    },
  };
  return {
    state,
    sent,
    ack,
    deps,
    renders: () => renders,
    bridge: new Bridge(
      { token: "fake", owner: "owner", account: "bot", base: "https://ilinkai.weixin.qq.com" },
      state,
      deps,
    ),
  };
}
test("Wechat reports: a completed question and FYI do not repeat the new question from the same receipt", async () => {
  const next = card(8, "ask", "open"),
    old = card(6, "ask", "done", { version: 3, createdAt: "2026-11-04T10:15:00Z", closedAt: at, result: "还缺CPU页" }),
    summary = card(9, "notice", "closed");
  const f = setup([next], [old, summary]);
  f.state.deliveries["6"] = { version: 2, ref: "original", state: "decided" };
  for (const value of [old, next, summary]) await f.bridge.deliver(value);
  assert.equal(f.sent.length, 1);
  assert.equal(f.renders(), 1);
  assert.deepEqual(f.ack, [6, 8, 9]);
});
test("Wechat reports: an open business notice owns its receipt; its automatic summary stays quiet", async () => {
  const notice = card(10, "notice", "open"),
    summary = card(11, "notice", "closed");
  const f = setup([notice], [summary]);
  await f.bridge.deliver(summary);
  await f.bridge.deliver(notice);
  assert.equal(f.sent.length, 1);
  assert.equal(f.renders(), 1);
});
test("Wechat reports: an already-known blocker may be acknowledged silently without another send or model call on replay", async () => {
  const notice = card(10, "notice", "open");
  const f = setup([notice]);
  f.deps.present = async () => {
    return null as any;
  };
  await f.bridge.deliver(notice);
  await f.bridge.deliver(notice);
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.deliveries["10"].version, 1);
  assert.deepEqual(f.ack, [10, 10]);
});
test("Wechat reports: model may suppress a redundant report, but ordinary chat cannot request a silent action", async () => {
  const f = setup([]);
  const snapshot = makeSnapshot("", f.state, { cards: [], runs: [] });
  const desk = new Frontdesk({
    load: async () => ({
      model: { id: "deepseek-v4.1-flash" },
      complete: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({ reply: "", actions: [], quiet: true }) }],
      }),
    }),
  });
  try {
    assert.equal(await desk.present(card(10, "notice", "open"), snapshot), null);
    await assert.rejects(desk.interpret({ ...snapshot, message: "继续" }));
  } finally {
    await desk.close();
  }
});
