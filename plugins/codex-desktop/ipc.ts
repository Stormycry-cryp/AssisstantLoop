import net from "node:net";
import { lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const LIMIT = 8 * 1024 * 1024;
const VERSIONS: Record<string, number> = {
  initialize: 1,
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-read-model-settings": 1,
};
export function applyPatches(state: any, patches: any[]) {
  const copy = structuredClone(state);
  if (!Array.isArray(patches) || patches.length > 20000) throw new Error("桌面状态变化超出上限");
  for (const p of patches) {
    if (
      !Array.isArray(p.path) ||
      !p.path.length ||
      p.path.length > 50 ||
      p.path.some(
        (k: any) =>
          !["string", "number"].includes(typeof k) || ["__proto__", "prototype", "constructor"].includes(String(k)),
      )
    )
      throw new Error("桌面状态路径不符");
    let parent = copy;
    for (const key of p.path.slice(0, -1)) {
      if (parent == null || typeof parent !== "object" || !Object.hasOwn(parent, key))
        throw new Error("桌面状态需要重新同步");
      parent = parent[key];
    }
    if (parent == null || typeof parent !== "object") throw new Error("桌面状态需要重新同步");
    const key = p.path.at(-1);
    if (Array.isArray(parent) && (!Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) > parent.length))
      throw new Error("桌面数组路径不符");
    if (p.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (p.op === "add" || p.op === "replace") {
      if (Array.isArray(parent) && p.op === "add") parent.splice(Number(key), 0, p.value);
      else parent[key] = p.value;
    } else throw new Error("桌面状态变化不受支持");
  }
  return copy;
}
export class DesktopIPC {
  readonly file: string;
  state?: any;
  revision = 0;
  owner?: string;
  private socket?: net.Socket;
  private client?: string;
  private selected?: string;
  private bytes = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private failure?: Error;
  constructor(file: string) {
    this.file = file;
  }
  async connect() {
    const stat = lstatSync(this.file),
      directory = lstatSync(path.dirname(this.file));
    if (
      !stat.isSocket() ||
      stat.uid !== process.getuid?.() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o022
    )
      throw new Error("桌面接口不属于当前使用者或目录权限不符");
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection(this.file);
      this.socket = s;
      s.once("error", reject);
      s.once("connect", () => {
        s.off("error", reject);
        resolve();
      });
      s.on("data", (b) => this.data(typeof b === "string" ? Buffer.from(b) : b));
      s.on("error", (e) => this.fail(e));
      s.on("close", () => this.fail(new Error("桌面连接已断开")));
      s.setTimeout(0);
    });
    const result = await this.request("initialize", { clientType: "agent-autoloop" });
    this.client = result.result.clientId;
  }
  private write(message: any) {
    const bytes = Buffer.from(JSON.stringify(message));
    if (bytes.length > LIMIT) throw new Error("桌面请求超过8MiB");
    const frame = Buffer.alloc(4 + bytes.length);
    frame.writeUInt32LE(bytes.length);
    bytes.copy(frame, 4);
    if (!this.socket?.writable) throw new Error("桌面连接不可用");
    this.socket.write(frame);
  }
  request(method: string, params: any, targetClientId?: string, timeoutMs = 5000): Promise<any> {
    if (!(method in VERSIONS)) return Promise.reject(new Error("不受支持的桌面操作"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("桌面请求未确认"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.write({
          type: "request",
          method,
          params,
          requestId,
          sourceClientId: this.client ?? "uninitialized",
          version: VERSIONS[method],
          targetClientId,
          timeoutMs,
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }
  private data(chunk: Buffer) {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    try {
      while (this.bytes.length >= 4) {
        const size = this.bytes.readUInt32LE();
        if (!size || size > LIMIT) throw new Error("桌面响应超过8MiB或为空");
        if (this.bytes.length < size + 4) return;
        const m = JSON.parse(this.bytes.subarray(4, 4 + size).toString("utf8"));
        this.bytes = this.bytes.subarray(4 + size);
        if (m.type === "response") {
          const p = this.pending.get(m.requestId);
          if (p) {
            this.pending.delete(m.requestId);
            clearTimeout(p.timer);
            if (m.resultType === "success") p.resolve(m);
            else p.reject(new Error(String(m.error ?? "桌面操作失败").slice(0, 300)));
          }
        } else if (m.type === "client-discovery-request")
          this.write({
            type: "client-discovery-response",
            requestId: m.requestId,
            clientId: this.client,
            canHandle: false,
          });
        else if (
          m.type === "broadcast" &&
          m.method === "thread-stream-state-changed" &&
          m.version === 11 &&
          m.sourceClientId === this.owner &&
          m.params?.hostId === "local" &&
          m.params.conversationId === this.selected
        ) {
          const change = m.params.change;
          if (change.type === "snapshot") {
            this.state = change.conversationState;
            this.revision = change.revision;
          } else if (change.type === "patches") {
            if (!this.state || change.baseRevision !== this.revision) throw new Error("桌面状态版本不连续");
            this.state = applyPatches(this.state, change.patches);
            this.revision = change.revision;
          }
        }
      }
    } catch (e) {
      this.fail(e as Error);
      this.socket?.destroy();
    }
  }
  async follow(thread: string) {
    this.selected = thread;
    const r = await this.request("thread-owner-discovery", { hostId: "local", conversationId: thread });
    if (r.result?.supportsUntrustedAppInput !== true) throw new Error("当前桌面版本不能安全接收外部任务资料");
    this.owner = r.handledByClientId;
    this.write({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: this.client,
      targetClientIds: [this.owner],
      params: { hostId: "local", conversationId: thread, following: true },
    });
    await this.until((s) => s != null, 5000);
  }
  assertConnected() {
    if (this.failure) throw this.failure;
  }
  async until(predicate: (s: any) => boolean, timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.state && predicate(this.state)) return this.state;
      if (Date.now() >= end) throw new Error("等待桌面状态超时");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  private fail(error: Error) {
    this.failure = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  close() {
    if (this.selected && this.socket?.writable)
      try {
        this.write({
          type: "broadcast",
          method: "thread-stream-following-changed",
          version: 1,
          sourceClientId: this.client,
          targetClientIds: [this.owner],
          params: { hostId: "local", conversationId: this.selected, following: false },
        });
      } catch {}
    this.socket?.destroy();
    this.fail(new Error("桌面连接已关闭"));
  }
}
