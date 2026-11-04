# Capability Map: Workbench（个人工作台）

> 确认日期：2026-10-28。2026-11-04 按「内核 + 插件」重设目标架构（见 [ARCHITECTURE.md](./ARCHITECTURE.md)）。
> 本文件是模块索引：spec、计划、任务都以这里的 module id 为准。

## 意图来源

- Electron 桌面"工作台"外壳，自用、单用户、本地运行、无登录。
- 第一个内置 app 是番茄时钟，用于学习/工作时专注计时。
- v1 数据不落盘；明确不做：历史统计、任务关联、全局快捷键、开机自启、云同步、多语言。（托盘已于 2026-10-30 纳入 shell：关闭窗口驻留托盘，见 SPEC-shell.md）
- 2026-11-02 起新增第二个 app `ai-workflow`（个人AI工作流，本地最小闭环）。它**自行**引入本地 SQLite（`node:sqlite`）持久化，仅限该模块；v1 "不落盘"仍适用于 pomodoro 等其它模块。设计参考 Multica 的「本地 UI/状态 + 本机 CLI 执行」边界。
- **2026-11-04 重设架构**：把「事件 → 规则 → 派活 → 记账」抽成纯内核，事件来源、执行器、审批通道、界面全部变为插件；目标是真相源唯一（事实日志）、可追溯（why）、加运行时只改插件。参考卡兹克《开源我这折腾了 1 年的「Agent 自动化系统」》与 `agent-autoloop`。落地分阶段见 [refactor-plan](./planning/refactor-plan.md)。

## 目标模块（重构后）

| Module id         | 职责                                                                                                                                                                                 | 依赖                                   | Spec                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `kernel`          | 纯内核：`decide` / `project` / 事实日志模型 / 阶段状态机 / 规则匹配 / 线程（上下文容器）/ 调度语义（租约、并发、退避）/ 审批挂起 / 跳数熔断。无 IO、无时钟、无随机、无网络、无产品名 | `protocol`（仅类型）                   | [SPEC-kernel.md](./specs/SPEC-kernel.md)                                             |
| `protocol`        | 纯契约：命令/视图/回执/规则/manifest 类型与运行时校验                                                                                                                                | —                                      | [SPEC-kernel.md](./specs/SPEC-kernel.md)、[SPEC-plugins.md](./specs/SPEC-plugins.md) |
| `sdk`             | 插件能力接口类型：日志、配置、事件、受 `capabilities` 约束的 spawn/fs                                                                                                                | `protocol`                             | [SPEC-plugins.md](./specs/SPEC-plugins.md)                                           |
| `host`            | Electron 主进程宿主：开库/事务/重建、单定时器、spawn、资料落盘、通知、插件装载、启动对账、IPC 三动词                                                                                 | `kernel`、`protocol`、`sdk`、`plugins` | [SPEC-host.md](./specs/SPEC-host.md)                                                 |
| `plugins`         | 插件体系：`source` / `executor` / `channel` / `app` 四类，manifest 声明 + registry 静态注册                                                                                          | `kernel` 类型、`protocol`              | [SPEC-plugins.md](./specs/SPEC-plugins.md)                                           |
| `shell`           | renderer 外壳：顶部 app 标签栏、插件槽、`kernelStore`（快照 + 增量失效）、跨进程桥接消费                                                                                             | `protocol`                             | [SPEC-host.md](./specs/SPEC-host.md)                                                 |
| `app-pomodoro`    | 番茄钟 app 插件：计时状态机与 UI；可发 `pomodoro.*` 事件                                                                                                                             | `shell`                                | [SPEC-pomodoro.md](./specs/SPEC-pomodoro.md)                                         |
| `app-ai-workflow` | AI 工作流 app 插件：运行时/智能体/多阶段工作流/看板/聊天/设置，全部经 `dispatch` + `query` 访问内核                                                                                  | `shell`、`plugins`                     | [SPEC-ai-workflow.md](./specs/SPEC-ai-workflow.md)（行为基线）                       |

## 迁移期模块（M0–M5 内有效）

下表是重构前的实际目录，随里程碑逐步消失；对应行为测试保留并迁移。

| Module id       | 职责                                                                                                | 依赖  | Spec                                               |
| --------------- | --------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------- |
| `shell`（现状） | 顶部 app 标签栏、`AppDefinition` 契约与注册表                                                       | —     | [SPEC-shell.md](./specs/SPEC-shell.md)             |
| `pomodoro`      | 番茄钟 app                                                                                          | shell | [SPEC-pomodoro.md](./specs/SPEC-pomodoro.md)       |
| `ai-workflow`   | 运行时 + 智能体 + 工作流 + 看板 + 聊天 + SQLite 持久化（当前实现 `src/main/ai-workflow/`，4275 行） | shell | [SPEC-ai-workflow.md](./specs/SPEC-ai-workflow.md) |

> 状态（2026-11-05）：**M0、M1、M2 已退出**。M0：kernel 边界、WAL + `integrity_check`、单实例锁、只读数据导出、打包冒烟。M1：`facts` 事实日志 + `project` 投影 + 重建 + `snapshot.imported` 存量导入；五张业务表已是投影。M2：运行生命周期全部入账（`run.*` 事实、租约/心跳/退避/超时、`runs`/`run_events` 投影）、`host/scheduler` + 注入执行器端口、启动对账与 `process_registry`、聊天并入 `purpose='chat'`、取消链路；`repository`/`runner`/`ChatService` 已删除，`src/main/ai-workflow` 只剩 IPC 与执行器适配。下一步 M3：执行器插件化（`dsh` 搬 `plugins/executors`、`executorKey` 路由）。证据见 [refactor-plan](./planning/refactor-plan.md) 的 M0/M1/M2 退出记录。

## 边界决定

1. **真相源唯一**：任务/运行/卡片/对话的状态只能由事实日志派生；投影表可重建，不得绕过事实直接写业务数据。
2. **内核不认产品**：内核不知道 dsh、飞书、看板；新增这些只写插件。
3. **入口是任务，派活单位是智能体**：规则命中只建任务（指定工作流/阶段），阶段再按 `entry_mode` 指向智能体；运行时由智能体绑定，执行器由运行时的 `executorKey` 选，不参与派活。
4. **宿主独占副作用**：只有 `host` 能开库、spawn、发通知、写文件；内核只接 `view`、只返 `facts`。
5. **客户端无业务权威状态**：renderer 只读视图 + 订阅事实增量；「执行中」等派生状态由内核算。计时器、表单草稿、拖拽这类交互态可以留在 app 本地，不落库、不进日志。
6. **"一个 app 是什么"由 shell 定义**：新增 app = 新增目录 + 插件清单一行，外壳零改动（沿用现有机制，契约升级为 `AppPlugin`）。
7. **依赖方向**：`kernel → protocol`（仅类型）、`plugins → sdk → protocol`、`host → kernel + plugins`、`renderer → bridge → host`；app 之间互不依赖，插件之间禁止互相 import（`plugins/shared/` 仅纯函数）。
8. **迁移进口不是因果链**：`snapshot.imported` 是无 `cause` 的导入根，`why` 对它标注「迁移导入」，不伪造决策历史。
9. **线程是状态，不是配置**：所有任务都挂线程（手工任务自动建隐式线程，之后可绑定外部入口）；派生任务继承线程与父任务；上下文每轮从事实派生（≤6000 字），不维护可变共享文件。

## 构建顺序

`kernel` → `protocol` → `host` → `plugins` → `shell` → app 插件（`pomodoro` 先验证槽位，`ai-workflow` 后迁移）
