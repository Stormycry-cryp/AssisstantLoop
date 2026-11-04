// A client bridge, not an execution engine: native Pi/T3 owns admission, execution and recovery.
import { EventEmitter } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { blocked, parseSession, sessionOf } from "./protocol.ts";

export type BridgeInput = {
  prefix: string;
  cwd: string;
  prompt: string;
  requestId: string;
  resume?: string;
  model?: string;
  effort?: string;
  contextFile?: string;
};
export type UiCli = (options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: { write(text: string): unknown };
  signals: EventEmitter;
}) => Promise<number>;
type Options = {
  cli: UiCli;
  emit: (value: object) => void;
  signals?: EventEmitter;
  identify?: (input: { workspace: string; threadId?: string; requestId: string }) => {
    threadId: string;
    messageId: string;
  };
};
const LIMIT = 128 * 1024;

export async function runBridge(input: BridgeInput, { cli, emit, signals = process, identify }: Options) {
  const env: NodeJS.ProcessEnv = { OPUS_AGENT_HOME: input.prefix };
  // The shared client needs local pairing, never the host's model credentials or full environment.
  for (const name of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const clientSignals = new EventEmitter();
  let session: string | undefined;
  let messageId: string | undefined;
  let accepted = false;
  let stopRequested = false;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  let terminal: any;
  let failure: string | undefined;
  let selection: unknown;
  const read = (text: string) => {
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Pi 单条投影超过 8 MiB，请在 App 中查看");
    return JSON.parse(text);
  };
  const call = (argv: string[], receive: (value: any) => void, localSignals = new EventEmitter()) =>
    cli({
      argv,
      env,
      signals: localSignals,
      stdout: {
        write(text) {
          receive(read(text));
          return true;
        },
      },
    });
  const stop = () => {
    stopRequested = true;
    // Ready precedes dispatch. Wait for native acceptance so a stop cannot race ahead of its input.
    if (!session || !accepted || stopping || terminal) return;
    stopping = (async () => {
      try {
        await call(
          ["stop", "--thread", parseSession(session!).thread, "--request-id", `${input.requestId}-stop`],
          (value) => {
            if (value.type === "error") failure = value.error?.message ?? "Pi 宿主停止失败";
            if (value.type === "result" && value.status === "stopped") {
              stopped = !value.projection?.runs?.some((run: any) => ["running", "queued"].includes(run.status));
            }
          },
        );
      } catch (error) {
        failure = String((error as Error).message);
      }
    })();
  };
  signals.on("SIGTERM", stop);
  signals.on("SIGINT", stop);
  try {
    if (input.contextFile) {
      const context = JSON.parse(readFileSync(input.contextFile, "utf8"));
      if (context.answers?.some((answer: any) => answer.title === "Pi 任务需要你处理" && answer.choice === 1)) {
        emit({ type: "result", text: "按你的选择结束这件事，已保留原线程和已有工作。" });
        return;
      }
    }
    let thread: string | undefined;
    if (input.resume) {
      ({ thread } = parseSession(input.resume));
      session = input.resume;
    }
    // Ask the installed native client for its identity; do not invent a second deduplication scheme.
    const identity = identify?.({ workspace: realpathSync(input.cwd), threadId: thread, requestId: input.requestId });
    let replay = false;
    if (thread || identity) {
      const candidate = thread ?? identity!.threadId;
      let projection: any;
      let missing = false;
      const code = await call(["inspect", "--thread", candidate], (value) => {
        if (value.type === "error") {
          missing =
            !thread &&
            value.error?.code === "OrchestrationV2GetThreadProjectionError" &&
            value.error?.message === `Unknown thread: ${candidate}`;
          if (!missing) throw new Error(value.error?.message ?? "读不到原线程");
        } else if (value.type === "result") projection = value.projection;
      });
      if (!missing) {
        if (code !== 0 || !projection) throw new Error("读不到原线程，请恢复共享宿主连接");
        replay = identity
          ? projection.messages?.some(
              (message: any) => message.id === identity.messageId && message.role === "user",
            ) === true
          : false;
        const busy = projection.runs?.some((run: any) => ["running", "queued"].includes(run.status));
        if (busy && !replay) throw new Error("原线程仍在运行，请先在 App 核实，不重复派活");
        thread = candidate;
      }
    }
    if (stopRequested && !replay) {
      emit({ type: "stopped" });
      return;
    }
    const argv = ["run", "--workspace", input.cwd, "--message", input.prompt, "--request-id", input.requestId];
    if (thread) argv.push("--thread", thread);
    if (input.model) argv.push("--model", input.model);
    // Existing threads retain Pi's saved effort; replay must not attempt to change it.
    if (!thread && !replay && input.effort) argv.push("--effort", input.effort);
    const code = await call(
      argv,
      (value) => {
        if (value.type === "ready") {
          session = sessionOf(value.threadId, value.url);
          messageId = value.messageId;
          emit({ type: "ready", session, requestId: input.requestId, replay: value.replay === true });
        } else if (value.type === "projection") {
          const projection = value.projection;
          selection = projection?.thread?.modelSelection ?? selection;
          accepted ||= projection?.runs?.some((run: any) => run.userMessageId === messageId) ?? false;
          if (stopRequested) stop();
        } else if (value.type === "result") terminal = value;
        else if (value.type === "error") failure = value.error?.message ?? "Pi 共享入口失败";
      },
      clientSignals,
    );
    if (stopping) await stopping;
    if (stopRequested) {
      if (!stopped && !["completed", "interrupted", "cancelled"].includes(terminal?.status)) {
        throw new Error(failure ?? "尚未核实 Pi 宿主已停止，请在 App 检查原任务");
      }
      emit({ type: "stopped", session });
      return;
    }
    if (code !== 0 || terminal?.status !== "completed" || !terminal.text?.trim()) {
      throw new Error(failure ?? `Pi 未完成本轮（${terminal?.status ?? "状态未知"}）`);
    }
    if (Buffer.byteLength(terminal.text) > LIMIT) throw new Error("Pi 最后回复超过 128 KiB，请在 App 中查看完整结果");
    emit({ type: "result", session, text: terminal.text, modelSelection: selection });
  } catch (error) {
    const reason = String((error as Error).message).slice(0, 500);
    emit({
      type: "result",
      session,
      text: blocked(reason, `request-id=${input.requestId}；原会话=${session ?? "未取得"}`),
    });
  } finally {
    signals.off("SIGTERM", stop);
    signals.off("SIGINT", stop);
    clientSignals.emit("SIGTERM");
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  let input: BridgeInput;
  try {
    const file = process.argv[2];
    if (Buffer.byteLength(readFileSync(file)) > 512 * 1024) throw new Error("Pi 输入超过 512 KiB");
    input = JSON.parse(readFileSync(file, "utf8"));
    const module = pathToFileURL(path.join(input.prefix, "provider/current/scripts/opus-ui.mjs")).href;
    const { runUiCli } = await import(module);
    const { requestIdentity } = await import(
      pathToFileURL(path.join(input.prefix, "provider/current/server/t3-client.mjs")).href
    );
    if (typeof runUiCli !== "function") throw new Error("已安装的 Pi 共享入口不支持此适配器");
    if (typeof requestIdentity !== "function") throw new Error("已安装的 Pi 缺少原生输入身份接口");
    await runBridge(input, {
      cli: runUiCli,
      identify: requestIdentity,
      emit: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    });
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ type: "result", text: blocked(String((error as Error).message), "检查 Pi 共享入口；不自动重派") })}\n`,
    );
  }
}
