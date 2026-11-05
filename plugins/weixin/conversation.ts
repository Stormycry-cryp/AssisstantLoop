import type { State } from "./bridge.ts";
import type { Activity } from "./activity.ts";
import type { Image } from "./media.ts";

export type Action = {
  kind: "answer" | "stop" | "start" | "followup";
  card: number | null;
  choice: number | null;
  run: number | null;
  agent: "codex" | "pi" | "desktop" | null;
  subject: string | null;
  title: string | null;
};
export type Decision = {
  reply: string;
  actions: Action[];
  remember?: string[];
  sleepNudge?: string | null;
  imageSummary?: string;
  useRecentImages?: boolean;
  quiet?: boolean;
};
export type Dialogue = {
  history: { id: string; role: "user" | "assistant"; text: string; at: number }[];
  memories?: string[];
  sleepNight?: string;
  latestImages?: { items: Omit<Image, "data">[]; summary: string; at: number };
  pending?: {
    id: string;
    bodyHash: string;
    plan: Decision;
    index: number;
    replied: boolean;
    nightKey?: string;
    inspection?: string;
    attachments?: { items: Omit<Image, "data">[]; summary: string };
  };
};
export type Snapshot = ReturnType<typeof makeSnapshot> & {
  images?: { mimeType: string; sha256: string }[];
  notification?: {
    kind: string;
    state: string;
    title: string;
    text: string;
    options: string[];
    recommend: number | null;
    result: string | null;
  };
};

export function makeSnapshot(message: string, state: State, view: any, now = Date.now()) {
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(now);
  const hour = Number(local.slice(11, 13));
  const nightKey = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short" }).format(
    now - (hour < 6 ? 86400_000 : 0),
  );
  const targets = new Map<
    string,
    { subject: string; agent: "codex" | "pi" | "desktop"; title: string; state: string; summary: string; run: number }
  >();
  for (const run of view.runs ?? []) {
    const agent =
      run.agent === "codex"
        ? "codex"
        : run.agent === "pi-opus"
          ? "pi"
          : run.agent === "codex-desktop"
            ? "desktop"
            : null;
    if (!agent) continue;
    const event = run.events?.find((event: any) => event.source === "weixin" && /^wx-[a-z0-9-]+$/.test(event.subject));
    if (event && !targets.has(event.subject))
      targets.set(event.subject, {
        subject: event.subject,
        agent,
        title: (event.summary || run.summary || run.rule).slice(0, 160),
        state: run.state,
        summary: (run.summary || run.error || "").slice(0, 800),
        run: run.id,
      });
    if (targets.size >= 20) break;
  }
  const known = [...targets.values()];
  const allowPi = state.selected === "pi" || /\b(pi|opus)\b|欧普斯/i.test(message);
  const allowDesktop =
    (view.agents ?? []).some((a: any) => a.id === "codex-desktop" && a.use === "codex-desktop") &&
    (state.selected === "desktop" || /桌面|desktop/i.test(message));
  const external = view.localActivity as { sessions: Activity[]; issues: string[]; since?: number } | undefined;
  const since = external?.since ?? now;
  const includeHistory = /历史|以前|之前|上次|过去|做过|前几天|昨天/.test(message);
  const isHistorical = (s: Activity) =>
    (s.status === "unknown" && (!s.turn || !(s.updatedAt! >= since))) ||
    (["completed", "interrupted", "failed", "cancelled"].includes(s.status) &&
      !(Number.isFinite(s.completedAt) && s.completedAt! > since));
  return {
    message,
    ...(state.dialogue?.latestImages &&
      now - state.dialogue.latestImages.at < 86400_000 && {
        recentImages: {
          summary: state.dialogue.latestImages.summary,
          receivedAt: new Date(state.dialogue.latestImages.at).toISOString(),
          items: state.dialogue.latestImages.items.map(({ mimeType, sha256 }) => ({ mimeType, sha256 })),
        },
      }),
    ...(external && {
      externalActivity: {
        sessions: [...external.sessions]
          .filter((s) => includeHistory || !isHistorical(s))
          .sort(
            (a, b) =>
              Number(b.status === "running") - Number(a.status === "running") ||
              (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
          )
          .slice(0, 40)
          .map((s) => ({
            provider: s.provider,
            app: s.app,
            machine: s.machine,
            model: s.model,
            title: s.title,
            status: s.status,
            summary: s.summary,
            project: s.project,
            completedAt: Number.isFinite(s.completedAt)
              ? new Date(s.completedAt!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
              : null,
            historical: isHistorical(s),
          })),
        unconfirmedHistoryCount: external.sessions.filter((s) => s.status === "unknown" && isHistorical(s)).length,
        issues: external.issues,
        scope: "本机最近的 Codex 与 Pi 会话，只读观察，未导入为可控制事项",
      },
    }),
    localTime: local,
    timezone: "Asia/Shanghai",
    memories: (state.dialogue?.memories ?? []).slice(-32),
    night: { key: nightKey, mayRemind: (hour >= 23 || hour < 6) && state.dialogue?.sleepNight !== nightKey },
    selectedAgent: state.selected,
    allowedStartAgents: ["codex", ...(allowPi ? ["pi"] : []), ...(allowDesktop ? ["desktop"] : [])],
    history: [...(state.dialogue?.history ?? [])]
      .sort((a, b) => a.at - b.at)
      .slice(-24)
      .map(({ id, role, text }) => ({
        role,
        text,
        ...((state.invalidatedNotices ?? []).slice(-64).some((n) => id?.startsWith(`card-${n}-`)) && {
          corrected: true,
          correction: "这条助手消息已由后续核实更正，不能作为当前任务状态；相关历史会话已经结束，不代表新进展",
        }),
      })),
    questions: (view.cards ?? [])
      .filter((card: any) => card.state === "open" && state.deliveries[String(card.id)])
      .slice(0, 20)
      .map((card: any) => ({
        id: card.id,
        title: card.title,
        question: card.text,
        options: card.options,
        recommend: card.recommend ?? null,
        kind: card.kind,
      })),
    targets: known,
    activeRuns: (view.runs ?? [])
      .filter(
        (run: any) =>
          ["claimed", "queued", "unknown"].includes(run.state) &&
          run.events?.some(
            (event: any) => event.source === "weixin" && known.some((target) => target.subject === event.subject),
          ),
      )
      .map((run: any) => ({ id: run.id, state: run.state, summary: run.summary || run.rule })),
    totals: {
      running: view.totals?.running ?? 0,
      queued: view.totals?.queued ?? 0,
      doneToday: view.totals?.doneToday ?? 0,
    },
  };
}

// Punctuation and progress pings do not authorize another round of work.
export function progressReply(snapshot: Snapshot): string | undefined {
  if (
    !/^(?:[?？]+|(?:查得|做得|处理得)?怎么样了|结果呢|进度呢|进展呢|有结果了吗|查好了吗|还没好吗)[?？!！\s]*$/.test(
      snapshot.message.trim(),
    )
  )
    return;
  const active = snapshot.activeRuns[0];
  if (active) {
    if (active.state === "queued") return "这件事还在排队\n" + active.summary;
    if (active.state === "unknown") return "执行状态还没确认\n我还不能说已经完成";
    return "这件事还在处理中\n" + active.summary;
  }
  const external = snapshot.externalActivity;
  const running = external?.sessions.filter((s: any) => s.status === "running") ?? [];
  if (running.length)
    return (
      "本机还有任务正在运行\n" +
      running
        .slice(0, 3)
        .map((s: any) => `${s.app ?? (s.provider === "pi" ? "Opus Agent" : "Codex")} · ${s.project ?? s.title}`)
        .join("\n")
    );
  if (external?.issues.length) return "本机有部分会话状态暂时读不到\n我还不能断言全部任务都结束了";
  const last = snapshot.targets[0];
  if (!last) return "目前没有已交办的任务在跑\n也没有新的执行结果";
  if (last.state === "failed") return "上次任务没完成\n" + last.summary;
  if (last.state === "cancelled") return "上次任务已经停止\n" + last.summary;
  if (/^待你处理[:：]/.test(last.summary)) return "上次任务卡在这里\n" + last.summary.replace(/^待你处理[:：]\s*/, "");
  return "上次任务已经结束\n" + (last.summary || "没有返回可核实的结果");
}

export function parseDecision(value: any, snapshot: Snapshot): Decision {
  const fail = (): never => {
    throw new Error("前台返回了超出当前会话权限或格式的决定");
  };
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (key) =>
        !["reply", "actions", "remember", "sleepNudge", "imageSummary", "useRecentImages", "quiet"].includes(key),
    ) ||
    typeof value.reply !== "string" ||
    (!value.reply.trim() && value.quiet !== true) ||
    value.reply.length > 500 ||
    !Array.isArray(value.actions) ||
    value.actions.length > 3
  )
    fail();
  if (value.quiet !== undefined && (typeof value.quiet !== "boolean" || (value.quiet && !snapshot.notification)))
    fail();
  if (
    value.quiet &&
    (value.reply !== "" || (snapshot.notification?.kind === "ask" && snapshot.notification.state === "open"))
  )
    fail();
  if (
    value.imageSummary !== undefined &&
    (!snapshot.images?.length ||
      typeof value.imageSummary !== "string" ||
      !value.imageSummary.trim() ||
      value.imageSummary.length > 3000)
  )
    fail();
  if (snapshot.images?.length && !value.imageSummary?.trim()) fail();
  if (
    value.useRecentImages !== undefined &&
    (typeof value.useRecentImages !== "boolean" ||
      (value.useRecentImages && (!snapshot.recentImages || snapshot.images?.length)))
  )
    fail();
  if (
    snapshot.notification &&
    (value.actions.length || value.remember?.length || value.sleepNudge || value.imageSummary || value.useRecentImages)
  )
    fail();
  if (
    value.remember !== undefined &&
    (!Array.isArray(value.remember) ||
      value.remember.length > 3 ||
      value.remember.some((item: any) => typeof item !== "string" || !item.trim() || item.length > 80))
  )
    fail();
  if (value.sleepNudge != null && (typeof value.sleepNudge !== "string" || Array.from(value.sleepNudge).length > 30))
    fail();
  const seen = new Set<string>();
  for (const action of value.actions) {
    const keys = ["kind", "card", "choice", "run", "agent", "subject", "title"];
    if (
      !action ||
      typeof action !== "object" ||
      Object.keys(action).length !== keys.length ||
      keys.some((key) => !(key in action))
    )
      fail();
    if (action.kind === "answer") {
      const question = snapshot.questions.find((question: any) => question.id === action.card);
      if (!question || action.run !== null || action.agent !== null || action.subject !== null || action.title !== null)
        fail();
      if (
        action.choice !== null &&
        (!Number.isInteger(action.choice) || action.choice < 0 || action.choice >= question.options.length)
      )
        fail();
    } else if (action.kind === "stop") {
      if (
        !snapshot.activeRuns.some((run: { id: number }) => run.id === action.run) ||
        action.card !== null ||
        action.choice !== null ||
        action.agent !== null ||
        action.subject !== null ||
        action.title !== null
      )
        fail();
    } else if (action.kind === "start") {
      if (
        !snapshot.allowedStartAgents.includes(action.agent) ||
        typeof action.title !== "string" ||
        !action.title.trim() ||
        action.title.length > 80 ||
        action.card !== null ||
        action.choice !== null ||
        action.run !== null ||
        action.subject !== null
      )
        fail();
    } else if (action.kind === "followup") {
      const target = snapshot.targets.find((target) => target.subject === action.subject);
      if (
        !target ||
        target.agent !== action.agent ||
        action.card !== null ||
        action.choice !== null ||
        action.run !== null ||
        action.title !== null
      )
        fail();
    } else fail();
    const key = `${action.kind}:${action.card ?? action.run ?? action.subject ?? action.title}`;
    if (seen.has(key)) fail();
    seen.add(key);
  }
  return value as Decision;
}
