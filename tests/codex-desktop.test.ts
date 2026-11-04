// Desktop work survives its relay process. Only the matching desktop turn may
// finish or be stopped; a closed pipe must not become success or a fresh task.
import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopIPC, applyPatches } from "../plugins/codex-desktop/ipc.ts";
import { ownedTurn, resultOf, sandbox, validateWorkspace, verifyPolicy } from "../plugins/codex-desktop/protocol.ts";

test("desktop IPC: fragmented frames, ownership, snapshots and patches keep a selected thread in sync", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-desktop-")),
    file = join(home, "ipc.sock");
  const send = (s: net.Socket, value: any) => {
    const bytes = Buffer.from(JSON.stringify(value)),
      frame = Buffer.alloc(4 + bytes.length);
    frame.writeUInt32LE(bytes.length);
    bytes.copy(frame, 4);
    s.write(frame.subarray(0, 2));
    s.write(frame.subarray(2));
  };
  const server = net.createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE()) {
        const length = bytes.readUInt32LE(),
          m = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8"));
        bytes = bytes.subarray(4 + length);
        if (m.type === "request")
          send(socket, {
            type: "response",
            requestId: m.requestId,
            resultType: "success",
            handledByClientId: "owner",
            result: m.method === "initialize" ? { clientId: "client" } : { supportsUntrustedAppInput: true },
          });
        if (m.method === "thread-stream-following-changed" && m.params.following) {
          send(socket, {
            type: "broadcast",
            method: "thread-stream-state-changed",
            version: 11,
            sourceClientId: "owner",
            params: {
              hostId: "local",
              conversationId: "selected",
              change: { type: "snapshot", revision: 1, conversationState: { turns: [], cwd: "/trusted" } },
            },
          });
          send(socket, {
            type: "broadcast",
            method: "thread-stream-state-changed",
            version: 11,
            sourceClientId: "owner",
            params: {
              hostId: "local",
              conversationId: "other",
              change: { type: "snapshot", revision: 1, conversationState: { cwd: "/wrong" } },
            },
          });
          send(socket, {
            type: "broadcast",
            method: "thread-stream-state-changed",
            version: 11,
            sourceClientId: "owner",
            params: {
              hostId: "local",
              conversationId: "selected",
              change: {
                type: "patches",
                baseRevision: 1,
                revision: 2,
                patches: [{ op: "add", path: ["done"], value: true }],
              },
            },
          });
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(file, r));
  const ipc = new DesktopIPC(file);
  try {
    await ipc.connect();
    await ipc.follow("selected");
    await ipc.until((s) => s.done === true, 1000);
    assert.equal(ipc.state?.cwd, "/trusted");
    assert.equal(ipc.revision, 2);
  } finally {
    ipc.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});
test("desktop IPC: prototype paths and a divergent patch cannot alter trusted host state", () => {
  assert.throws(() => applyPatches({}, [{ op: "add", path: ["__proto__", "polluted"], value: true }]));
  assert.throws(() => applyPatches({}, [{ op: "add", path: ["toString", "polluted"], value: true }]));
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(applyPatches({ items: [1] }, [{ op: "add", path: ["items", 1], value: 2 }]), { items: [1, 2] });
});

test("desktop ownership: another active turn cannot be reported or stopped as this job", () => {
  const state = {
    turns: [
      { turnId: "mine", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "done" }] },
      { turnId: "other", status: "inProgress" },
    ],
  };
  assert.equal(ownedTurn(state, "missing", "key"), undefined);
  assert.equal(resultOf(ownedTurn(state, "mine", "key"), "thread")?.text, "done");
  assert.throws(() => validateWorkspace({ cwd: "/other" }, "/trusted"));
  assert.equal((sandbox("read", "/trusted") as any).type, "readOnly");
  assert.throws(() => verifyPolicy({ type: "dangerFullAccess" }, "edit", "/trusted", "id"));
  assert.doesNotThrow(() => verifyPolicy(sandbox("edit", "/trusted"), "edit", "/trusted", "id"));
});

test("desktop binding: explicit selected chat wins over an older subject session; an uncertain dispatch is never replaced", async () => {
  const { default: adapter } = await import("../plugins/codex-desktop/agent.ts");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "autoloop-desktop-binding-"));
  const chosen = "11111111-1111-4111-8111-111111111111",
    old = "22222222-2222-4222-8222-222222222222";
  const turn = {
    prompt: "trusted",
    session: "new",
    resume: JSON.stringify({ desktop: old }),
    cwd: "/trusted",
    access: "read" as const,
    command: ["thread", chosen],
    contextFile: "/trusted/context.json",
    folder: home,
  };
  try {
    adapter.command(turn);
    const input = JSON.parse(readFileSync(join(home, "desktop-input.json"), "utf8"));
    assert.equal(input.resume, chosen);
    writeFileSync(
      join(home, "desktop-state.json"),
      JSON.stringify({ phase: "submitting", key: input.key, thread: chosen }),
    );
    assert.throws(() => adapter.command({ ...turn, prompt: "another task" }));
    adapter.command(turn);
    assert.equal(JSON.parse(readFileSync(join(home, "desktop-input.json"), "utf8")).key, input.key);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
