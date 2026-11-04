import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DesktopIPC } from "./ipc.ts";
import { blocked, ownedTurn, resultOf, validateWorkspace, verifyPolicy } from "./protocol.ts";
import { loadJson, saveJson } from "./storage.ts";
import type { Access, Reading } from "../../worker/agents.ts";

export type Input = {
  prompt: string;
  cwd: string;
  access: Access;
  resume: string | null;
  key: string;
  model?: string;
  effort?: string;
};
export type State = {
  phase: "prepared" | "submitting" | "running" | "done";
  key: string;
  thread?: string;
  turn?: string;
  reading?: Reading;
  policyError?: string;
};
export const inputFile = (folder: string) => path.join(folder, "desktop-input.json");
export const stateFile = (folder: string) => path.join(folder, "desktop-state.json");
export function readState(folder: string): State | undefined {
  return existsSync(stateFile(folder)) ? loadJson(stateFile(folder)) : undefined;
}
export function session(id: string) {
  return JSON.stringify({ desktop: id });
}
export function threadOf(value: string) {
  let id = value;
  try {
    id = JSON.parse(value).desktop;
  } catch {}
  if (typeof id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id))
    throw new Error("桌面会话编号不符");
  return id;
}
export function pipe() {
  return path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "ipc/ipc.sock");
}
export async function connect(state: State) {
  const ipc = new DesktopIPC(pipe());
  try {
    await ipc.connect();
    await ipc.follow(state.thread!);
    return ipc;
  } catch (e) {
    ipc.close();
    throw e;
  }
}
export function finish(folder: string, state: State, reading: Reading) {
  state.phase = "done";
  state.reading = reading;
  saveJson(stateFile(folder), state);
  return reading;
}
export async function reconcile(folder: string, stopping: boolean): Promise<{ pending: boolean; reading?: Reading }> {
  const state = readState(folder);
  if (!state || state.phase === "prepared")
    return {
      pending: false,
      reading: state?.reading ?? { finished: true, text: blocked("转接在提交任务之前结束了，请核实后继续") },
    };
  if (state.phase === "done") return { pending: false, reading: state.reading };
  const input: Input = loadJson(inputFile(folder));
  const ipc = await connect(state);
  try {
    validateWorkspace(ipc.state, input.cwd);
    let turn = ownedTurn(ipc.state, state.turn ?? "", state.key);
    if (!turn) return { pending: true };
    if (!state.turn && turn.turnId) {
      state.turn = turn.turnId;
      state.phase = "running";
      saveJson(stateFile(folder), state);
    }
    try {
      verifyPolicy(turn.params?.sandboxPolicy, input.access, input.cwd, state.thread!);
    } catch (e) {
      state.policyError = (e as Error).message;
      saveJson(stateFile(folder), state);
    }
    stopping ||= Boolean(state.policyError);
    let reading = resultOf(turn, session(state.thread!));
    if (!reading && stopping) {
      await ipc.request(
        "thread-follower-interrupt-turn",
        { conversationId: state.thread, mode: "user-stop", expectedTurnId: state.turn },
        ipc.owner,
      );
      await ipc
        .until((s) => Boolean(resultOf(ownedTurn(s, state.turn!, state.key), session(state.thread!))), 1500)
        .catch(() => {});
      turn = ownedTurn(ipc.state, state.turn!, state.key);
      reading = resultOf(turn, session(state.thread!));
    }
    if (reading && state.policyError) reading.text = blocked(state.policyError);
    return reading ? { pending: false, reading: finish(folder, state, reading) } : { pending: true };
  } finally {
    ipc.close();
  }
}
