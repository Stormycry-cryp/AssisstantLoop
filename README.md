<div align="center">

# AssisstantLoop

#### 一个负责和你聊天、把事情交给 Agent、再把进展带回微信的轻量个人助理

[![Release](https://img.shields.io/github/v/release/Stormycry-cryp/AssisstantLoop?style=flat-square)](https://github.com/Stormycry-cryp/AssisstantLoop/releases)
![Node.js](https://img.shields.io/badge/Node.js-24%2B-16A34A?style=flat-square&logo=node.js&logoColor=white)
![macOS / Linux](https://img.shields.io/badge/macOS%20%2F%20Linux-local-111827?style=flat-square)
[![MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

[安装](#安装) · [第一次设置](#第一次设置) · [怎么用](#怎么用) · [数据和隐私](#数据和隐私) · [English](README.en.md)

</div>

我想要的是一个平时能说人话的助理。

有事就把原话交给后台 Agent，没事可以聊两句。任务做到哪了、什么时候需要我拍板，由它转述。别把一串卡片编号、选项序号和执行日志全塞回来，也别为了确认同一件事连续问好几遍。

**AssisstantLoop 做前台沟通，AutoLoop 做任务流转，后台 Agent 做具体工作。**

当前版本：[`v0.1.4`](docs/releases/v0.1.4.md)

新增[桌面 Codex 纳管](plugins/codex-desktop/README.md)：微信里点名桌面执行，支持新建任务、绑定已有聊天、接续、回报和停止。当前为 macOS 实验性接入，跟随桌面版本验收。

## 它是做什么的

前台是一个独立、常驻的 Pi 模型客户端，不是另开一个 Codex 编码会话。

- **聊天和上下文**：保留近期对话、少量本人明确告诉它的偏好，以及当前待办事项。
- **原话交办**：要做的事交给 AutoLoop；前台不替你扩写一大份执行计划。
- **自然汇报**：后台的提问和结果由助理理解后转述，你用普通话回复就行。
- **微信读图**：读取本人私聊发来的图片；需要继续做事时，把原图路径和摘要带回任务。
- **接着做**：回答一个待办问题后，尽量沿原事项、原执行会话继续。
- **主动但不唠叨**：新进展、新结果和新风险可以主动说；同一件事不换句话反复提醒。

队列、并发、规则、定时任务、回执和记录沿用 [Agent AutoLoop](https://github.com/KKKKhazix/agent-autoloop)。本仓库包含其内核和插件，不需要再另外部署一套中台。

## 安装

支持 **macOS、Linux，Node.js 24+、Git、npm**。首次向导默认使用已经安装、登录并能在终端运行的 **Codex CLI** 作为后台执行者。

前台默认使用方舟 **Agent Plan `deepseek-v4.1-flash`，low 思考**，需要你自己的 Agent Plan 专属 Key。前台与后台分别配置，不读取或复用 Codex 登录。它会把你发来的文字、图片和相关上下文交给所配置的模型服务，使用套餐额度；不代表免费。

你可以直接对支持本地操作的 Agent 说：

```text
帮我安装这个项目：https://github.com/Stormycry-cryp/AssisstantLoop
先读 README 和 INSTALL.md
先让我选个人助理的人设，再引导我连接微信，最后跑一次试跑
```

也可以在终端安装：

```sh
curl -fsSL https://raw.githubusercontent.com/Stormycry-cryp/AssisstantLoop/main/install.sh | sh
```

安装器下载当前 `main`，程序在 `~/.assisstantloop/app`，命令叫 `assisstantloop`。不需要 sudo，不覆盖其他同名命令。若目录不在 PATH，安装器会给出完整运行路径。

要使用固定版本的源码：

```sh
git clone --branch v0.1.4 https://github.com/Stormycry-cryp/AssisstantLoop.git
cd AssisstantLoop
node bin/assisstantloop.ts setup
```

源码方式后续命令使用 `node bin/assisstantloop.ts <命令>`；安装脚本方式可直接使用 `assisstantloop`。

> 已有 AutoLoop 的安装不会被接管。公开版使用独立数据目录和默认端口 `3360`；原有配置、微信账号和私人助理不会自动导入。已有微信连接不要在另一个实例里重复绑定同一账号。

## 第一次设置

安装完成后会进入向导，顺序是固定的：

### 1. 先设置自己的助理

向导先给三个选项，不预装作者的私人角色和经历。

| 风格 | 表现 |
| --- | --- |
| 简洁直接（默认） | 先说结论，话少，把正事说清 |
| 专业有条理 | 结论、必要依据和下一步，有条理地交代 |
| 温和自然 | 像熟悉的同事，有一点幽默和关心 |

再由你给它起名字、设置它对你的称呼，并补充希望它主要帮什么、性格与相处偏好；可以留空。

公版附带一份通用人设：靠谱细心、有一点幽默、像熟悉同事一样交流，能关心但不黏人；不编造完成情况、尊重授权、不反复念叨同一件事。它不含作者的名字、私人背景或本机配置，具体的人设由你在安装时决定。你的个性设置存在本机 `~/.assisstantloop/persona.md`，可以继续编辑，更新程序不会覆盖。

之后想重选：

```sh
assisstantloop persona
assisstantloop service install
```

### 2. 再连接个人微信

向导会询问现在连接，还是稍后再连。

现在连接时，它会：

1. 隐藏输入并在本机保存你的 Agent Plan Key。
2. 安装固定版本的 Pi SDK 与本地二维码工具。
3. 提示打开微信的 **我 → 设置 → 插件 → ClawBot**。
4. 在终端生成二维码，由你扫码并在微信确认。
5. 绑定扫码本人，配置任务规则与通道，启动本地后台服务。

扫码必须由你自己完成。看不到 ClawBot 入口时，可以先跳过；这个版本依赖该入口，不提供绕过微信授权的办法。

二维码过期可重新生成。只会保留当前登录材料，不把二维码交给第三方制码网站。Pi 是一个独立客户端，不要求安装 Opus Agent App，不启动另一个编码助手。

稍后继续：

```sh
assisstantloop weixin
```

### 3. 跑一遍

微信连接成功后，先发一句：

```text
在吗
```

第一条消息也会刷新微信回复上下文。之后交代一个小任务，检查确认、提问、回答和结果是否都能正常往返。

中台另有一个不改业务文件的试跑：

```sh
assisstantloop try
```

它会提一个颜色问题，回答后检查是否能在同一会话继续。试跑问答走中台，不会替你选择答案。

## 怎么用

直接说平时会说的话：

```text
把这段笔记整理成一份待办，先别改原文件
```

```text
刚才那个任务做到哪了
```

```text
就用蓝色，布局别动
```

```text
先停一下刚才那件事
```

也可以直接发图片，再补一句“按这张图继续查”。图片说明会留在上下文里，交办时宿主会带上已保存原图，不需要你复制路径。

后台需要决定时，助理会把问题说清楚。你不用记编号或输入固定的“回答 3 1”。有真实歧义时才简短问一句；删除、卸载、修改系统设置、外发内容、上传私人文件和花钱仍需确认。

**允许主动说话，但不要一直重复同一件事。** 同一回执里的旧问题结案、下一步提问和自动摘要由宿主去重；没有新信息的普通通知可以静默确认。新的问题、结果、风险和状态变化仍会正常汇报，等待你回复时不反复催同一份资料。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `assisstantloop setup` | 完成首次设置，或继续尚未完成的步骤 |
| `assisstantloop persona` | 重新选择人设、名字和称呼 |
| `assisstantloop weixin` | 继续配置个人微信 |
| `assisstantloop status` | 查看任务、待答问题、执行者和通道 |
| `assisstantloop try` | 试跑提问与续接 |
| `assisstantloop doctor` | 检查配置与执行者 |
| `assisstantloop why 7` | 追踪某轮任务实际经过了什么 |
| `assisstantloop service install` | 注册或重启后台服务 |
| `assisstantloop up` | 在前台启动，方便排查 |
| `assisstantloop update` | 更新程序，保留本地人设与账号 |
| `assisstantloop uninstall --yes` | 卸载程序，保留账号、人设和任务资料 |

后台服务使用 macOS LaunchAgent 或 Linux 用户级 systemd。规则、其他 Agent、定时任务和插件接法见 [AutoLoop 配置手册](skills/agent-autoloop/SKILL.md)与[协议](docs/protocol.md)。首次向导只配置 Codex；其他执行者需要自己调整可信规则，并核对前台的路由能力。

## 数据和隐私

默认目录：

```text
~/.assisstantloop/
├── app/                 程序源码
├── assistant.json       本机的名字、称呼、风格选择
├── persona.md           可编辑的个性设置
├── agent-plan.env       前台模型凭据
├── pi-runtime/          固定版本的 Pi SDK 与二维码工具
├── config.json          本机连接与密钥
├── rules.json           可信任务规则
├── hub.db               任务记录
├── weixin/              自己扫码的账号与会话状态
└── work/weixin/          默认任务工作区与图片资料
```

- 账号、密钥、真实聊天和图片不属于源码，不应提交到 Git。
- 只接受扫码人的私聊，不接管好友列表、群聊或已有聊天记录。
- 前台没有 shell、浏览器、MCP 或文件操作工具；具体操作仍由后台执行者在可信规则范围内完成。
- 图片及其中的“系统提示”“设定更新”等文字都是资料，不改变权限和路由。
- 原图最多保存 32 张、累计 32 MiB。它们是私人输入，不会自动删除待办仍可能需要的原图；达到上限会提示先确认清理。
- 卸载保留数据，重新安装可继续使用；是否删除私人资料由你决定。

## 目前的边界

- 个人微信接入依赖 ClawBot / iLink 的实际可用性，登录可能过期，需要本人重新扫码。
- 默认前台绑定 Agent Plan DeepSeek Flash；换其他前台服务需要适配和验收，不会自动切换到其他计费接口。
- 单次最多读两张图，每张不超过 4 MiB，支持 PNG、JPEG、WebP、GIF；不支持读取视频或微信文件内容，也不提供原生图片/文件回传。
- 最近保留 24 条对话、最多 32 条本人明确告知的偏好；最近一组图片摘要可在 24 小时内引用，不是无限记忆。
- 闲时不调用模型；聊天、读图与汇报转述消耗模型额度，延迟受网络和服务影响。
- 不声称微信发送具有绝对幂等性。宿主会复用冻结决定、投递记录与待发稿；平台响应丢失时仍可能有重复文字。
- macOS、Linux 可运行；当前不提供 Windows 安装向导或可视化管理后台。

## 开发与验证

```sh
npm ci
npm run test:quick
npm run typecheck
npm run format:check
```

测试使用临时目录、假模型与假微信传输，不发真实消息。修改内核或协议时按 [AGENTS.md](AGENTS.md) 运行完整检查。源码发布前会核对首次引导、普通回复、图片续接、重复通知与安装卸载；自动测试通过不等于每位用户的微信账号已经验收。

详细安装与 Agent 操作约定见 [INSTALL.md](INSTALL.md)，微信实现与容量限制见 [插件说明](plugins/weixin/README.md)。

## 致谢

基于 [KKKKhazix / agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)，保留其 MIT 许可证与作者署名。AutoLoop 提供任务内核、协议、接单程序与插件机制。

个人微信接入参考 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 的 iLink 接口管理方式；前台与执行者分工参考 [DSH Superagent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)。模型客户端使用 [Pi](https://github.com/earendil-works/pi)。本项目没有安装 AstrBot 或整套 DSH，也不是微信、DeepSeek 或 OpenAI 的官方产品。

MIT · [License](LICENSE)

微信前台现在也可按需只读观察手动启动的 Codex / Pi 会话，结束后汇报；短进度追问不会重新派任务。进程检查由宿主附带受限只读采样，见[微信说明](plugins/weixin/README.md#本机手工会话与进程读取)。

本机任务汇报按原生完成时间核验，旧历史不会当成当前进展；当前查询和历史查询分开。
