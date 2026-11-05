// Read-only discovery must not confuse old completions with new work, stale
// activity with completion, or observed manual sessions with controlled jobs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexActivity, ActivityMonitor, publicText } from "../plugins/weixin/activity.ts";
test("native Codex evidence: only explicit terminal events mean completion; stale activity remains unknown", () => {
  const rows = [
    { type: "event_msg", payload: { type: "task_complete", turn_id: "old", last_agent_message: "old result" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "new" } },
  ];
  assert.equal(codexActivity(rows, 1000, 2000).status, "running");
  assert.equal(codexActivity(rows, 1000, 200000).status, "unknown");
  rows.push({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "new", last_agent_message: "new result" },
  } as any);
  assert.equal(codexActivity(rows, 1000, 200000).status, "completed");
  assert.equal(codexActivity(rows, 1000, 200000).summary, "new result");
  assert.equal(codexActivity([], 1000, 2000).status, "unknown");
});
test("native monitor: baseline is quiet, observed completion is durable once, and AutoLoop sessions are excluded", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-observe-"));
  let status = "running";
  let count = 0;
  const scan = async () => ({
    sessions: [
      { provider: "codex", id: "manual", turn: "one", title: "work", status, summary: "result" },
      { provider: "codex", id: "managed", turn: "two", title: "managed", status, summary: "managed result" },
    ],
    issues: [],
  });
  const notices: any[] = [];
  const view = { runs: [{ session: "managed" }] };
  try {
    let monitor = new ActivityMonitor(home, scan);
    await monitor.tick(view, async (key, text) => {
      assert.match(key, /^[a-z0-9][a-z0-9._-]{0,63}$/);
      notices.push({ key, text });
    });
    assert.equal(notices.length, 0);
    assert.equal(monitor.snapshot().sessions.length, 1);
    status = "completed";
    monitor = new ActivityMonitor(home, scan);
    await assert.rejects(
      monitor.tick(view, async () => {
        count++;
        throw new Error("lost response");
      }),
    );
    monitor = new ActivityMonitor(home, scan);
    await monitor.tick(view, async (key, text) => {
      assert.match(key, /^[a-z0-9][a-z0-9._-]{0,63}$/);
      notices.push({ key, text });
    });
    await monitor.tick(view, async () => {
      assert.fail("duplicate notice");
    });
    assert.equal(count, 1);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /result/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native monitor: a new short task completing between polls still reports once", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-observe-short-"));
  let sessions: any[] = [];
  const scan = async () => ({ sessions, issues: [] });
  try {
    let monitor = new ActivityMonitor(home, scan);
    await monitor.tick({}, async () => assert.fail("empty baseline"));
    sessions = [
      {
        provider: "pi",
        id: "fast",
        turn: "one",
        title: "fast task",
        status: "completed",
        summary: "done",
        updatedAt: Date.now() + 1,
        completedAt: Date.now() + 1,
      },
    ];
    monitor = new ActivityMonitor(home, scan);
    let notices = 0;
    await monitor.tick({}, async () => {
      notices++;
    });
    assert.equal(notices, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native summaries: common credential strings are redacted before entering the front desk", () => {
  assert.equal(
    publicText("Bearer abcdef1234567890 secret " + "sk-" + "1234".repeat(5)),
    "Bearer [REDACTED] secret [REDACTED]",
  );
});

test("native observer: an adapter returning online must not announce its old history as new completions", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-observe-old-"));
  let sessions: any[] = [];
  const scan = async () => ({ sessions, issues: [] });
  try {
    let monitor = new ActivityMonitor(home, scan);
    await monitor.tick({}, async () => assert.fail("empty baseline"));
    sessions = [
      {
        provider: "pi",
        id: "old",
        turn: "old-run",
        title: "old task",
        status: "completed",
        summary: "old",
        updatedAt: Date.now() + 1000,
        completedAt: Date.now() - 3600000,
      },
    ];
    monitor = new ActivityMonitor(home, scan);
    await monitor.tick({}, async () => assert.fail("historical completion must remain quiet"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native completion reaches a real temporary hub once after a lost acknowledgement", async () => {
  const { setup } = await import("./helpers.ts");
  const home = setup("native-hub");
  const runtime = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const server = serve(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const source = hubClient(url, runtime.addKey("source", "app")),
    owner = hubClient(url, runtime.addKey("owner", "me"));
  let status = "running";
  const scan = async () => ({
    sessions: [{ provider: "pi", id: "manual", turn: "one", title: "native task", status, summary: "native result" }],
    issues: [],
  });
  try {
    let monitor = new ActivityMonitor(home, scan);
    await monitor.tick({}, async (key, text) => source.tell({ key, text }));
    status = "completed";
    monitor = new ActivityMonitor(home, scan);
    await assert.rejects(
      monitor.tick({}, async (key, text) => {
        await source.tell({ key, text });
        throw new Error("ack lost");
      }),
    );
    monitor = new ActivityMonitor(home, scan);
    await monitor.tick({}, async (key, text) => source.tell({ key, text }));
    const state = await owner.state();
    const cards = [...state.cards, ...state.recentCards];
    assert.equal(cards.length, 1);
    assert.match(cards[0].text, /native result/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    runtime.db.close();
  }
});

test("native Pi labels: application, project and model are reported separately", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-observe-label-"));
  let status = "running";
  const scan = async () => ({
    sessions: [
      {
        provider: "pi",
        id: "manual",
        turn: "one",
        title: "review task",
        status,
        summary: "done",
        app: "Opus Agent",
        project: "Example Project",
        model: "claude-opus-5-5",
        machine: "本机",
      },
    ],
    issues: [],
  });
  try {
    let monitor = new ActivityMonitor(home, scan);
    await monitor.tick({}, async () => assert.fail("baseline"));
    status = "completed";
    monitor = new ActivityMonitor(home, scan);
    let text = "";
    await monitor.tick({}, async (k, t) => {
      text = t;
    });
    assert.match(text, /本机.*Opus Agent/);
    assert.match(text, /Example Project/);
    assert.match(text, /claude-opus-5-5/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
