// A public install must personalize before contacting WeChat, keep personal data
// out of the checkout, and survive a skipped or interrupted connection without rebinding.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { configurePersona, configureWeixin, PRESETS } from "../cli/onboarding.ts";
import { contextFor } from "../plugins/weixin/frontdesk.ts";
import { makeSnapshot } from "../plugins/weixin/conversation.ts";
import { blankState } from "../plugins/weixin/bridge.ts";

test("public onboarding: choose style, name and address before WeChat; keep editable persona private", async () => {
  const home = mkdtempSync(join(tmpdir(), "assistant-persona-"));
  const prompts: string[] = [],
    replies = ["2", "小林", "阿明"];
  try {
    const p = await configurePersona(home, async (q) => {
      prompts.push(q);
      return replies.shift()!;
    });
    assert.equal(p.style, "professional");
    assert.equal(p.name, "小林");
    assert.equal(p.owner, "阿明");
    assert.equal(PRESETS.length, 3);
    const file = join(home, "persona.md");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, "utf8"), /小林/);
    assert.ok(prompts.every((q) => !q.includes("微信")));
    const preserved = await configurePersona(home, async () => {
      throw new Error("existing profile must survive an update");
    });
    assert.deepEqual(preserved, p);
    const snapshot = makeSnapshot("在吗", blankState(), { cards: [], runs: [] });
    assert.match(contextFor(snapshot, [], readFileSync(file, "utf8")).systemPrompt, /阿明/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("public onboarding: bound WeChat gets its own rules and keys; reruns preserve all existing configuration", () => {
  const home = mkdtempSync(join(tmpdir(), "assistant-binding-"));
  let keys = 0;
  try {
    const config: any = {
      url: "http://127.0.0.1:3360",
      owner: "owner-key",
      channels: { desktop: { key: "desktop-key" } },
    };
    const rules: any = {
      sources: { local: { name: "本机" } },
      agents: { codex: { worker: "test", use: "codex" } },
      channels: { desktop: { name: "桌面通知" } },
      rules: [{ name: "原有规则" }],
    };
    configureWeixin(
      home,
      config,
      rules,
      { owner: "wx-owner", account: "bot", token: "private", base: "https://ilinkai.weixin.qq.com" },
      () => `key-${++keys}`,
    );
    assert.equal(keys, 2);
    assert.deepEqual(rules.channels.weixin.answerers, ["wx-owner"]);
    assert.equal(rules.rules[0].name, "原有规则");
    assert.equal(rules.rules[1].cwd, join(home, "work/weixin"));
    assert.equal(config.channels.weixin.frontdeskPersonaFile, join(home, "persona.md"));
    assert.match(rules.rules[1].prompt, /同一件事/);
    configureWeixin(
      home,
      config,
      rules,
      { owner: "wx-owner", account: "bot", token: "private", base: "https://ilinkai.weixin.qq.com" },
      () => `key-${++keys}`,
    );
    assert.equal(keys, 2);
    assert.equal(rules.rules.length, 2);
    assert.throws(
      () =>
        configureWeixin(
          home,
          config,
          rules,
          { owner: "another", account: "bot", token: "x", base: "https://ilinkai.weixin.qq.com" },
          () => "key",
        ),
      /绑定/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("public onboarding: keyless installation can choose a persona and defer WeChat in an isolated home", () => {
  const home = mkdtempSync(join(tmpdir(), "assistant-setup-"));
  try {
    const run = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "../bin/assisstantloop.ts"),
        "setup",
        "--preset",
        "concise",
        "--name",
        "小助理",
        "--owner",
        "你",
        "--skip-weixin",
        "--no-service",
        "--command",
        "true",
        "--port",
        "3399",
      ],
      {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: join(home, "rules.json") },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /人设/);
    assert.match(run.stdout, /稍后|尚未|以后/);
    assert.ok(readFileSync(join(home, "persona.md"), "utf8").includes("小助理"));
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(config.channels.weixin, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
