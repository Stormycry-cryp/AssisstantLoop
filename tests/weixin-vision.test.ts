// Raw executor menus must not leak into chat. Images must reach the model and the
// original task without accepting strangers, leaking media keys or replaying decisions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCipheriv } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, blankState, type Card } from "../plugins/weixin/bridge.ts";
import { Frontdesk, contextFor } from "../plugins/weixin/frontdesk.ts";
import { makeSnapshot, parseDecision } from "../plugins/weixin/conversation.ts";
import { setup as setupHome } from "./helpers.ts";

const account = { token: "private-token", owner: "owner", account: "bot", base: "https://ilinkai.weixin.qq.com" };
const card: Card = {
  id: 6,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "发截图继续排查",
  text: "无法读取程序占用，需要活动监视器截图",
  options: ["发截图继续查", "先到这里"],
  recommend: 0,
  result: null,
};
const action = { kind: "answer", card: 6, choice: null, run: null, agent: null, subject: null, title: null };
function fixture() {
  const state = blankState();
  const sent: string[] = [],
    answers: any[] = [];
  const deps: any = {
    owner: { state: async () => ({ cards: [card], runs: [] }), cancel: async () => ({}) },
    source: {
      event: async () => {
        throw new Error("must resume, not create a new task");
      },
    },
    channel: {
      answer: async (id: number, body: any) => {
        answers.push({ id, ...body });
      },
      delivered: async () => {},
      failed: async () => {},
    },
    send: async (text: string) => {
      sent.push(text);
    },
    save() {},
    interpret: async () => ({
      reply: "收到，我接着看",
      actions: [action],
      imageSummary: "截图里浏览器占用内存较多，具体数值不清楚",
    }),
    present: async () => "程序占用这步被权限挡住了\n你发张活动监视器截图，我接着看",
  };
  return { state, deps, sent, answers, bridge: new Bridge(account, state, deps) };
}
const message = {
  from_user_id: "owner",
  message_type: 1,
  message_id: "image-one",
  item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "secret-param", aes_key: "secret-key" } } }],
};
const image = {
  data: "iVBORw0KGgo=",
  mimeType: "image/png",
  path: "/trusted/work/attachments/fixed.image",
  sha256: "a".repeat(64),
};

test("Assistant notifications: freeze natural wording before send and reuse it after lost send or hub ack", async () => {
  const f = fixture();
  let calls = 0,
    fail = true;
  f.deps.present = async () => {
    calls++;
    return "程序占用被权限挡住了\n你发张活动监视器截图，我接着看";
  };
  f.deps.send = async (text: string) => {
    if (fail) throw new Error("lost send");
    f.sent.push(text);
  };
  await assert.rejects(f.bridge.deliver(card));
  assert.equal(calls, 1);
  const reloaded = JSON.parse(JSON.stringify(f.state));
  fail = false;
  const restarted = new Bridge(account, reloaded, f.deps);
  f.deps.channel.delivered = async () => {
    throw new Error("lost ack");
  };
  await assert.rejects(restarted.deliver(card));
  f.deps.channel.delivered = async () => {};
  await restarted.deliver(card);
  assert.equal(calls, 1);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.sent[0], /可以选|我建议|先到这里|#6/);
});

test("Assistant vision: only the owner loads images; answer resumes the delivered question with host paths and observations", async () => {
  const f = fixture();
  let loads = 0,
    calls = 0;
  f.state.deliveries["6"] = { version: 1, ref: "original", state: "open" };
  f.deps.images = async () => {
    loads++;
    return [image];
  };
  const decide = f.deps.interpret;
  f.deps.interpret = async (snapshot: any, images: any) => {
    calls++;
    assert.equal(images[0].data, image.data);
    assert.equal(snapshot.images[0].sha256, image.sha256);
    return decide();
  };
  await f.bridge.inbound({ ...message, from_user_id: "stranger" });
  await f.bridge.inbound({ ...message, group_id: "group" });
  assert.equal(loads, 0);
  await f.bridge.inbound(message);
  await f.bridge.inbound(message);
  assert.equal(loads, 1);
  assert.equal(calls, 1);
  assert.equal(f.answers.length, 1);
  assert.equal(f.answers[0].ref, "original");
  assert.match(f.answers[0].text, /fixed\.image/);
  assert.match(f.answers[0].text, /具体数值不清楚/);
  assert.doesNotMatch(JSON.stringify(f.state), /secret-param|secret-key|iVBOR/);
});

test("Assistant vision: a failed download cannot execute the caption while ignoring the unseen image", async () => {
  const f = fixture();
  f.deps.images = async () => {
    throw new Error("private CDN detail");
  };
  f.deps.interpret = async () => {
    throw new Error("must not interpret incomplete input");
  };
  await f.bridge.inbound({
    ...message,
    item_list: [...message.item_list, { type: 1, text_item: { text: "照这个做" } }],
  });
  assert.equal(f.answers.length, 0);
  assert.match(f.sent[0], /图片.*没|没.*图片/);
  assert.doesNotMatch(f.sent[0], /CDN|secret/);
});

test("Assistant vision: later text can explicitly reuse saved image references across restart without another image call", async () => {
  const f = fixture();
  f.deps.images = async () => [image];
  f.deps.interpret = async () => ({
    reply: "看到了，浏览器内存偏多",
    actions: [],
    imageSummary: "浏览器内存偏多，数字模糊",
  });
  await f.bridge.inbound(message);
  const state = JSON.parse(JSON.stringify(f.state));
  state.deliveries["6"] = { version: 1, ref: "original", state: "open" };
  f.deps.interpret = async (snapshot: any, images: any) => {
    assert.equal(images.length, 0);
    assert.match(snapshot.recentImages.summary, /数字模糊/);
    return { reply: "好，接着查", actions: [action], useRecentImages: true };
  };
  const restarted = new Bridge(account, state, f.deps);
  await restarted.inbound({
    ...message,
    message_id: "later",
    item_list: [{ type: 1, text_item: { text: "就按这张图接着看，先别关程序" } }],
  });
  assert.match(f.answers[0].text, /先别关程序/);
  assert.match(f.answers[0].text, /fixed\.image/);
  assert.match(f.answers[0].text, /数字模糊/);
  const expired = makeSnapshot("看看", state, { cards: [], runs: [] }, Date.now() + 86401_000);
  assert.equal(expired.recentImages, undefined);
  assert.throws(() => parseDecision({ reply: "好", actions: [], useRecentImages: true }, expired));
});

test("Assistant notifications: a report cannot answer itself or retain instructions as personal memory", async () => {
  const f = fixture();
  f.state.deliveries["6"] = { version: 1, ref: "original", state: "open" };
  const snapshot = makeSnapshot("", f.state, { cards: [card], runs: [] });
  const desk = new Frontdesk({
    load: async () => ({
      model: { id: "deepseek-v4.1-flash" },
      complete: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({ reply: "已决定", actions: [action] }) }],
      }),
    }),
  });
  try {
    await assert.rejects(desk.present(card, snapshot));
  } finally {
    await desk.close();
  }
});

test("Assistant Pi: attach image blocks as data and serialize notification plus incoming chat without losing either", async () => {
  const f = fixture(),
    snapshot: any = {
      ...makeSnapshot("看看", f.state, { cards: [], runs: [] }),
      images: [{ mimeType: image.mimeType, sha256: image.sha256 }],
    };
  const context: any = contextFor(snapshot, [image]);
  assert.equal(context.messages.at(-1).content[1].type, "image");
  assert.equal(context.messages.at(-1).content[1].data, image.data);
  assert.ok(!context.systemPrompt.includes(image.data));
  let active = 0,
    peak = 0,
    calls = 0;
  const desk = new Frontdesk({
    load: async () => ({
      model: { id: "deepseek-v4.1-flash" },
      complete: async () => {
        active++;
        peak = Math.max(peak, active);
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return {
          stopReason: "stop",
          content: [{ type: "text", text: '{"reply":"你发张活动监视器截图，我接着看","actions":[]}' }],
        };
      },
    }),
  });
  try {
    await Promise.all([
      desk.present(card, makeSnapshot("", f.state, { cards: [], runs: [] })),
      desk.interpret(makeSnapshot("在吗", f.state, { cards: [], runs: [] })),
    ]);
    assert.equal(calls, 2);
    assert.equal(peak, 1);
  } finally {
    await desk.close();
  }
  assert.throws(() =>
    parseDecision(
      { reply: "看到了", actions: [], imageSummary: "编的" },
      makeSnapshot("文字", f.state, { cards: [], runs: [] }),
    ),
  );
});

test("Assistant media: fixed CDN, both documented AES key encodings, private bounded cache and no redownload", async () => {
  const { ImageStore } = await import("../plugins/weixin/media.ts");
  const dir = mkdtempSync(join(tmpdir(), "fenn-vision-"));
  // A minimal signature is enough here; real image decoding belongs to the vision provider.
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex"),
    key = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-128-ecb", key, null),
    encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  let fetches = 0;
  const store = new ImageStore(dir, {
    fetch: async (url: any, options: any) => {
      fetches++;
      assert.equal(new URL(url).origin, "https://novac2c.cdn.weixin.qq.com");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined);
      return new Response(encrypted);
    },
  });
  try {
    const validItems = [
      { type: 2, image_item: { media: { encrypt_query_param: "opaque-token", aes_key: key.toString("base64") } } },
    ];
    for (const [i, encoded] of [
      key.toString("base64"),
      Buffer.from(key.toString("hex")).toString("base64"),
    ].entries()) {
      const items = [{ type: 2, image_item: { media: { encrypt_query_param: "opaque-token", aes_key: encoded } } }];
      const loaded = await store.load(items, String(i));
      assert.equal(loaded[0].data, png.toString("base64"));
      assert.equal(statSync(loaded[0].path).mode & 0o777, 0o600);
      await store.load(items, String(i));
    }
    const direct = [
      { type: 2, image_item: { aeskey: key.toString("hex"), media: { encrypt_query_param: "opaque-token" } } },
    ];
    assert.equal((await store.load(direct, "direct"))[0].data, png.toString("base64"));
    assert.equal(fetches, 3);
    const oversized = new ImageStore(dir, {
      fetch: async () => new Response("", { headers: { "content-length": "99999999" } }),
    });
    await assert.rejects(oversized.load(validItems, "large"), /4 MiB/);
    const streaming = new ImageStore(dir, { fetch: async () => new Response(new Uint8Array(4 * 1024 * 1024 + 17)) });
    await assert.rejects(streaming.load(validItems, "stream"), /4 MiB/);
    const wrong = new ImageStore(dir, { fetch: async () => new Response(Buffer.alloc(16)) });
    await assert.rejects(wrong.load(validItems, "bad"));
    await assert.rejects(store.load([direct[0], direct[0], direct[0]], "many"), /两张/);
    for (let i = 0; i < 29; i++) writeFileSync(join(dir, `${String(i).padStart(64, "0")}.png`), png);
    await assert.rejects(store.load(validItems, "over-cap"), /32 张/);
    assert.ok(existsSync((await store.load(validItems, "0"))[0].path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Assistant vision: real hub carries saved images into the same resumed session without duplicate tasks", async () => {
  const home = mkdtempSync(join(tmpdir(), "fenn-image-hub-"));
  const rules = join(home, "rules.json");
  writeFileSync(
    rules,
    JSON.stringify({
      sources: { weixin: { name: "微信" } },
      agents: { codex: { name: "Codex", worker: "test", use: "command", command: ["echo", "unused"] } },
      channels: { weixin: { name: "微信", answerers: ["owner"] } },
      rules: [
        {
          name: "截图排查",
          when: { source: "weixin", types: ["task.codex"] },
          to: "codex",
          cwd: home,
          tell: "always",
          parallel: 1,
        },
      ],
      elsewhere: [],
    }),
  );
  setupHome("fenn-image-hub", rules);
  const runtime = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const server = serve(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const source = hubClient(url, runtime.addKey("source", "weixin")),
    channel = hubClient(url, runtime.addKey("channel", "weixin")),
    owner = hubClient(url, runtime.addKey("owner", "owner")),
    worker = hubClient(url, runtime.addKey("worker", "test"));
  const state = blankState();
  const bridge = new Bridge(account, state, {
    source,
    channel,
    owner,
    send: async () => {},
    save() {},
    present: async () => "你发张占用截图，我接着看",
    images: async () => [image],
    interpret: async (snapshot) =>
      snapshot.images?.length
        ? {
            reply: "我接着看",
            imageSummary: "程序名可见，数值模糊",
            actions: [{ ...action, card: snapshot.questions[0].id }] as any,
          }
        : {
            reply: "我来查",
            actions: [{ ...action, kind: "start", card: null, agent: "codex", title: "查占用" }] as any,
          },
  });
  try {
    await bridge.inbound({
      ...message,
      message_id: "start",
      item_list: [{ type: 1, text_item: { text: "帮我查一下系统占用" } }],
    });
    const { job } = await worker.work({ claim: "first", wait: 0, running: [], capacity: true });
    await worker.result(job.run, job.token, {
      outcome: "done",
      session: "original-session",
      ask: [{ title: "发截图", text: "占用截图", options: ["继续", "先停"] }],
    });
    const { card } = await channel.nextCard(0);
    await bridge.deliver(card);
    await bridge.inbound(message);
    await bridge.inbound(message);
    const { job: resumed } = await worker.work({ claim: "resume", wait: 0, running: [], capacity: true });
    assert.equal(resumed.session, "original-session");
    assert.match(resumed.context.answers[0].text, /fixed\.image/);
    assert.match(resumed.context.answers[0].text, /数值模糊/);
    assert.equal(resumed.context.answers[0].choice, null);
    assert.equal((await owner.state()).runs.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
