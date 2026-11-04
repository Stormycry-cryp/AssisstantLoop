#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { homedir } from "node:os";
import path from "node:path";

process.env.AGENT_AUTOLOOP_HOME ??= path.join(homedir(), ".assisstantloop");
const command = process.argv[2];
try {
  if (["setup", "persona", "weixin"].includes(command)) {
    await (await import("../cli/onboarding.ts")).onboard(command, process.argv.slice(3));
  } else {
    if (!command || command === "help" || command === "--help")
      console.log(
        "AssisstantLoop\n  assisstantloop setup     先选人设，再连接个人微信\n  assisstantloop persona   修改本地人设\n  assisstantloop weixin    连接或恢复个人微信\n其他命令兼容 AutoLoop：status、try、up、service、update、uninstall\n",
      );
    else await import("../cli/main.ts");
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
