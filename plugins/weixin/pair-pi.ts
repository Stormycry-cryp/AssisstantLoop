import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
if (process.argv[2] !== "--run")
  throw new Error("用法：node plugins/weixin/pair-pi.ts --run，登记仅查看会话的本机 Pi 客户端");
const prefix = process.env.OPUS_AGENT_HOME ?? path.join(homedir(), ".local/share/opus-agent");
const home = process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop");
const file = path.join(home, "local-activity/pi-read.json");
if (existsSync(file)) throw new Error("已有只读连接配置，保留原凭据，请先核实原连接");
const { mintPairingCode } = await import(
  pathToFileURL(path.join(prefix, "provider/current/node_modules/@mgabor3141/pi-durable-t3/dist/bridge.js")).href
);
const { code } = mintPairingCode(path.join(prefix, "webui/t3"));
const response = await fetch("http://127.0.0.1:3774/oauth/token", {
  method: "POST",
  redirect: "error",
  signal: AbortSignal.timeout(10000),
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: code,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:t3:params:oauth:token-type:access_token",
    scope: "orchestration:read",
    client_label: "AutoLoop local activity (read only)",
    client_device_type: "bot",
  }),
});
const token = await response.json();
if (!response.ok || token.scope !== "orchestration:read" || typeof token.access_token !== "string")
  throw new Error("Pi 没有确认仅查看会话的权限，不保存此连接");
mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(
  file + ".tmp",
  JSON.stringify({ token: token.access_token, scope: token.scope, expiresAt: Date.now() + token.expires_in * 1000 }) +
    "\n",
  { mode: 0o600 },
);
renameSync(file + ".tmp", file);
console.log("Pi 已登记仅查看会话的连接，没有执行或修改线程的权限");
