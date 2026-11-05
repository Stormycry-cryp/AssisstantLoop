# 桌面 Codex 接单端

把 macOS 上已经打开、已经登录的桌面 Codex 纳入 AutoLoop：新建任务在桌面执行；指定一个已有聊天后，后续任务在该聊天继续。AutoLoop 继续负责排队、续接、结果、提问和停止，微信前台仍是独立 Pi，不换模型、不读取 Codex 登录凭据。

这是独立于 `codex exec` 的 `codex-desktop` 插件。实际推理通过桌面原生会话执行，不额外常驻 app-server，也不启用远程控制。新建聊天时短暂启动官方 app-server，只写会话元数据，不在那里推理。

## 配置

先打开桌面应用。在本机可信 `rules.json` 登记执行者和规则，替换电脑名及目录：

```json
{
  "agents": {
    "codex-desktop": { "name": "桌面 Codex", "worker": "my-mac", "use": "codex-desktop", "access": "edit" }
  },
  "rules": [
    {
      "name": "微信桌面任务",
      "when": { "source": "weixin", "types": ["task.desktop"] },
      "to": "codex-desktop",
      "cwd": "/absolute/path/to/work",
      "group": "weixin-tasks",
      "parallel": 1,
      "tell": "always",
      "prompt": "读取本轮资料里的本人原话，按既有授权处理；有不可撤回的动作先提问，完成后说明实际结果"
    }
  ]
}
```

合并配置，不覆盖已有规则。桌面规则与同目录的 CLI、Pi 规则使用同组且并发为 1。运行 `agent-autoloop check`。微信里说“让桌面 Codex 处理这件事……”即可；后续查询、回答和停止走原有事项。同一事项继续原桌面会话，新事项创建新聊天。

管理已有聊天，在本仓库或安装目录运行：

```sh
node plugins/codex-desktop/manage.ts list
node plugins/codex-desktop/manage.ts attach <桌面会话编号>
node plugins/codex-desktop/manage.ts new
```

`list` 只在本机列最近 20 个聊天。`attach` 明确选择空闲聊天，将该执行者绑定到它，并把相应规则目录改为该聊天实际目录；已有配置备份为私有目录下的 `codex-desktop-rules.previous.json`。运行中聊天拒绝绑定。`new` 取消固定绑定，新事项重新建聊天，已管理事项仍可续接原聊天。模型和思考沿用桌面设置，可信执行者的 `model`、`effort` 可显式覆盖。

## 边界与恢复

- 仅管理 AutoLoop 自己提交的轮次，或明确绑定的聊天。不自动导入全部手工聊天，也不切换到当前正在聊天的窗口；另行开启的[本机只读观察](../weixin/README.md#本机手工会话与进程读取)只提供状态和有限摘要，不赋予控制权。
- 每轮核对实际目录，明确传入 `readOnly` / `workspaceWrite` / `dangerFullAccess`，不继承全局完全权限。`edit` 限可信工作区，额外只允许当前聊天的桌面可视化输出目录；实际策略不同会请求停止并留待核实。沙箱不隔离同账号可读的个人资料，已有聊天和工具配置应由本人信任。
- 原生接口在 macOS 桌面 Codex `0.166.0-alpha.6` 验收。桌面 IPC 是本机版本相关接口，不是稳定公开 API；版本不兼容时拒绝派发，保留原任务，不靠界面点击兜底。
- 提交前写入稳定编号与日志，确认桌面轮次后绑定实际编号。转接进程退出不代表桌面结束：接单程序继续核实，未确认时占住原并发位置，不重派业务。停止只针对本任务轮次，不停止后来的手工轮次。桌面关闭时保留任务，重开后核实原会话。
- 不确定的提交可能需要本人核实原聊天，不能保证桌面接口具备未经验证的幂等性。提问仍是一轮结束后等回答，不让模型空转等人。当前未采集桌面 token / 费用，沿用中台“未上报”口径。
- 输入和结果各最多 128 KiB，IPC 单帧与会话资料最多 8 MiB，私有 JSON 文件最多 256 KiB。单轮日志保存在接单程序既有目录，不复制整份 Codex 历史或媒体。管理目录中的配置和业务日志不属于测试清理材料。

## 验收

假 IPC、恢复与并发行为进入正常测试，不接真实微信、不碰用户聊天。真实验收必须明确指定可用于试跑的空闲桌面聊天：

```sh
node --disable-warning=ExperimentalWarning scripts/real-desktop.ts <专用会话编号> <该会话目录> --run
```

真实验收走临时中台与接单程序，先执行两轮并核对同会话续接，再提交 `sleep 20` 验证精确停止。只保留一个固定临时目录；成功清理，失败且仍有任务时保留恢复日志，不删除活跃任务。单次最多四分钟、三轮，不发真实通知，输出只含简短状态；日常业务不调用该脚本。

本机性能观察：nightly 的空闲 RSS 门槛未通过（115.15 MB / 60.4 MB）；未改动基线对照 112.56 MB，本次 112.74 MB。内核和宿主未改动，不修改性能预算；功能、并发恢复、强杀和变异检查分别记录结果。
