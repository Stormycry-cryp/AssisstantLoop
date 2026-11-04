# AssisstantLoop

[中文说明](README.md)

A small personal assistant for natural conversation, image input and task handoff through personal WeChat. An independent Pi front desk talks with you; the included AutoLoop kernel queues, resumes and records work; a backend agent performs it.

Current release: **v0.1.1**. macOS / Linux, Node.js 24+, Git and npm. The first-run wizard uses an installed, authenticated Codex CLI as its backend. The independent front desk uses your own Volcengine Agent Plan key with `deepseek-v4.1-flash` and low reasoning; it does not reuse Codex authentication.

```sh
curl -fsSL https://raw.githubusercontent.com/Stormycry-cryp/AssisstantLoop/main/install.sh | sh
```

The wizard asks for a persona first: concise, professional or warm. Choose the assistant's name, how it addresses you, and optional responsibilities or personal style preferences. A generic template supplies a reliable, slightly humorous colleague-like tone without the author's identity or local settings. Personal settings stay in `~/.assisstantloop/persona.md`, outside the checkout, and survive updates. Next, choose whether to link WeChat now or later. A key is entered privately, the pinned Pi SDK and terminal QR tool are installed, and the user scans through WeChat's ClawBot entry. Login confirmation must be performed by the user.

```sh
assisstantloop persona       # Change your personal settings
assisstantloop weixin        # Continue WeChat setup
assisstantloop status        # Inspect work and questions
assisstantloop try           # Test question and continuation
assisstantloop service install
assisstantloop update
assisstantloop uninstall --yes
```

Proactive updates are allowed. Repeated summaries of the same receipt and repeated requests for the same missing information are suppressed; new results, risks and state changes still get reported. Natural replies retain the original words and task association.

Images: up to two per message, 4 MiB each, PNG/JPEG/WebP/GIF. The host downloads and decrypts owner-sent images, passes native image blocks to Pi, and can give the original task saved host paths and observations. A recent image summary may be referenced for 24 hours. Originals are private user data, capped at 32 files / 32 MiB, never automatically deleted to make room. Video/file contents and native outbound media are not supported.

Data defaults to `~/.assisstantloop`, port `3360`, separate from existing AutoLoop installations. Only the QR-bound owner's private messages are accepted. Do not bind one WeChat account to two active listeners. The front desk has no execution tools; trusted rules still determine backend agent, directory and permissions. Deleting files, system changes, external sends and spending need confirmation. Text, images and relevant context go to the configured model service. Credentials and actual chat data do not belong in Git.

See [installation guidance](INSTALL.md), [WeChat internals](plugins/weixin/README.md), [protocol](docs/protocol.md) and [security](SECURITY.md). The root installer is for AssisstantLoop; `scripts/install-core.sh` is retained for upstream compatibility tests.

Built on [Agent AutoLoop](https://github.com/KKKKhazix/agent-autoloop), retaining its MIT license and attribution. WeChat integration references [AstrBot](https://github.com/AstrBotDevs/AstrBot), and the main-session / execution-session split references [DSH Superagent](https://github.com/deepseek-ai/dsh-superagent-prototype). Uses the [Pi](https://github.com/earendil-works/pi) model client. Not an official WeChat, DeepSeek or OpenAI product.

```sh
npm ci
npm run test:quick
npm run typecheck
npm run format:check
```

Tests use isolated homes, fake models and transports. Actual WeChat authorization and delivery must be verified separately by each user. [MIT License](LICENSE).
