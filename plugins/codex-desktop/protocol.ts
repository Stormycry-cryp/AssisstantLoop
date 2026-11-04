import path from "node:path";
import { homedir } from "node:os";
import type { Reading, Access } from "../../worker/agents.ts";

export function turns(state: any): any[] {
  return [...(state?.turns ?? []), ...Object.values(state?.turnHistory?.history?.entitiesByKey ?? {})];
}
export function ownedTurn(state: any, id: string, key: string) {
  return turns(state).find((t) => (id ? t.turnId === id : t.params?.clientUserMessageId === key));
}
export function busy(state: any) {
  return (
    state?.threadRuntimeStatus?.type === "active" ||
    turns(state).some((t) => t.status === "inProgress") ||
    Boolean(state?.unconfirmedTurnSubmissions?.length)
  );
}
export function sandbox(access: Access, cwd: string) {
  if (access === "read") return { type: "readOnly" };
  if (access === "edit")
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  return { type: "dangerFullAccess" };
}
export function verifyPolicy(policy: any, access: Access, cwd: string, thread: string) {
  const expected = sandbox(access, cwd).type;
  if (policy?.type !== expected || (access !== "full" && policy.networkAccess === true))
    throw new Error("桌面没有采用规则指定的权限");
  if (access === "edit") {
    const artifact = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "visualizations");
    const roots = policy.writableRoots;
    if (
      !Array.isArray(roots) ||
      !roots.some((r: any) => typeof r === "string" && path.resolve(r) === path.resolve(cwd)) ||
      roots.some(
        (r: any) =>
          typeof r !== "string" ||
          (path.resolve(r) !== path.resolve(cwd) &&
            !(path.resolve(r).startsWith(artifact + path.sep) && path.resolve(r).split(path.sep).includes(thread))),
      )
    )
      throw new Error("桌面写入目录超出可信规则");
  }
}
export function validateWorkspace(state: any, cwd: string) {
  if (typeof state?.cwd !== "string" || path.resolve(state.cwd) !== path.resolve(cwd))
    throw new Error("桌面会话目录与可信任务规则不一致");
}
export function blocked(reason: string) {
  return `待你处理：${reason}\n\n\`\`\`agent-autoloop\n${JSON.stringify({ ask: [{ title: "桌面任务需要核实", text: `${reason}。请先在桌面核实原会话；保留已完成的工作，不另开会话重做。`, options: ["已核实，继续剩余步骤", "结束这件事"], key: "codex-desktop-connection" }] })}\n\`\`\``;
}
export function resultOf(turn: any, session: string): Reading | undefined {
  if (!turn || !["completed", "interrupted", "failed"].includes(turn.status)) return;
  if (turn.status !== "completed")
    return {
      session,
      finished: true,
      text: turn.status === "interrupted" ? "已停止" : blocked("桌面没有完成这一轮，请检查原会话的错误"),
    };
  const final = turn.items
    ?.filter((i: any) => i.type === "agentMessage" && (i.phase === "final_answer" || i.phase == null))
    .map((i: any) => i.text)
    .filter((t: any) => typeof t === "string" && t.trim())
    .join("\n");
  if (!final) return { session, finished: true, text: blocked("桌面结束了这一轮，但没有交回最终答复") };
  return {
    session,
    finished: true,
    text: Buffer.byteLength(final) > 128 * 1024 ? blocked("桌面结果超过128KiB，请在原会话核实完整结果") : final,
  };
}
