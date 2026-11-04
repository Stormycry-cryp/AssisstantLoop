# 本机 Pi 共享宿主接入

通过已安装的 `opus-agent-ui` 共享客户端连接 Opus Agent App 的同一宿主。任务在 App 中可见，回答后沿原线程继续；不启动独立 Pi，不修改共享 SDK，不读取模型凭据。

这是本机插件，安装目录为 `~/.agent-autoloop/plugins/pi-ui/`。将本目录的 `agent.ts`、`runner.ts`、`protocol.ts` 和本说明放入该目录，在 `~/.agent-autoloop/rules.json` 的 `agents` 中登记：

```json
{
  "pi-opus": {
    "name": "Pi / Opus 5.5",
    "worker": "替换为本机接单电脑名",
    "use": "pi-ui",
    "model": "claude-opus-5-5",
    "effort": "xhigh",
    "access": "full"
  }
}
```

以后规则的 `to` 写 `pi-opus`。`worker` 使用 `agent-autoloop status` 中的本机名称，`cwd` 使用实际任务目录。配置后运行 `agent-autoloop check` 和 `agent-autoloop doctor`。本插件依赖 Node 24 和默认安装位置 `~/.local/share/opus-agent`；共享客户端不可用时先恢复同一 App 宿主，不回退独立会话或其他模型。

## 权限与模型

共享宿主目前仅支持 `full-access`。插件拒绝 `read`、`edit`，不会把完整权限伪装成目录沙箱。任务仍须遵守中台的先问清单和用户授权范围。

新 Opus 线程使用 `xhigh`；已有线程保留 Pi 保存的强度和渠道。明确换档应在原 App 线程操作。其他已注册模型可由用户明确选择后另行登记，本次只验收 Opus。

## 连续性与停止

- 调用安装版客户端导出的 `runUiCli`，原生 `requestIdentity` 负责输入身份；接纳、执行、重试、上下文压缩与持久化继续由 Pi/T3 处理。
- 输入编号由中台目录、轮次、工作目录和提示词决定，不随 worker 重启或执行重试改变。原生检查发现已提交输入时，只观察原输入，不再次提交、不重新应用强度。其他输入仍在原线程运行时，不派第二份活。
- `session` 是包含真实 `threadId` 和 App 链接的 JSON，不是宿主 session UUID。最终回复交给中台解析；未完成的流式文字不算结果。
- 中台发送 `SIGTERM`/`SIGINT` 时，客户端在确认本轮输入已被接纳后调用宿主的 `thread.stop`，继续观察到终态；不是仅断开客户端。停止只针对本任务线程，不关闭共享宿主。
- 连接或供应商失败会留下待处理卡片，保留原输入编号与线程；不触发中台的换会话兜底或无限重派。恢复前先在 App 核实已有结果，不能把未知状态当作未执行。

共享入口的这些导出是当前安装版提供的本机接口；升级 Pi 后须重跑本插件测试和问答/停止验收。未提供的用量与费用保持未知，不填写零。

## 输出与验证

单轮提示词上限 256 KiB，输入文件上限 512 KiB，单条投影上限 8 MiB，最终回复上限 128 KiB。完整投影、历史和媒体不写入 Autoloop 日志；日志只保留线程身份与最终回复。请求文件放在中台已有的私有运行目录中，原子替换固定文件，沿用运行记录的生命周期，不额外复制素材或依赖。

```sh
node --test tests/pi-ui.test.ts
npm run test:quick
npm run typecheck
npm run format:check
```

自动测试使用模拟客户端，不调用模型，不发送通知，临时文件在 `finally` 清理。真实验收使用独立 `AGENT_AUTOLOOP_HOME`、随机端口和空通知配置；确认问答续接、原输入重连未增加轮次、停止后宿主状态为 `interrupted`。测试中台停止后清理临时数据库和输出，App 线程作为本次验收记录保留。
