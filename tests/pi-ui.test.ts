// Guards against mistaking a partial reply for completion, granting unsupported access,
// replaying a submitted input, leaking projections into logs, or only detaching on stop.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import adapter from "../plugins/pi-ui/agent.ts";
import { runBridge, type BridgeInput, type UiCli } from "../plugins/pi-ui/runner.ts";

const thread = "11111111-1111-4111-8111-111111111111";
const url = `http://127.0.0.1:3774/environment/${thread}`;
const session = JSON.stringify({ thread, url });
const input: BridgeInput = {
  prefix: "/unused",
  cwd: "/workspace",
  prompt: "完成任务",
  requestId: "autoloop-test",
  model: "claude-opus-5-5",
  effort: "xhigh",
};
const line = (value: object) => `${JSON.stringify(value)}\n`;

test("Pi: accepts only explicit full access and keeps prompts private and input identities stable", () => {
  const root = mkdtempSync(join(tmpdir(), "autoloop-pi-test-"));
  try {
    const turn = {
      prompt: "do $(touch unexpected); `echo no`",
      session: "unused",
      resume: null,
      cwd: "/workspace",
      folder: join(root, "4-1"),
      contextFile: join(root, "4-1/context.json"),
      access: "full" as const,
    };
    for (const access of ["read", "edit"] as const) {
      assert.throws(() => adapter.command({ ...turn, access }), /full/);
    }
    const argv = adapter.command(turn);
    assert.ok(!argv.join(" ").includes(turn.prompt));
    const first = JSON.parse(readFileSync(argv.at(-1)!, "utf8"));
    const retry = adapter.command({ ...turn, folder: join(root, "4-2"), session: "different" });
    const second = JSON.parse(readFileSync(retry.at(-1)!, "utf8"));
    assert.equal(first.requestId, second.requestId);
    assert.equal(first.prompt, turn.prompt);
    const repair = adapter.command({ ...turn, prompt: "只重写回执" });
    assert.notEqual(first.requestId, JSON.parse(readFileSync(repair.at(-1)!, "utf8")).requestId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi: only a completed bridge result is an answer; a lost bridge becomes a question, never a fresh run", () => {
  const ready = line({ type: "ready", session });
  assert.deepEqual(adapter.read(ready, null, ""), { session });
  const complete = line({ type: "result", session, text: "完成了" });
  assert.deepEqual(adapter.read(ready + complete, 0, ""), { session, text: "完成了", finished: true });
  const interrupted = adapter.read(ready, 1, "connection lost");
  assert.equal(interrupted.error, undefined);
  assert.match(interrupted.text!, /待你处理/);
  assert.match(interrupted.text!, /agent-autoloop/);
  assert.equal(adapter.link(session), url);
  assert.throws(() => adapter.link(JSON.stringify({ thread, url: "https://elsewhere.test" })), /链接/);
});

test("Pi: a replay drops effort and uses the same request instead of resubmitting; projections stay out of logs", async () => {
  const output: string[] = [];
  const calls: string[][] = [];
  const cli: UiCli = async ({ argv, stdout, env }) => {
    calls.push(argv);
    assert.equal(env.AGENT_API_KEY, undefined);
    if (argv[0] === "inspect") {
      stdout.write(line({ type: "result", projection: { messages: [{ id: "m", role: "user" }] } }));
      return 0;
    }
    stdout.write(line({ type: "ready", threadId: thread, url, messageId: "m", replay: true }));
    stdout.write(
      line({
        type: "projection",
        projection: { private: "full history", thread: { modelSelection: { model: "opus" } } },
      }),
    );
    stdout.write(line({ type: "result", status: "completed", text: "好了", threadId: thread }));
    return 0;
  };
  await runBridge({ ...input, resume: session }, { cli, emit: (value) => output.push(line(value)) });
  assert.equal(calls[0][0], "inspect");
  assert.equal(calls[1][0], "run");
  assert.ok(!calls[1].includes("--effort"));
  assert.equal(calls[1][calls[1].indexOf("--request-id") + 1], input.requestId);
  assert.ok(!output.join("").includes("full history"));
  assert.match(output.join(""), /好了/);
});

test("Pi: stopping invokes the host stop command before disconnecting the input observer", async () => {
  const signals = new EventEmitter();
  const order: string[] = [];
  let endRun: (() => void) | undefined;
  const cli: UiCli = async ({ argv, stdout, signals: clientSignals }) => {
    if (argv[0] === "stop") {
      order.push("host-stop");
      stdout.write(line({ type: "result", status: "stopped", projection: { runs: [{ status: "interrupted" }] } }));
      endRun?.();
      return 0;
    }
    stdout.write(line({ type: "ready", threadId: thread, url, messageId: "m" }));
    stdout.write(line({ type: "projection", projection: { runs: [{ userMessageId: "m", status: "running" }] } }));
    await new Promise<void>((resolve) => {
      endRun = resolve;
      clientSignals.once("SIGTERM", () => {
        order.push("detach");
        resolve();
      });
      queueMicrotask(() => signals.emit("SIGTERM"));
    });
    return 1;
  };
  const output: object[] = [];
  await runBridge(input, { cli, signals, emit: (value) => output.push(value) });
  assert.equal(order[0], "host-stop");
  assert.ok(output.some((value: any) => value.type === "stopped"));
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("Pi: a provider failure asks for repair without falling back to another model or thread", async () => {
  let calls = 0;
  const output: any[] = [];
  const cli: UiCli = async ({ stdout }) => {
    calls += 1;
    stdout.write(line({ type: "ready", threadId: thread, url, messageId: "m" }));
    stdout.write(line({ type: "error", error: { message: "额度不足" } }));
    return 1;
  };
  await runBridge(input, { cli, emit: (value) => output.push(value) });
  assert.equal(calls, 1);
  assert.match(output.at(-1).text, /待你处理.*额度不足/);
  assert.match(output.at(-1).text, /不重做/);
});

test("Pi: a retry before ready observes the native input even if it is still running", async () => {
  const output: any[] = [];
  const calls: string[][] = [];
  const cli: UiCli = async ({ argv, stdout }) => {
    calls.push(argv);
    if (argv[0] === "inspect") {
      stdout.write(
        line({
          type: "result",
          projection: {
            messages: [{ id: "original", role: "user" }],
            runs: [{ userMessageId: "original", status: "running" }],
          },
        }),
      );
    } else {
      assert.ok(argv.includes("--thread"));
      assert.ok(!argv.includes("--effort"));
      stdout.write(line({ type: "ready", threadId: thread, url, messageId: "original", replay: true }));
      stdout.write(line({ type: "result", status: "completed", text: "原任务的结果" }));
    }
    return 0;
  };
  await runBridge(
    { ...input, cwd: tmpdir(), effort: "max" },
    {
      cli,
      emit: (value) => output.push(value),
      identify: () => ({ threadId: thread, messageId: "original" }),
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(output.at(-1).text, "原任务的结果");
});

test("Pi: another active input is not interrupted or given a second job", async () => {
  const output: any[] = [];
  let calls = 0;
  const cli: UiCli = async ({ stdout }) => {
    calls += 1;
    stdout.write(
      line({ type: "result", projection: { runs: [{ userMessageId: "someone-else", status: "running" }] } }),
    );
    return 0;
  };
  await runBridge(
    { ...input, cwd: tmpdir(), resume: session },
    {
      cli,
      emit: (value) => output.push(value),
      identify: () => ({ threadId: thread, messageId: "new-input" }),
    },
  );
  assert.equal(calls, 1);
  assert.match(output.at(-1).text, /原线程仍在运行/);
});

test("Pi: only a verified missing native thread permits creation; service failures do not", async () => {
  for (const missing of [true, false]) {
    const output: any[] = [];
    let calls = 0;
    const cli: UiCli = async ({ argv, stdout }) => {
      calls += 1;
      if (argv[0] === "inspect") {
        stdout.write(
          line({
            type: "error",
            error: missing
              ? { code: "OrchestrationV2GetThreadProjectionError", message: `Unknown thread: ${thread}` }
              : { code: "host_unavailable", message: "宿主断开" },
          }),
        );
        return 1;
      }
      assert.ok(argv.includes("--effort"));
      stdout.write(line({ type: "result", status: "completed", text: "新任务完成" }));
      return 0;
    };
    await runBridge(
      { ...input, cwd: tmpdir() },
      {
        cli,
        emit: (value) => output.push(value),
        identify: () => ({ threadId: thread, messageId: "new" }),
      },
    );
    assert.equal(calls, missing ? 2 : 1);
    assert.match(output.at(-1).text, missing ? /新任务完成/ : /待你处理.*宿主断开/);
  }
});

test("Pi: oversized final replies are bounded questions, not truncated valid receipts", async () => {
  const output: any[] = [];
  const cli: UiCli = async ({ stdout }) => {
    stdout.write(line({ type: "result", status: "completed", text: "x".repeat(130 * 1024) }));
    return 0;
  };
  await runBridge(input, { cli, emit: (value) => output.push(value) });
  assert.match(output.at(-1).text, /128 KiB/);
  assert.ok(JSON.stringify(output).length < 4096);
});
