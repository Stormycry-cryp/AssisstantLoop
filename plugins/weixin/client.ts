// HTTP wire format independently implemented from the documented iLink adapter interface.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Account = { token: string; owner: string; account: string; base: string };
export const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const JSON_LIMIT = 256 * 1024;

export function trustedBase(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".weixin.qq.com") ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("微信接口必须使用已核实的官方 HTTPS 域名");
  }
  return url.origin;
}

export function saveJson(file: string, value: unknown) {
  const data = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(data) > JSON_LIMIT) throw new Error("微信私有状态超过 256 KiB 上限，保留原文件");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}

export function loadJson(file: string): any {
  const data = readFileSync(file);
  if (data.length > JSON_LIMIT) throw new Error("微信私有状态超过 256 KiB 上限");
  return JSON.parse(data.toString("utf8"));
}

export function readAccount(file: string): Account {
  const account = loadJson(file);
  if (
    ![account.token, account.owner, account.account].every(
      (value) => typeof value === "string" && value.length > 0 && value.length < 8192,
    )
  ) {
    throw new Error("微信尚未完成本人扫码绑定");
  }
  account.base = trustedBase(account.base);
  return account;
}

async function boundedJson(response: Response) {
  if (!response.body) throw new Error("接口没有返回内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1024 * 1024) throw new Error("接口响应超过 1 MiB 上限");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"), (key, value, context?: { source?: string }) =>
      ["message_id", "msg_id"].includes(key) && typeof value === "number" && !Number.isSafeInteger(value)
        ? (context?.source ??
          (() => {
            throw new Error("本机 JSON 解析器不能保留完整微信消息编号");
          })())
        : value,
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function api(
  account: Pick<Account, "base" | "token">,
  method: string,
  payload: object = {},
  signal?: AbortSignal,
  testLocal = false,
): Promise<any> {
  const local = new URL(account.base);
  if (!(testLocal && local.hostname === "127.0.0.1" && local.protocol === "http:")) trustedBase(account.base);
  const get = method.startsWith("get_bot_qrcode") || method.startsWith("get_qrcode_status");
  const timeout = /getupdates|get_qrcode_status/.test(method) ? 40_000 : 15_000;
  const response = await fetch(`${account.base}/ilink/bot/${method}`, {
    method: get ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
      "iLink-App-ClientVersion": "1",
      ...(account.token ? { authorization: `Bearer ${account.token}` } : {}),
    },
    ...(!get && { body: JSON.stringify({ ...payload, base_info: { channel_version: "autoloop" } }) }),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`微信接口 HTTP ${response.status}`);
  }
  const value = await boundedJson(response);
  const code = Number(value.errcode || value.ret || 0);
  if (code !== 0) throw new Error(code === -14 ? "微信登录失效，请重新扫码（-14）" : `微信接口未成功（${code}）`);
  return value;
}

export async function send(account: Account, context: string, text: string, id: string, signal?: AbortSignal) {
  if (!context) throw new Error("请先在微信向机器人发一条消息，建立回复上下文");
  if (Buffer.byteLength(text) > 12 * 1024) throw new Error("单条微信文本超过 12 KiB 上限");
  return api(
    account,
    "sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: account.owner,
        client_id: id,
        message_type: 2,
        message_state: 2,
        context_token: context,
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
    signal,
  );
}

export function localHub(url: string, key: string, signal: AbortSignal) {
  const base = new URL(url);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password)
    throw new Error("微信插件只连接本机中台");
  const call = async (method: string, endpoint: string, body?: unknown) => {
    const response = await fetch(base.origin + endpoint, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`本机中台返回 ${response.status}`);
    }
    return boundedJson(response);
  };
  return {
    state: () => call("GET", "/v1/state"),
    event: (event: unknown) => call("POST", "/v1/events", event),
    tell: (key: string, text: string) => call("POST", "/v1/tell", { key, text }),
    cancel: (id: number) => call("POST", `/v1/runs/${id}/cancel`, {}),
  };
}

export function stateFile(accountFile: string) {
  return path.join(path.dirname(accountFile), "state.json");
}
export const exists = existsSync;
