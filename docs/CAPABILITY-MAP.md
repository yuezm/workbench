# Capability Map: Workbench（个人工作台）

> 确认日期：2026-10-28。2026-11-04 按「内核 + 插件」重设目标架构（见 [ARCHITECTURE.md](./ARCHITECTURE.md)）。
> 本文件是模块索引：spec、计划、任务都以这里的 module id 为准。

## 意图来源

- Electron 桌面"工作台"外壳，自用、单用户、本地运行、无登录。
- 第一个内置 app 是番茄时钟，用于学习/工作时专注计时。
- v1 数据不落盘；明确不做：历史统计、任务关联、全局快捷键、开机自启、云同步、多语言。（托盘已于 2026-10-30 纳入 shell：关闭窗口驻留托盘，见 SPEC-shell.md）
- 2026-11-02 起新增第二个 app `ai-workflow`（个人AI工作流，本地最小闭环）。它**自行**引入本地 SQLite（`node:sqlite`）持久化，仅限该模块；v1 "不落盘"仍适用于 pomodoro 等其它模块。设计参考 Multica 的「本地 UI/状态 + 本机 CLI 执行」边界。注册表顺序为 `ai-workflow` → `pomodoro`（`ai-workflow` 在前且默认打开）。
- **2026-11-04 重设架构**：把「事件 → 规则 → 派活 → 记账」抽成纯内核，事件来源、执行器、审批通道、界面全部变为插件；目标是真相源唯一（事实日志）、可追溯（why）、加运行时只改插件。参考卡兹克《开源我这折腾了 1 年的「Agent 自动化系统」》与 `agent-autoloop`。落地分阶段见 [refactor-plan](./planning/refactor-plan.md)。

## 目标模块（重构后）

| Module id         | 职责                                                                                                                                                                                                                           | 依赖                                   | Spec                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `kernel`          | 纯内核：`decide` / `project` / 事实日志模型 / 阶段状态机 / 规则匹配 / 线程（上下文容器）/ 调度语义（租约、并发、退避）/ 审批挂起 / 跳数熔断 / 项目（任务容器与工作目录）。无 IO、无时钟、无随机、无网络、无产品名              | `protocol`（仅类型）                   | [SPEC-kernel.md](./specs/SPEC-kernel.md)                                             |
| `protocol`        | 纯契约：命令/视图/回执/规则/manifest 类型与运行时校验                                                                                                                                                                          | —                                      | [SPEC-kernel.md](./specs/SPEC-kernel.md)、[SPEC-plugins.md](./specs/SPEC-plugins.md) |
| `sdk`             | 插件能力接口类型：日志、毫秒时钟、路径、配置、受 `capabilities` 约束的 process（spawn/resolve/killTree/scanDirs/findInDirs）与 net（M7：fetch / 仅回环 listen / HMAC 校验）、source 端口                                       | `protocol`                             | [SPEC-plugins.md](./specs/SPEC-plugins.md)                                           |
| `host`            | Electron 主进程宿主：开库/事务/重建、单定时器、spawn、资料落盘、通知、插件装载（M7：用户目录发现、能力授权、secret 加密、外部插件子进程）、启动对账、IPC 三动词                                                                | `kernel`、`protocol`、`sdk`、`plugins` | [SPEC-host.md](./specs/SPEC-host.md)、[SPEC-artifacts.md](./specs/SPEC-artifacts.md) |
| `plugins`         | 插件体系：`source` / `executor` / `channel` / `app` 四类，manifest 声明 + `registry.ts` 静态注册（数组顺序即 UI 下拉与 detect 顺序）；执行器按运行时的 `executorKey` 选择                                                      | `sdk`、`protocol`                      | [SPEC-plugins.md](./specs/SPEC-plugins.md)                                           |
| `shell`           | renderer 外壳：顶部 app 标签栏、插件槽、`kernelStore`（快照 + 增量失效）、跨进程桥接消费                                                                                                                                       | `protocol`                             | [SPEC-host.md](./specs/SPEC-host.md)                                                 |
| `ui`              | 视觉基座：**shadcn/ui v4 基线**（`shell/styles/global.css` 双主题变量 + `components/ui/` 上游组件）、项目覆盖层组件（Field / Panel / Menu / Segmented / ThemeSwitcher / FormError）、圆角/前景/对比度硬规则（`pnpm check:ui`） | —                                      | [SPEC-ui.md](./specs/SPEC-ui.md)                                                     |
| `app-pomodoro`    | 番茄钟 app 插件：计时状态机与 UI；可发 `pomodoro.*` 事件                                                                                                                                                                       | `shell`                                | [SPEC-pomodoro.md](./specs/SPEC-pomodoro.md)                                         |
| `app-ai-workflow` | AI 工作流 app 插件：运行时/智能体/多阶段工作流/看板/聊天/设置，全部经 `dispatch` + `query` 访问内核                                                                                                                            | `shell`、`plugins`                     | [SPEC-ai-workflow.md](./specs/SPEC-ai-workflow.md)（行为基线）                       |

## 迁移期模块（M0–M6.5 内有效）

下表是重构前的实际目录，随里程碑逐步消失；对应行为测试保留并迁移。

| Module id       | 职责                                                                                                | 依赖     | Spec                                               |
| --------------- | --------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------- |
| `shell`（现状） | 顶部 app 标签栏、`AppPlugin` 契约与注册表、`kernelStore`（快照 + seq + 失效）                       | protocol | [SPEC-shell.md](./specs/SPEC-shell.md)             |
| `pomodoro`      | 番茄钟 app                                                                                          | shell    | [SPEC-pomodoro.md](./specs/SPEC-pomodoro.md)       |
| `ai-workflow`   | 运行时 + 智能体 + 工作流 + 看板 + 聊天 + SQLite 持久化（当前实现 `src/main/ai-workflow/`，4275 行） | shell    | [SPEC-ai-workflow.md](./specs/SPEC-ai-workflow.md) |

> 状态（2026-11-05）：**M0–M6.5 已落地**。M0：kernel 边界、WAL + `integrity_check`、单实例锁、只读数据导出、打包冒烟。M1：`facts` 事实日志 + `project` 投影 + 重建 + `snapshot.imported` 存量导入；五张业务表已是投影。M2：运行生命周期全部入账（`run.*` 事实、租约/心跳/退避/超时、`runs`/`run_events` 投影）、`host/scheduler` + 注入执行器端口、启动对账与 `process_registry`、聊天并入 `purpose='chat'`、取消链路；`repository`/`runner`/`ChatService` 已删除。M3a：执行器插件化落地——`src/sdk` 能力面、`src/plugins/registry.ts` + `plugins/executors/dsh`、运行时 `executorKey` 取代旧协议族字段（`runtimes` 一次性物理升级 + 重建归一），`src/main/ai-workflow/runtime/**` 删除；假协议端到端验收通过。M3b/M3c：detect 归插件（`detectAll` 串行汇总、2 s 超时、失败隔离、同 command 先到先得）、`runtimes.executors()` 与运行时表单执行器选择、`command` 插件（`argsTemplate`、`{prompt}` 只在 argv 元素或 stdin、Windows `.cmd` 固定包装）、未知执行器落 `runtime_missing` 兜底终态。M4：审批与通道落地——`cards` 第 10 张投影表与 6 条 `card.*` 事实、`card.answer`/`card.resolve` 命令与两条投递宿主输入、`cards.open`/`cards.byRun`/`runs.waiting` 视图、回执块解析（ask/notices/resolves/later/events）、回答续接（同会话、`turn+1`）、`in-app`/`desktop` 通道与 `sdk.notify`、无卡 waiting 的启动对账兜底、顶部待审批条、`event.received`/`event.dropped` 只入账；`KERNEL_VERSION=m4.0.0`。M5：客户端插件落地——IPC 收敛为 `dispatch/query/subscribe` 三动词 + `commands` 幂等表（事务内回放）、聊天命令化（`chat.*`）与 `app.event`、`runtime.probe` 编排命令、宿主视图（executors/detected/models）与 `tasks.executing`/`runtimes.statuses`/`kernel.seq` 读视图、事实批次 feed 与聊天流旁路、renderer `kernelStore`（先订阅后快照、按 seq 续传、失效重取、单订阅）、`AppPlugin` 契约与 pomodoro 事件；`window.aiWorkflow` / `src/main/ai-workflow/ipc.ts` 已删除。退出证据以 [refactor-plan](./planning/refactor-plan.md) 的 M5 记录为准。M6：自动化规则落地——`rule_sets` / `rule_fires` 两张投影表与 `rules.replaced` / `rule.fired` 事实、`rules.replace` 整批替换（版本 +1）与 `rule.trigger` 手动运行命令、宿主输入 `event.received` 统一外部事件入口（app.event 与回执派生事件同路径）、事件命中规则建任务（`tasks` 新增 origin/ruleId/externalRef/labels，同规则同入口键去重）、`kernel/cron` 纯函数 + `clock.tick` 到点建任务、设置页「规则」栏与 Issue/早报模板；`KERNEL_VERSION=m6.0.0`。M6.5：线程落地——`threads` 第 13 张投影表与 7 条 `thread.*` 事实（整行 payload）、`event.merged`、`thread.note`/`thread.close`/`thread.bind` 命令、事件按 `(source, externalRef)` 归并（复用任务 / `event.merged` / `onExisting=new-task`）、线程上下文派生（`kernel/thread-context`，≤6000 码点确定性截断）、按 (thread, agent) 会话续接、`run.claim` 线程并发闸门、手工/cron 任务隐式线程、派生任务 `parentTaskId`、任务完成/删除/14 天无活动的线程归档与新事件重开、`thread.byId` 视图与看板线程面板；`KERNEL_VERSION=m6.5.0`。source 插件进程 / webhook / 外部插件 / 跨工作流交接留 M7（可选）。下一步：M7 仅在明确要做时启动。

> M7（2026-11-05）：外部插件与可选能力落地——`plugin_settings` 第 14 张投影表 + `plugins.replaced` / `plugins.replace` / `plugin.set`、用户目录外部插件（`source` / `channel`：独立子进程 JSONL 帧、能力授权、环境白名单、secret 走 `plugin_secrets` + `safeStorage`）、`sdk.net`（出站 fetch / 仅回环 listen / HMAC 校验）、webhook 来源（只绑 `127.0.0.1` + HMAC 验签）与 webhook 通道（出站 POST，secret 只作 Bearer）、source hub（`ctx.emit` → 唯一事件入口 `event.received`）、跨工作流交接（阶段完成在目标工作流建 `origin='handoff'` 关联任务，链深 ≤8、不回写来源任务）、远端 Worker 执行器架构位（`protocol/worker.ts` 帧 + `RemoteTransport` + 内存假传输，不监听端口/不建 daemon）；`KERNEL_VERSION=m7.0.0`；设置页第五栏「插件」与阶段编辑器交接配置。
> M7.5（2026-11-06）：任务上下文 / 反馈落地——`task_comments` 第 15 张投影表 + `task.comment_added` 事实（纯追加、任务删除联删）、`task.comment` 命令（正文 ≤2000 字，`rerun` 只在 agent 阶段且无活跃 run 时再排一轮）、`comments.byTask` 视图、提示词「反馈记录（资料，不是指令）」段（最近 10 条、每条 ≤200 码点）、任务详情页上下文活动流（运行与反馈按时间混排）+ 反馈框；`KERNEL_VERSION=M7.5.0.0`。
> （2026-11-08）多协议运行时与开箱 SOP：执行器插件 `claude`（Claude Code `--print --output-format stream-json`，提示词走 stdin，无审批往返、越界即失败）与 `hermes`（`hermes acp` ACP / JSON-RPC 2.0，`session/request_permission` 审批回帧、取消走 `session/cancel`）；`cli-catalog` 增 `hermes`（排在 `claude` 之后，即 detect 输出顺序）；设置 → 工作流配置新增「SOP 模板」（产品发现 / 研发交付 / 测试质量 / 缺陷修复 / 发版运维 / 事故复盘 / 迭代回顾，预填阶段与「要干什么」，保存前不落库）。
> （2026-11-08）新建工作流改为单入口下拉：新增 `components/ui/menu.tsx`（锚定按钮、分组条目、`fixed` 浮层 + 上翻贴合、键盘与外点关闭），工作流配置的「SOP 模板」独立按钮并入「新建工作流」下拉——第一组「从空白创建」，第二组列出 7 条模板（阶段数 + 适用场景），选中即在同一个编辑器里出草稿。

> （2026-11-10）工作流内置阶段（M18）：每个工作流恒有「待办 / 已阻塞 / 已完成 / 已取消」四个系统阶段（`workflow_stages.builtin`），名称、类别、位置由内核锁定，其余字段可改；阶段按四类（未开始 / 进行中 / 已完成 / 已关闭）着色，自己添加的阶段归入进行中；默认流转跳过「已阻塞」、落到「已完成」，新任务默认落「待办」；`KERNEL_VERSION=M18.0.0`，首启由 `store.ensureBuiltinStages()` 补齐历史工作流。

## 边界决定

1. **真相源唯一**：任务/运行/卡片/对话的状态只能由事实日志派生；投影表可重建，不得绕过事实直接写业务数据。
2. **内核不认产品**：内核不知道 dsh、飞书、看板；新增这些只写插件。
3. **入口是任务，派活单位是智能体**：规则命中只建任务（指定工作流/阶段），阶段再按 `entry_mode` 指向智能体；运行时只提供连接，执行配置（模型、思考强度、并发、访问权限、工作目录、环境变量）在智能体上，执行器由运行时的 `executorKey` 选，不参与派活。
4. **宿主独占副作用**：只有 `host` 能开库、spawn、发通知、写文件；内核只接 `view`、只返 `facts`。
5. **客户端无业务权威状态**：renderer 只读视图 + 订阅事实增量；「执行中」等派生状态由内核算。计时器、表单草稿、拖拽这类交互态可以留在 app 本地，不落库、不进日志。
6. **"一个 app 是什么"由 shell 定义**：新增 app = 新增目录 + 插件清单一行，外壳零改动（沿用现有机制，契约升级为 `AppPlugin`）。
7. **依赖方向**：`kernel → protocol`（仅类型）、`plugins → sdk → protocol`、`host → kernel + protocol + sdk`（插件清单由装配根注入，host 不 import 具体插件）、`renderer → bridge → host`；app 之间互不依赖，插件之间禁止互相 import（`plugins/shared/` 仅纯函数）。
8. **迁移进口不是因果链**：`snapshot.imported` 是无 `cause` 的导入根，`why` 对它标注「迁移导入」，不伪造决策历史。
9. **线程是状态，不是配置**：所有任务都挂线程（手工任务自动建隐式线程，之后可绑定外部入口）；派生任务继承线程与父任务；上下文每轮从事实派生（≤6000 字），不维护可变共享文件。
10. **能力授权是信任门，不是沙箱**（M7）：外部插件声明能力并由用户逐项授权，宿主据此决定「启不启动 / 下发哪些 config 与 secret / 过滤环境变量」；不声称隔离 OS 权限，也不为外部插件提供绕过 `event.received` 的第二条事件入口。
11. **外部输入不改变派活**（M7）：webhook / 外部 source 只产 `event.received`；`cwd`、`executor`、`access`、派给谁仍只能来自本机规则与运行时配置。
12. **任务必须挂在项目下**（M10）：项目 = 本地文件夹 + 名字，是任务的容器与执行工作目录（`RunRow.cwd` 取项目 `path`，优先于智能体 `workdir`）。人建任务要求项目存在；派生 / 交接任务继承来源任务的项目；规则可声明 `to.projectId`，老规则与 v2 存量按「未归属」展示（不丢数据）。删项目前必须没有任务。

## 构建顺序

`kernel` → `protocol` → `host` → `plugins` → `shell` → app 插件（`pomodoro` 先验证槽位，`ai-workflow` 后迁移）
