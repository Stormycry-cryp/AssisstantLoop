import type { State } from "./bridge.ts";
import type { Image } from "./media.ts";

export type Action = {
  kind: "answer" | "stop" | "start" | "followup";
  card: number | null;
  choice: number | null;
  run: number | null;
  agent: "codex" | "pi" | null;
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
    { subject: string; agent: "codex" | "pi"; title: string; state: string; summary: string; run: number }
  >();
  for (const run of view.runs ?? []) {
    const agent = run.agent === "codex" ? "codex" : run.agent === "pi-opus" ? "pi" : null;
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
    localTime: local,
    timezone: "Asia/Shanghai",
    memories: (state.dialogue?.memories ?? []).slice(-32),
    night: { key: nightKey, mayRemind: (hour >= 23 || hour < 6) && state.dialogue?.sleepNight !== nightKey },
    selectedAgent: state.selected,
    allowedStartAgents: ["codex", ...(allowPi ? ["pi"] : [])],
    history: [...(state.dialogue?.history ?? [])]
      .sort((a, b) => a.at - b.at)
      .slice(-24)
      .map(({ role, text }) => ({ role, text })),
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
