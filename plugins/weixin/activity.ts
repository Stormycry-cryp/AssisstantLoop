import { DatabaseSync } from "node:sqlite";
import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  readdirSync,
  existsSync,
  realpathSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
export type Activity = {
  provider: string;
  id: string;
  turn: string;
  title: string;
  status: string;
  summary: string;
  updatedAt?: number;
  completedAt?: number;
  project?: string;
};
type Snapshot = { sessions: Activity[]; issues: string[] };
type Scan = () => Promise<Snapshot>;
const terminal = new Set(["completed", "interrupted", "failed", "cancelled"]);
export function publicText(value: unknown, limit = 400) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*)["']?[^\s"']+/gi, "$1[REDACTED]")
    .slice(0, limit);
}
function tail(file: string, limit = 128 * 1024) {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("记录所有者不符");
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    readSync(fd, bytes, 0, bytes.length, stat.size - bytes.length);
    const lines = bytes.toString("utf8").split("\n");
    if (stat.size > bytes.length) lines.shift();
    return {
      mtime: stat.mtimeMs,
      rows: lines.flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }),
    };
  } finally {
    closeSync(fd);
  }
}
export function codexActivity(rows: any[], mtime: number, now = Date.now()) {
  let completedAt: number | undefined;
  let status = "unknown",
    turn = "",
    summary = "";
  for (const row of rows) {
    if (row.type !== "event_msg") continue;
    const p = row.payload ?? {};
    if (p.type === "task_complete") {
      status = "completed";
      completedAt = Date.parse(p.completed_at ?? row.timestamp);
      turn = p.turn_id ?? "";
      summary = typeof p.last_agent_message === "string" ? publicText(p.last_agent_message) : "";
    } else if (p.type === "turn_aborted") {
      status = "interrupted";
      completedAt = Date.parse(p.completed_at ?? row.timestamp);
      turn = p.turn_id ?? "";
      summary = "原会话已停止";
    } else if (p.turn_id && ["task_started", "item_started", "item_completed", "agent_message"].includes(p.type)) {
      if (p.turn_id !== turn || !terminal.has(status)) {
        turn = p.turn_id;
        status = "running";
        summary = "";
      }
    }
  }
  if (status === "running" && now - mtime > 180000) status = "unknown";
  return { status, turn, summary, completedAt };
}
export function readCodex(root = process.env.CODEX_HOME ?? path.join(homedir(), ".codex")): Activity[] {
  const name = readdirSync(root)
    .filter((n) => /^state_\d+\.sqlite$/.test(n))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  if (!name) throw new Error("没有找到本机 Codex 会话索引");
  const db = new DatabaseSync(path.join(root, name), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id,rollout_path,source,cwd,title,updated_at FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 40",
      )
      .all()
      .flatMap((row: any) => {
        if (!["vscode", "cli", "exec", "appServer"].includes(row.source)) return [];
        try {
          const file = realpathSync(row.rollout_path);
          if (
            !["sessions", "archived_sessions"].some((n) => file.startsWith(path.join(realpathSync(root), n) + path.sep))
          )
            return [];
          const data = tail(file),
            activity = codexActivity(data.rows, data.mtime);
          return [
            {
              provider: "codex",
              id: row.id,
              title: publicText(row.title, 80),
              project: path.basename(row.cwd),
              updatedAt: data.mtime,
              ...activity,
            },
          ];
        } catch {
          return [
            {
              provider: "codex",
              id: row.id,
              title: publicText(row.title, 80),
              project: path.basename(row.cwd),
              updatedAt: row.updated_at * 1000,
              status: "unknown",
              turn: "",
              summary: "当前会话记录暂时读不到",
            },
          ];
        }
      });
  } finally {
    db.close();
  }
}
async function bounded(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("本机 Pi 只读接口未确认");
  }
  const reader = response.body!.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1024 * 1024) throw new Error("Pi 状态超过1MiB");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function readPi(home: string, signal?: AbortSignal): Promise<Activity[]> {
  const file = path.join(home, "local-activity/pi-read.json");
  if (!existsSync(file)) throw new Error("Pi 尚未登记只读会话连接");
  const stat = await import("node:fs").then((f) => f.lstatSync(file));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error("Pi 只读连接配置权限不符");
  if (stat.size > 8192) throw new Error("Pi 只读连接配置超过上限");
  const credential = JSON.parse(readFileSync(file, "utf8"));
  if (credential.scope !== "orchestration:read" || credential.expiresAt < Date.now())
    throw new Error("Pi 只读会话连接需恢复");
  const data = await bounded(
    await fetch("http://127.0.0.1:3774/api/orchestration/shell", {
      headers: { Authorization: "Bearer " + credential.token },
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
    }),
  );
  if (!Array.isArray(data.threads)) throw new Error("Pi 会话状态格式不符");
  return data.threads
    .sort((a: any, b: any) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 40)
    .map((t: any) => ({
      provider: "pi",
      id: t.id,
      turn: t.activeRunId ?? t.latestRunId ?? "",
      title: publicText(t.title ?? "Pi 会话", 80),
      status: t.activeRunId ? "running" : terminal.has(t.status) ? t.status : "unknown",
      summary: t.latestVisibleMessage?.role === "assistant" ? publicText(t.latestVisibleMessage.text) : "",
      updatedAt: Date.parse(t.updatedAt),
      completedAt: Date.parse(t.latestRunCompletedAt),
    }));
}
export const nativeScan =
  (home: string, signal?: AbortSignal): Scan =>
  async () => {
    const sessions: Activity[] = [],
      issues: string[] = [];
    try {
      sessions.push(...readCodex());
    } catch {
      issues.push("Codex 本机会话状态暂时读不到");
    }
    try {
      sessions.push(...(await readPi(home, signal)));
    } catch {
      issues.push("Pi 本机会话状态暂时读不到");
    }
    return { sessions, issues };
  };
function managed(view: any) {
  const ids = new Set<string>();
  for (const r of view.runs ?? []) {
    if (!r.session) continue;
    ids.add(r.session);
    try {
      const s = JSON.parse(r.session);
      for (const k of ["desktop", "thread", "threadId"]) if (typeof s[k] === "string") ids.add(s[k]);
    } catch {}
  }
  return ids;
}
export class ActivityMonitor {
  private file: string;
  private saved: {
    startedAt?: number;
    seen: Record<string, { turn: string; status: string }>;
    pending: Record<string, string>;
  };
  private current: Snapshot = { sessions: [], issues: [] };
  private refreshed = 0;
  private flight?: Promise<void>;
  private scan: Scan;
  constructor(home: string, scan: Scan = nativeScan(home)) {
    this.scan = scan;
    this.file = path.join(home, "local-activity/state.json");
    if (existsSync(this.file)) {
      const b = readFileSync(this.file);
      if (b.length > 128 * 1024) throw new Error("外部任务观察记录超过上限");
      this.saved = JSON.parse(b.toString("utf8"));
    } else this.saved = { seen: {}, pending: {}, startedAt: Date.now() };
  }
  private save() {
    const b = JSON.stringify(this.saved);
    if (Buffer.byteLength(b) > 128 * 1024) throw new Error("外部任务观察记录超过上限");
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + ".tmp", b + "\n", { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  snapshot() {
    return this.current;
  }
  async refresh(view: any) {
    if (this.flight) return this.flight;
    if (Date.now() - this.refreshed < 15000) return;
    this.flight = (async () => {
      const data = await this.scan(),
        exclude = managed(view);
      this.current = { ...data, sessions: data.sessions.filter((s) => !exclude.has(s.id)).slice(0, 80) };
      for (const s of this.current.sessions) {
        const id = s.provider + ":" + s.id,
          old = this.saved.seen[id];
        if (
          (old || (s.completedAt ?? 0) > (this.saved.startedAt ?? Infinity)) &&
          s.turn &&
          terminal.has(s.status) &&
          (!old ||
            old.status === "running" ||
            old.status === "queued" ||
            old.status === "unknown" ||
            old.turn !== s.turn)
        ) {
          const key =
            "n-" +
            createHash("sha256")
              .update(JSON.stringify([id, s.turn, s.status]))
              .digest("hex")
              .slice(0, 60);
          if (Object.keys(this.saved.pending).length >= 16 && !this.saved.pending[key])
            throw new Error("外部任务待汇报已达16条");
          const label =
            s.status === "completed" ? "这一轮已结束" : s.status === "failed" ? "这一轮失败了" : "这一轮已停止";
          this.saved.pending[key] =
            `本机任务状态更新\n${s.provider === "codex" ? "Codex" : "Pi"}：${s.title}\n${label}\n${s.summary || "没有可核实的最终摘要"}`;
        }
        this.saved.seen[id] = { turn: s.turn, status: s.status };
      }
      while (Object.keys(this.saved.seen).length > 128) {
        const id = Object.keys(this.saved.seen).find((k) => terminal.has(this.saved.seen[k].status));
        if (!id) throw new Error("活跃观察记录超过128条");
        delete this.saved.seen[id];
      }
      this.save();
      this.refreshed = Date.now();
    })();
    try {
      await this.flight;
    } finally {
      this.flight = undefined;
    }
  }
  async tick(view: any, tell: (key: string, text: string) => Promise<unknown>) {
    await this.refresh(view);
    for (const [key, text] of Object.entries(this.saved.pending)) {
      await tell(key, text);
      delete this.saved.pending[key];
      this.save();
    }
  }
}
