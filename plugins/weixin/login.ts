import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { api, DEFAULT_BASE, loadJson, saveJson, trustedBase } from "./client.ts";

const home = process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop");
const directory = path.join(home, "weixin");
const pending = path.join(directory, "login.json");
const accountFile = path.join(directory, "account.json");
const command = process.argv[2];
const emit = (value: object) => console.log(JSON.stringify(value));
mkdirSync(directory, { recursive: true, mode: 0o700 });
try {
  if (command === "start") {
    // Login material has a single replaceable slot; active account data is never rotated here.
    const qr = await api({ base: DEFAULT_BASE, token: "" }, "get_bot_qrcode?bot_type=3");
    if (typeof qr.qrcode !== "string" || typeof qr.qrcode_img_content !== "string")
      throw new Error("微信未返回有效二维码");
    const created = Date.now();
    const imageFile = path.join(directory, `login-qr-${created}.png`);
    saveJson(pending, { qr: qr.qrcode, created, imageFile });
    writeFileSync(path.join(directory, "qr-content.txt"), qr.qrcode_img_content, { mode: 0o600 });
    rmSync(path.join(directory, "login-qr.png"), { force: true });
    emit({ status: "ready", contentFile: path.join(directory, "qr-content.txt"), imageFile, expiresInSeconds: 300 });
  } else if (command === "wait") {
    const login = loadJson(pending);
    let last = "";
    let settled = false;
    const clearLogin = () => {
      if (loadJson(pending).qr !== login.qr) return;
      for (const file of [pending, path.join(directory, "qr-content.txt"), path.join(directory, "login-qr.png")])
        rmSync(file, { force: true });
      if (
        typeof login.imageFile === "string" &&
        path.dirname(login.imageFile) === directory &&
        /^login-qr-\d+\.png$/.test(path.basename(login.imageFile))
      )
        rmSync(login.imageFile, { force: true });
    };
    while (Date.now() - login.created < 300_000) {
      let value;
      try {
        value = await api(
          { base: DEFAULT_BASE, token: "" },
          `get_qrcode_status?qrcode=${encodeURIComponent(login.qr)}`,
        );
      } catch (error) {
        if ((error as Error).name === "TimeoutError") continue;
        throw error;
      }
      if (value.status === "confirmed") {
        if (![value.bot_token, value.ilink_bot_id, value.ilink_user_id].every((v) => typeof v === "string" && v))
          throw new Error("扫码结果缺少账号或本人身份，未绑定");
        const account = {
          token: value.bot_token,
          account: value.ilink_bot_id,
          owner: value.ilink_user_id,
          base: trustedBase(value.baseurl || DEFAULT_BASE),
        };
        saveJson(accountFile, account);
        clearLogin();
        emit({ status: "confirmed", ownerBound: true });
        settled = true;
        break;
      }
      if (["expired", "cancel", "canceled", "denied"].includes(value.status)) {
        emit({ status: value.status });
        clearLogin();
        settled = true;
        break;
      }
      if (value.status !== last) {
        emit({ status: String(value.status || "wait") });
        last = value.status;
      }
      await delay(1000);
    }
    if (!settled) {
      clearLogin();
      emit({ status: "expired" });
    }
  } else if (command === "status") {
    const account = JSON.parse(readFileSync(accountFile, "utf8"));
    emit({ configured: Boolean(account.token), ownerBound: Boolean(account.owner) });
  } else throw new Error("用法：node login.ts start|wait|status");
} catch (error) {
  emit({ status: "error", message: String((error as Error).message).slice(0, 160) });
  process.exitCode = 1;
}
