# 安装与首次引导

这是 AssisstantLoop 公开版，包含 AutoLoop 内核和独立 Pi 前台。请按顺序完成引导，不把作者的私人身份、经历、偏好或模型凭据带给新用户。

## 给协助安装的 Agent

1. 先读 README、项目 AGENTS、协议和微信插件说明，检查 Node.js 24+、Git、npm 与可用的 Codex CLI。
2. 安装程序后，**先让用户选自己的助理人设**：简洁直接、专业有条理、温和自然；再问名字和希望如何称呼。给选项，不能替用户把作者的人设照搬过来。
3. 用 `assisstantloop setup` 写入本机人设，之后才引导连接微信。用户已经回答的选项直接带入，不重复询问。
4. 微信可以选择现在连接或稍后。现在连接时，由用户提供自己的 Agent Plan Key，在终端隐藏输入；不要让用户把 Key 发在聊天里，也不要把 Key 放到命令参数或日志。
5. 从微信的“我 → 设置 → 插件 → ClawBot”扫码，由用户亲自确认。不得复制别人账号、绕过扫码、或为演示启动同一账号的第二个监听。
6. 检查本机服务、任务规则、本人绑定与消息往返。用户需要作选择时转给用户；解释正常结果和真正的新情况，不反复问同一个问题。

示例：已知道用户的选择后，可以用以下形式跳过重复的人设询问。不要替真实用户预选示例内容。

```sh
assisstantloop setup --preset concise --name 小助理 --owner 你
```

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/Stormycry-cryp/AssisstantLoop/main/install.sh | sh
```

首次向导顺序为：人设 → 名字与称呼 → 初始化任务中台 → 选择微信连接 → Agent Plan Key → 固定 Pi 运行库 → 本地二维码 → 本人扫码 → 规则与后台服务。

脚本通过 `/dev/tty` 在终端完成交互，支持 `curl | sh`。没有交互终端的环境必须先收集真实用户的选择，再显式传参；不能因为没有终端就默认同意扫码、使用演示 Key 或修改系统权限。

只先安装并保存人设、不接微信、不注册后台服务：

```sh
sh install.sh --preset concise --name 小助理 --owner 你 --skip-weixin --no-service
```

首次向导默认用 Codex CLI。高级使用者可通过 `--command '你的命令 {prompt}'` 指定本机接单命令，权限由该命令实际执行环境决定。此选项不为任意程序提供沙箱，也不扩大已授权目录。

## 本机数据与恢复

- 默认数据目录为 `~/.assisstantloop`，默认端口 `3360`。不导入已有 AutoLoop 或个人助理的账号。
- 使用 `AGENT_AUTOLOOP_HOME=/自选目录` 可独立安装；后续运行同一环境变量。服务名按数据目录区分。
- 人设与名字在数据目录中，更新不覆盖；用 `assisstantloop persona` 重选，或编辑 `persona.md`，再 `assisstantloop service install` 重新加载。
- 微信稍后继续用 `assisstantloop weixin`；扫码过期可重新生成。首次成功后在微信发一句消息，刷新回复上下文。
- 模型 Key 存在 `agent-plan.env`，微信账号在 `weixin/account.json`，0600。不要读取、打印或提交其内容。
- 不能把不明账号绑定到原状态上。要更换使用者，先保全、核对原账号与任务状态，不能直接覆盖。
- Pi SDK 固定为 `@earendil-works/pi-ai@1.4.0`，二维码工具为 `qrcode-terminal@0.12.0`，存在独立 `pi-runtime`，不会复制用户的 Opus App 或 Codex 登录。
- 默认任务目录为 `work/weixin`，图片在其 `attachments`。这些是用户资料，不能当成实验缓存自动清理。

## 验收

```sh
assisstantloop doctor
assisstantloop status
assisstantloop try
```

在微信里检查普通聊天、一个小任务、提问与自然回答、结果汇报，以及图片与后续文字续接。只把已验证的部分说成通过，其他账号和平台可用性不能由单元测试代替。

允许主动汇报新进展、新结果和新风险。同一回执的提问、结案和摘要不应重复转述；已经问过的问题等待用户回复，不反复催同一份资料。能力确认（如“看不到图？”）不重复派新任务。

调试用假模型、临时数据目录和随机端口；不要拿已在线微信账号再开一个监听。

## 更新与卸载

```sh
assisstantloop update
assisstantloop uninstall --yes
```

更新只更新程序并重启本安装，不覆盖本地人设与账号；安装源码有未保存改动时会停止更新。卸载移除本项目的程序、服务和自己的命令链接，保留账号、人设、任务记录、图片与运行库等数据，是否删除由用户确认。

开发检查与内核边界见 [AGENTS.md](AGENTS.md)。原始核心安装器保存在 `scripts/install-core.sh`，只用于上游兼容检查；公开版用户使用根目录安装器和 `assisstantloop setup`。
