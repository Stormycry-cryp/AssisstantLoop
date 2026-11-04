import { loadJson, saveJson } from "./storage.ts";
import { newThread, openThread } from "./catalog.ts";
import { inputFile, stateFile, readState, connect, finish, session, type Input } from "./session.ts";
import { blocked, busy, validateWorkspace, ownedTurn, resultOf, sandbox, verifyPolicy } from "./protocol.ts";

const folder = process.argv[2],
  input: Input = loadJson(inputFile(folder));
let state = readState(folder)!;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
const emit = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
let ipc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  if (state.phase === "done") {
    emit({ type: "result", ...state.reading });
  } else {
    if (!state.thread) {
      const thread = input.resume ?? (await newThread(input.cwd, input.access)).thread?.id;
      if (!thread) throw new Error("没有收到桌面会话编号");
      state.thread = thread;
      saveJson(stateFile(folder), state);
    }
    const thread = state.thread!;
    emit({ type: "started", session: session(thread) });
    await openThread(thread);
    ipc = await connect(state);
    validateWorkspace(ipc.state, input.cwd);
    if (state.phase === "prepared") {
      if (stopping) {
        emit({
          type: "result",
          ...finish(folder, state, {
            session: session(thread),
            finished: true,
            text: "已停止，尚未提交桌面任务",
          }),
        });
      } else if (busy(ipc.state)) {
        emit({
          type: "result",
          ...finish(folder, state, {
            session: session(thread),
            finished: true,
            text: blocked("选定桌面会话正在处理另一轮任务，本次没有插入或中断它"),
          }),
        });
      } else {
        state.phase = "submitting";
        saveJson(stateFile(folder), state);
        const result = await ipc.request(
          "thread-follower-start-turn",
          {
            conversationId: state.thread,
            turnStart: {
              request: {
                threadId: state.thread,
                input: [{ type: "text", text: input.prompt, text_elements: [] }],
                cwd: input.cwd,
                approvalPolicy: "never",
                sandboxPolicy: sandbox(input.access, input.cwd),
                clientUserMessageId: input.key,
                ...(input.model && { model: input.model }),
                ...(input.effort && { effort: input.effort }),
              },
              context: {
                inheritThreadSettings: true,
                useAppServerPermissionDefault: false,
                useUserMessageAdmission: false,
              },
            },
          },
          ipc.owner,
          10000,
        );
        state.turn = result.result?.result?.turn?.id;
        if (!state.turn) throw new Error("桌面未确认实际轮次，保留原提交等待核实");
        state.phase = "running";
        saveJson(stateFile(folder), state);
      }
    }
    while (!state.reading) {
      ipc.assertConnected();
      const turn = ownedTurn(ipc.state, state.turn ?? "", state.key);
      if (turn?.turnId && !state.turn) {
        state.turn = turn.turnId;
        state.phase = "running";
        saveJson(stateFile(folder), state);
      }
      if (turn) {
        try {
          verifyPolicy(turn.params?.sandboxPolicy, input.access, input.cwd, thread);
        } catch (e) {
          state.policyError = (e as Error).message;
          stopping = true;
          saveJson(stateFile(folder), state);
        }
      }
      const reading = resultOf(turn, session(thread));
      if (reading && state.policyError) reading.text = blocked(state.policyError);
      if (reading) {
        emit({ type: "result", ...finish(folder, state, reading) });
        break;
      }
      if (stopping && state.turn) {
        await ipc.request(
          "thread-follower-interrupt-turn",
          { conversationId: state.thread, mode: "user-stop", expectedTurnId: state.turn },
          ipc.owner,
        );
        stopping = false;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
} catch (error) {
  if (state.phase === "prepared") {
    const reading = finish(folder, state, {
      ...(state.thread && { session: session(state.thread) }),
      finished: true,
      text: blocked(String((error as Error).message).slice(0, 200)),
    });
    emit({ type: "result", ...reading });
  } else {
    process.stderr.write("桌面结果尚未核实，保留任务与提交编号，不重新派发\n");
    process.exitCode = 1;
  }
} finally {
  ipc?.close();
}
