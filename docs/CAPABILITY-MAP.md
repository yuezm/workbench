# Capability Map: Workbench（个人工作台）

> 确认日期：2026-10-28。本文件是模块索引：spec、计划、任务都以这里的 module id 为准。

## 意图来源

- Electron 桌面"工作台"外壳，自用、单用户、本地运行、无登录。
- 第一个内置 app 是番茄时钟，用于学习/工作时专注计时。
- v1 数据不落盘；明确不做：历史统计、任务关联、全局快捷键、开机自启、云同步、多语言。（托盘已于 2026-10-30 纳入 shell：关闭窗口驻留托盘，见 SPEC-shell.md）
- 2026-11-02 起新增第二个 app `ai-workflow`（个人AI工作流，本地最小闭环）。它**自行**引入本地 SQLite（`node:sqlite`）持久化，仅限该模块；v1 "不落盘"仍适用于 pomodoro 等其它模块。设计参考 Multica 的「本地 UI/状态 + 本机 CLI 执行」边界。

## 模块

| Module id     | 职责                                                                                                                                                                                        | 依赖  | Spec                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------- |
| `shell`       | Electron 外壳：主进程/窗口管理（关闭隐藏到托盘）、系统托盘、顶部 app 标签栏导航、app 注册与挂载机制（AppDefinition 契约）、跨进程系统能力桥接（系统通知统一 API）                           | —     | [SPEC-shell.md](./specs/SPEC-shell.md)             |
| `pomodoro`    | 番茄钟 app：计时状态机、计时 UI、响铃、时长设置                                                                                                                                             | shell | [SPEC-pomodoro.md](./specs/SPEC-pomodoro.md)       |
| `ai-workflow` | 个人AI工作流 app：运行时 = 协议族后端 + 探测健康 + 事件流（本机 CLI 经 `--stdio` JSONL 协议执行）、智能体配置、多阶段工作流状态机、看板任务、主动对话（聊天，会话续接）、本地 SQLite 持久化 | shell | [SPEC-ai-workflow.md](./specs/SPEC-ai-workflow.md) |

## 边界决定

1. **"一个 app 是什么"由 shell 定义**：`AppDefinition` 契约归 shell 所有，app 是契约的消费者。新增 app = 新增 app 目录 + 注册表加一行，外壳代码零改动。
2. **跨进程能力归 shell，纯 Web 能力归 app**：系统通知由 shell 提供统一 API；响铃（Web Audio）归 pomodoro。
3. **依赖方向**：`pomodoro → shell`，禁止反向；app 之间互不依赖。

## 构建顺序

`shell` → `pomodoro` → `ai-workflow`（两个 app 互不依赖，均只依赖 shell）
