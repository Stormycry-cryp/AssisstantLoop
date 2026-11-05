import { ActivityMonitor, nativeScan } from "./activity.ts";
import { systemSnapshot } from "./system.ts";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Bridge, blankState } from "./bridge.ts";
import { api, exists, loadJson, localHub, readAccount, saveJson, send, stateFile } from "./client.ts";
import { Frontdesk } from "./frontdesk.ts";
import { ImageStore } from "./media.ts";

export default async function weixin({
  hub,
  options,
  log,
  signal,
}: {
  hub: any;
  options: Record<string, unknown>;
  log(line: string): void;
  signal: AbortSignal;
}) {
  const home = process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop");
  const accountFile = String(options.accountFile ?? path.join(home, "weixin/account.json"));
  const account = readAccount(accountFile);
  const file = stateFile(accountFile);
  const state = exists(file) ? loadJson(file) : blankState();
  if (state.version !== 1 || typeof state.cursor !== "string" || !Array.isArray(state.processed) || !state.deliveries)
    throw new Error("微信状态文件格式不符，保留原文件等待检查");
  const config = loadJson(path.join(home, "config.json"));
  if (!config.owner || typeof options.sourceKey !== "string") throw new Error("微信缺少本机来源或本人权限配置");
  const localOwner = localHub(config.url, config.owner, signal);
  const activity =
    options.observeLocalAgents === true ? new ActivityMonitor(home, nativeScan(home, signal)) : undefined;
  const owner = {
    ...localOwner,
    state: async () => {
      const view = await localOwner.state();
      if (activity) {
        await activity.refresh(view);
        return { ...view, localActivity: activity.snapshot() };
      }
      return view;
    },
  };
  const source = localHub(config.url, options.sourceKey, signal);
  const frontdesk = new Frontdesk({
    model: String(options.frontdeskModel ?? "deepseek-v4.1-flash"),
    ...(typeof options.frontdeskPiRoot === "string" && { piRoot: options.frontdeskPiRoot }),
    ...(typeof options.frontdeskCredentialFile === "string" && { credentialFile: options.frontdeskCredentialFile }),
    ...(typeof options.frontdeskPersonaFile === "string" && { personaFile: options.frontdeskPersonaFile }),
    signal,
  });
  await frontdesk.start();
  const images = new ImageStore(path.join(home, "work/weixin/attachments"), { signal });
  const bridge = new Bridge(account, state, {
    channel: hub,
    owner,
    source,
    send: (text, id) => send(account, state.context, text, id, signal),
    save: () => saveJson(file, state),
    interpret: (snapshot, images) => frontdesk.interpret(snapshot, images),
    present: (card, snapshot) => frontdesk.present(card, snapshot),
    inspect: systemSnapshot,
    images: (items, id) => images.load(items, id),
  });
  let reports = 0;
  const report = (label: string) => {
    if (reports++ < 10) log(`${label}；凭据和消息正文不写日志`);
  };
  const pause = () => delay(5000, undefined, { signal }).catch(() => {});
  async function receive() {
    while (!signal.aborted) {
      try {
        const page = await api(account, "getupdates", { get_updates_buf: state.cursor }, signal);
        await bridge.batch(page);
      } catch (error) {
        if (signal.aborted) return;
        if (String((error as Error).message).includes("-14")) {
          report("微信登录失效，等待本人重新扫码");
          await source
            .tell(
              "weixin-login-expired",
              "个人微信登录已失效，微信任务入口暂停。请在本机重新扫码连接，已完成的工作不会重做。",
            )
            .catch(() => {});
          while (!signal.aborted) {
            await delay(30_000, undefined, { signal }).catch(() => {});
            const refreshed = readAccount(accountFile);
            if (refreshed.owner !== account.owner || refreshed.account !== account.account)
              throw new Error("重新扫码的账号不同，需要本人重新配置绑定");
            if (refreshed.token !== account.token) {
              Object.assign(account, refreshed);
              state.context = "";
              state.cursor = "";
              saveJson(file, state);
              break;
            }
          }
          continue;
        }
        report("微信接收暂未成功，保留游标稍后重连");
        await pause();
      }
    }
  }
  async function deliver() {
    while (!signal.aborted) {
      let card: any;
      try {
        ({ card } = await hub.nextCard(50));
        if (!card) continue;
        await bridge.deliver(card);
      } catch {
        if (signal.aborted) return;
        if (card) await hub.failed(card.id, card.version, "微信投递未确认，请核实登录与回复上下文").catch(() => {});
        report("微信投递暂未成功，原卡片仍保留");
        await pause();
      }
    }
  }
  async function observe() {
    if (!activity) return;
    while (!signal.aborted) {
      try {
        if (options.notifyObservedCompletions === false) await activity.refresh(await localOwner.state());
        else await activity.tick(await localOwner.state(), source.tell);
      } catch {
        if (!signal.aborted) report("本机会话状态暂未确认，保留待汇报记录");
      }
      await delay(15000, undefined, { signal }).catch(() => {});
    }
  }
  try {
    await Promise.all([receive(), deliver(), observe()]);
  } finally {
    await frontdesk.close();
    saveJson(file, state);
  }
}
