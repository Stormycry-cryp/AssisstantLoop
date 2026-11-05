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
      {
        provider: "codex",
        id: "manual",
        turn: "one",
        title: "work",
        status,
        completedAt: status === "completed" ? Date.now() + 1 : undefined,
        summaryVerified: true,
        summary: "result",
      },
      {
        provider: "codex",
        id: "managed",
        turn: "two",
        title: "managed",
        status,
        completedAt: status === "completed" ? Date.now() + 1 : undefined,
        summary: "managed result",
      },
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
    sessions: [
      {
        provider: "pi",
        id: "manual",
        turn: "one",
        title: "native task",
        status,
        completedAt: status === "completed" ? Date.now() + 1 : undefined,
        summaryVerified: true,
        summary: "native result",
      },
    ],
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
        completedAt: status === "completed" ? Date.now() + 1 : undefined,
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

test("native history recovery: old running or unknown records becoming terminal cannot masquerade as new completions", async () => {
  for (const previous of ["running", "unknown"]) {
    const home = mkdtempSync(join(tmpdir(), "autoloop-old-recovery-"));
    let status = previous;
    const completedAt = Date.now() - 86400000;
    const scan = async () => ({
      sessions: [
        {
          provider: "pi",
          id: "historical",
          turn: "old-turn",
          title: "old video task",
          status,
          summary: "old video result",
          completedAt,
        },
      ],
      issues: [],
    });
    try {
      let monitor = new ActivityMonitor(home, scan);
      await monitor.tick({}, async () => assert.fail("baseline"));
      status = "completed";
      monitor = new ActivityMonitor(home, scan);
      await monitor.tick({}, async () => assert.fail("old history replayed as new"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("native notification recovery: an old draft without completion evidence is retained but cannot be emitted", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-unverified-draft-"));
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  mkdirSync(join(home, "local-activity"));
  writeFileSync(
    join(home, "local-activity/state.json"),
    JSON.stringify({ startedAt: Date.now(), seen: {}, pending: { "n-old": "old video result" } }),
  );
  try {
    const monitor = new ActivityMonitor(home, async () => ({ sessions: [], issues: [] }));
    await monitor.tick({}, async () => assert.fail("unverified old draft sent"));
    assert.ok(readFileSync(join(home, "local-activity/state.json"), "utf8").includes("old video result"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native Codex completion timestamps normalize epoch seconds rather than parsing them as calendar strings", () => {
  const r = codexActivity(
    [
      {
        type: "event_msg",
        timestamp: "2026-11-05T04:00:00Z",
        payload: { type: "task_complete", turn_id: "one", completed_at: 1793851200, last_agent_message: "done" },
      },
    ],
    0,
  );
  assert.equal(r.completedAt, 1793851200000);
});

test("native Pi results: a previous turn message cannot be reported as the current turn result", async () => {
  const { piFinal } = await import("../plugins/weixin/activity.ts");
  const projection = {
    thread: { id: "thread" },
    runs: [{ id: "new", threadId: "thread", status: "completed" }],
    messages: [{ threadId: "thread", runId: "old", role: "assistant", streaming: false, text: "old video result" }],
  };
  assert.equal(piFinal(projection, "thread", "new").summaryVerified, false);
  projection.messages.push({
    threadId: "thread",
    runId: "new",
    role: "assistant",
    streaming: false,
    text: "current room result",
  });
  assert.equal(piFinal(projection, "thread", "new").summary, "current room result");
  assert.equal(piFinal(projection, "other-thread", "new").summaryVerified, false);
});

test("native pending recovery: legacy text is replaced only by fresh matching native evidence", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-rebind-pending-"));
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const since = Date.now() - 10000,
    key =
      "n-" +
      createHash("sha256")
        .update(JSON.stringify(["pi:current", "turn", "completed"]))
        .digest("hex")
        .slice(0, 60);
  mkdirSync(join(home, "local-activity"));
  writeFileSync(
    join(home, "local-activity/state.json"),
    JSON.stringify({
      startedAt: since,
      seen: { "pi:current": { turn: "turn", status: "completed" } },
      pending: { [key]: "unverified old video text" },
    }),
  );
  try {
    const monitor = new ActivityMonitor(home, async () => ({
      sessions: [
        {
          provider: "pi",
          id: "current",
          turn: "turn",
          title: "room",
          status: "completed",
          completedAt: Date.now() - 1000,
          summary: "current room result",
          summaryVerified: true,
        },
      ],
      issues: [],
    }));
    let sent = "";
    await monitor.tick({}, async (k, t) => {
      sent = t;
    });
    assert.match(sent, /current room result/);
    assert.doesNotMatch(sent, /old video/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
