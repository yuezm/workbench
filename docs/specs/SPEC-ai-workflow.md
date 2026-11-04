# Spec: ai-workflow（个人AI工作流）

> **重构提示（2026-11-04）：** 目录结构与分层已由 [ARCHITECTURE](../ARCHITECTURE.md) 与 [SPEC-kernel](SPEC-kernel.md)、[SPEC-plugins](SPEC-plugins.md)、[SPEC-host](SPEC-host.md) 取代；本文的行为规格（阶段语义、终态归一、取消时序、探测、聊天续接、迁移规则）仍是迁移基线，M5 前逐条有效。

> Module id：`ai-workflow`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。依赖 `shell`。确认日期：2026-11-02；运行时章节 2026-11-03 重做为 v2。
>
> 本 Spec 为 MVP：**本地单机最小闭环**。远端 Worker 仅留架构位、不实现（见 Open Questions / Out of scope）。设计参考 Multica 的「本地 UI/状态 + 本机 CLI 执行」边界。
>
> 2026-11-03 运行时重做为 v2：运行时 = 协议族后端 + 探测健康 + 事件流（见「运行时」）；旧 `command + 空格分隔 args + prompt_mode + 通用 spawn` 与「探测真跑一次 prompt」已删除，不做兼容字段。

## Objective

在工作台内新增 `ai-workflow` app：把「运行时 → 智能体 → 自定义多阶段工作流 → 看板任务」串成一个能在本地跑起来的最小闭环。

- 配置**运行时**：运行时 = 本机执行环境实例（协议族 + 启动命令 + profile + 权限模式 + 模型/推理强度 + 工作目录 + 并发上限 + 启用开关）；MVP 只实现 `dsh` 协议族，其余运行时（claude code / codex 等）后续按同一「协议族后端」接口接入。
- **识别**已安装的运行时：运行时配置页扫描本机 PATH，自动列出已安装的 agent CLI，点「使用」打开新建表单并把名称与命令预填进去（不自动建记录，profile/权限模式等仍由用户确认）。
- 配置**智能体**：名称、描述、执行配置（绑定某个运行时）、能力（System Prompt）。
- 配置**工作流**：一条有序的**阶段**序列；每个阶段可设【进入时】【完成后进入】【打回时退回到】。
- 用**看板**查看与推进任务：列 = 当前所选工作流的阶段；新建任务时可选**起始阶段**，之后把卡片**拖拽**到其它阶段列（或「已完成」区）推进，不设执行按钮。

**用户故事：**

- 作为使用者，我添加一个"DeepSeek Harness"运行时，再建一个绑定它的智能体。
- 作为使用者，我建一条工作流（如"研发：待办 → 进行中 → 审核中 → 已完成"），把"进行中"配成进入时交给某智能体、把"审核中"配成进入时交给用户审批。
- 作为使用者，我新建一个任务时选好工作流与**起始阶段**；任务进入该阶段，按阶段配置自动交给智能体执行或停下等我处理；我在看板上把卡片**拖到**其它阶段列，卡片随之流转；拖到「已完成」区即收尾。
- 作为使用者，关掉工作台再打开，我的运行时/智能体/工作流/任务/运行记录都还在。

## 界面结构（2026-11-03 二次调整：三层左栏收敛为「单列侧栏 + 内容区」）

app 内只有一个页面，布局固定为「单列侧栏（w-64）+ 内容区」两栏，吃满 shell 顶部栏以下的高度。侧栏顶部用次级标题（`h2`，不占用一级标题——一级标题语义留给 shell 顶部栏）标识当前 app，其下是**栏目切换 + 当前栏目的上下文列表**，底部固定分段控件（`components/ui/segmented.tsx`，role=tab）在互斥视图间切换：**工作台 / 设置**。同一时刻只渲染一个视图、一个栏目。

- **工作台**（默认视图，默认栏目 = 聊天）：侧栏顶部是横向切换条（`components/WorkspaceNav.tsx`，聊天 / 任务），切换条下方紧接当前栏目的上下文列表：
  - **聊天**（默认）：上下文列表 = 会话清单（`components/ConversationList.tsx`：智能体选择 / 新建对话 / 会话清单）；内容区 = 消息流 + 输入区（`components/ChatPanel.tsx`），助手输出流式回显，可中止当前轮。聊天**独立于**工作流与任务——选中智能体即可开聊，不产生 run、不推进阶段。同一时刻只处理当前选中会话的事件流。
  - **任务**：上下文列表 = 工作流切换器（`components/WorkflowSwitcher.tsx`，只在任务栏目显示）；内容区 = 看板（列 = 当前工作流的阶段 + 末尾「已完成」落点）+ 右侧运行记录面板（按任务查看 run）。
- **看板交互**：新建任务时弹窗内选**起始阶段**；卡片**拖拽**到其它阶段列即进入该阶段，拖到「已完成」区即完成任务。看板不提供「通过 / 打回 / 推进」这类执行按钮。「执行中」由**是否有活跃 run**（`queued`/`running`）派生：只有此时卡片不可拖动/完成；`agent` 阶段失败后没有活跃 run，卡片可拖走重试或完成，由 run 结果自动推进的路径不变。
- **设置**：侧栏换成设置栏目（`components/SettingsNav.tsx`：运行时配置 / 智能体配置 / 工作流配置），内容区是当前栏目的内容；同一时刻只渲染一个栏目。
- app 间切换归 shell 顶部栏，app 侧栏里**不出现**其它 app 的入口。

三类配置归在设置里，工作台不出现任何配置入口：

- **运行时配置**：已配置运行时清单（健康状态、CLI 版本、启动头、负载、路径）；上方是「已安装的运行时」检测清单（自动扫描本机 CLI，点「使用」打开并预填新建表单）。每条已配置运行时提供「测试」做探测（见「运行时探测与健康」），可编辑（含删除）。
- **智能体配置**：已配置智能体清单（名称、绑定运行时、描述、能力）。
- **工作流配置**：工作流定义清单（新建 / 选择 / 编辑）。

规则：

- 配置项**只在设置的对应栏目内出现**，工作台不展示任何配置表单。
- 新增类配置一律**点「新建…」才弹出表单**（居中模态 `components/ui/dialog.tsx`），页面默认只显示清单——不出现「一进页面就是一张空表单」。
- 表单提交失败：错误显示在弹窗内，弹窗保持打开；清单类操作（删除、刷新列表）失败：错误显示在页面上。

## Tech Stack

- 与 shell 相同：Electron 45 + electron-vite 6 + React 19 + TypeScript 6（strict）。
- 样式：Tailwind 4 + `components/ui/`（shadcn 风格），复用 `src/renderer/src/lib/cn.ts`。
- 存储：**SQLite，使用 Node 内置 `node:sqlite`**（不引原生模块、不引 better-sqlite3）；数据库文件在**主进程**打开与读写。
- 进程执行：主进程 `child_process.spawn` 本机 CLI，经 `--stdio` 版本化 JSONL 协议通信；协议族后端可注入（测试用假进程/假流，不启真进程）。
- 测试：Vitest + @testing-library/react。

## Commands

同 shell（pnpm）：

```
Dev:      pnpm dev
Build:    pnpm build
Test:     pnpm test            # vitest run
Coverage: pnpm run test:coverage
Lint:     pnpm run lint
Check:    pnpm check           # typecheck + lint + test:coverage（提交前必过）
```

## Project Structure

```
src/renderer/src/apps/ai-workflow/
├── index.tsx                  # AppDefinition（aiWorkflowApp：id/name/icon/component）
├── AiWorkflowPage.tsx         # 布局：工作台 / 设置 双视图（见「界面结构」）
├── api.ts                     # 对 window.aiWorkflow 的薄封装（类型安全）
├── model/
│   ├── types.ts               # 领域实体类型（Runtime/Agent/Workflow/Stage/Task/Run）
│   ├── stage-machine.ts       # 纯函数：阶段流转/默认目标解析（不依赖 React、不做 IO）
│   └── stage-machine.test.ts
├── hooks/
│   ├── useWorkflow.ts         # 拉取数据 + 订阅 onChanged 失效刷新
│   └── useChat.ts             # 聊天状态机：会话增删选、消息拉取、流式事件、发送/中止
└── components/
    ├── WorkspaceNav.tsx       # 工作台侧栏顶部：横向「聊天 / 任务」切换条 + 上下文列表槽
    ├── ConversationList.tsx   # 聊天栏目的上下文列表：智能体选择 / 新建对话 / 会话清单
    ├── ChatPanel.tsx          # 聊天栏目内容区：消息流 + 输入区（流式回显、可中止）
    ├── WorkflowSwitcher.tsx   # 任务栏目侧栏：切换当前查看的工作流
    ├── WorkflowManager.tsx    # 工作流配置栏目：工作流清单（新建 / 选择 / 编辑）
    ├── SettingsNav.tsx        # 设置页左侧二级栏目（运行时 / 智能体 / 工作流）
    ├── KanbanBoard.tsx        # 列 = 阶段；卡片拖拽跨列 + 「已完成」落点
    ├── TaskCard.tsx           # 标题/描述/进入方式提示（可拖拽卡片）
    ├── TaskDialog.tsx         # 新建任务：标题/描述/起始阶段（居中模态）
    ├── WorkflowEditor.tsx     # 阶段增删改：进入时/完成后进入/打回退回到（模态内表单）
    ├── RuntimeManager.tsx     # 运行时配置页：检测清单 + 已配置清单（健康/负载/路径）+ 探测/编辑/删除
    ├── RuntimeStatusBadge.tsx # 运行时健康 pill（可用 / 不可用 / 未检测）
    ├── RuntimeDialog.tsx      # 新建/编辑运行时：命令/profile/权限模式/模型/推理强度/工作目录/并发/启用
    ├── AgentManager.tsx       # 智能体配置页：已配置清单
    ├── AgentDialog.tsx        # 新建智能体（居中模态）
    └── RunLog.tsx             # 运行记录：状态/耗时/退出码/errorCode/用量 + 事件流（运行中轮询增量）

src/main/ai-workflow/
├── db.ts                      # 打开 node:sqlite + 执行 schema/migration
├── schema.ts                  # v2 建表语句 + SCHEMA_VERSION（见「数据模型」）
├── migrate.ts                 # v1 → v2 迁移（12-step 重建 + user_version）
├── repository.ts              # CRUD（纯 SQL，无业务规则）
├── engine.ts                  # 阶段进入/流转效果（建 run、入队）
├── runner.ts                  # 调度：按运行时并发限流 → 执行 run → 写终态 → 触发阶段流转
├── chat.ts                    # ChatService：聊天轮次 + 会话续接 + 流事件（不写 runs）
├── runtime/
│   ├── registry.ts            # 协议族 → 后端（探测 / 模型目录 / 执行）
│   ├── dsh.ts                 # dsh stdio 协议：帧解析、探测、模型目录、执行与终止
│   ├── process.ts             # spawn 注入、行读取、进程树终止、输出尾部
│   ├── executable.ts          # 命令解析与 PATH 扫描
│   └── detect.ts              # 扫描本机已安装的 agent CLI（只读）
└── ipc.ts                     # 注册 ai-workflow IPC handlers

src/shared/ai-workflow-api.ts  # 跨进程契约（preload 与 renderer 共用）
```

- `src/preload/index.ts` 增加 `window.aiWorkflow` 暴露（从 `ai-workflow-api.ts` 取类型）；`src/renderer/src/shared/api.d.ts` 增加全局声明。
- 注册：`src/renderer/src/shell/registry.ts` 加一行 `aiWorkflowApp`（外壳零改动）。

## 数据模型（SQLite）

> 单一数据库文件：`app.getPath('userData')/ai-workflow.db`。时间戳用 ISO 字符串；id 用 `crypto.randomUUID()`。schema 版本记在 `PRAGMA user_version`。

| 表                   | 关键字段                                                                                                                                                                                                                         | 说明                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `runtimes`           | id, name(uniq), protocol_family, command, profile, permission_mode, model, reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at                                                                       | 运行时 = 本机执行环境实例；`last_probe_json` 存最近一次探测结论（从未探测为 NULL）              |
| `agents`             | id, name, description, runtime_id → runtimes, system_prompt, created_at                                                                                                                                                          | 智能体 = 运行时 + 能力（System Prompt）                                                         |
| `workflows`          | id, name, description, created_at                                                                                                                                                                                                | 工作流                                                                                          |
| `workflow_stages`    | id, workflow_id → workflows, name, position, entry_mode, agent_id → agents?, on_complete_stage_id → workflow_stages?, on_reject_stage_id → workflow_stages?, created_at                                                          | `entry_mode` = `none`\|`agent`\|`user`；`position` 决定顺序，`(workflow_id, position)` 唯一     |
| `tasks`              | id, title, description, workflow_id → workflows, current_stage_id → workflow_stages, status, created_at, updated_at                                                                                                              | `status` = `active`\|`completed`                                                                |
| `runs`               | id, task_id → tasks, stage_id → workflow_stages, agent_id → agents, runtime_id → runtimes(SET NULL), status, prompt, output, error, error_code, exit_code, session_id, usage_json, duration_ms, started_at, ended_at, created_at | `status` = `queued`\|`running`\|`succeeded`\|`failed`\|`cancelled`；`error_code` 见「终态归一」 |
| `run_events`         | run_id → runs(CASCADE), seq, type, payload_json, created_at                                                                                                                                                                      | 运行事件流；`(run_id, seq)` 唯一，按 `seq` 排序；`payload_json` 存事件其余字段                  |
| `chat_conversations` | id, title, agent_id → agents(RESTRICT), session_id, created_at, updated_at                                                                                                                                                       | 一段独立对话：绑定智能体；`session_id` 供下一轮续接，`updated_at` 决定会话列表顺序              |
| `chat_messages`      | id, conversation_id → chat_conversations(CASCADE), role, content, error, created_at                                                                                                                                              | `role` = `user`\|`assistant`；助手消息的 `error` 记录失败原因（非零退出/超时/取消）             |

外键约束开启（`PRAGMA foreign_keys = ON`）。删除工作流级联删除其阶段/任务/运行；删除被引用的运行时/智能体前先校验或拒绝（见 Boundaries）；运行时被删后 `runs.runtime_id` 置空、历史 run 保留。

**迁移（v1 → v2，`user_version` 1 → 2）：** 按 SQLite 12-step 重建 `runtimes` / `runs` / `chat_conversations`（v2 删掉了 v1 的 `kind` / `args_template` / `prompt_mode`，且新列带 CHECK），新增 `run_events`，最后写 `PRAGMA user_version = 2`。**已有数据保留**：旧运行时按 v2 默认值补齐（`protocol_family=dsh`、`profile=multica`、`permission_mode=workspace-write`、`max_concurrent=1`），旧 run 的 `runtime_id`/`session_id`/`usage_json`/`duration_ms` 为 NULL、`error` 非空的失败 run 归 `exit_nonzero`，旧对话 `session_id` 为 NULL。迁移期间临时关闭外键，失败回滚。不做 v1 兼容读取。

## 阶段状态机（核心规则）

阶段流转是**纯逻辑**，集中在 `src/shared/stage-machine.ts`（主进程与 renderer 共用，不依赖 React、不做 IO），UI 与主进程只提交事件、执行效果（创建 run、写库、spawn 进程）。风格对齐 pomodoro 的 reducer：规则一条都不写在组件里。

**任务状态：** `active`（在看板中）| `completed`（已走完终端阶段，移出看板）。

**目标解析（默认值，仅用于 run 结果自动流转）：**

- `on_complete` 目标：显式配置 → 该阶段；未配置 → **下一顺序阶段**；已无下一阶段 → 任务 `completed`。
- `on_reject` 目标：显式配置 → 该阶段；未配置 → **上一顺序阶段**；已是首阶段 → 留在原地。

手动拖拽**不套用**上面两个目标：落点即目标阶段（可跨阶段前跳/后退）。

**事件与转移：**

| 事件               | 触发时机                     | 行为                                                                                                                                  |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ENTER(stage)       | 新建任务 / 流转到某阶段      | 按该阶段 `entry_mode`：`none` 停留等待手动操作；`agent` 创建一条 `queued` run（交给 `agent_id`，视为执行中）；`user` 置为"等待你处理" |
| RUN_SUCCEEDED(run) | agent run 正常结束           | 进入 `on_complete` 目标；到终端则 `completed`                                                                                         |
| RUN_FAILED(run)    | agent run 非零退出/超时/异常 | 进入 `on_reject` 目标；若目标就是当前阶段（首阶段未配置打回目标，或显式配置为自身）则保持原阶段、**不触发进入效果**（不自动重建 run） |
| MOVE_TO(stage)     | 用户把卡片拖到某个阶段列     | 直接进入该阶段（不套用 `on_complete`/`on_reject`）；该任务有活跃 run 时拒绝拖动                                                       |
| COMPLETE           | 用户把卡片拖到「已完成」区   | 任务 `completed`，移出看板；该任务有活跃 run 时拒绝完成                                                                               |

**流转即触发进入：** 每次进入新阶段都重新按 `entry_mode` 产生对应效果（可能再次创建 run），即"SOP 串联"。

**打回原地不重试：** `RUN_FAILED` 时若 `on_reject` 解析结果就是当前阶段（首阶段未配置打回目标，或显式配置为自身），任务保持原阶段、不产生 effects——避免 agent 阶段失败后立刻重建 run 形成无限自动重试；此时卡片可拖走重试或完成（见下）。

**执行中 = 有活跃 run：** `queued`/`running` run 才算执行中，由 `runs` 现算（不落库、不看阶段配置）；`tasks.moveToStage`/`tasks.complete` 只在存在活跃 run 时拒绝。任务的阶段在其 run 结束前不变。

**并发：** 同一运行时按 `maxConcurrent` 限流，超出上限的 run 保持 `queued` 按创建顺序执行；不同运行时并行。

## 运行时（v2，2026-11-03 重做）

> 对齐 Multica：运行时 = 本机执行环境实例 = 协议族后端 + 启动方式 + 执行策略；进程间用版本化 JSONL 协议通信，健康由 `--probe` 帧给出。旧实现（`command` + 空格分隔 `args` + `promptMode` + 通用 spawn + 探测真跑一次 prompt）已删除，不保留兼容字段。

### 运行时模型

| 字段              | 说明                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `protocolFamily`  | 协议族；当前仅 `dsh`。新增协议 = 新增后端实现，不改 UI 契约                                                                               |
| `command`         | 启动命令：命令名或绝对路径（默认 `dsh`）                                                                                                  |
| `profile`         | 协议 profile（默认 `multica`）；由该 profile 提供 `--stdio` / `--probe` / `--list-models`                                                 |
| `permissionMode`  | `read-only` / `workspace-write` / `danger-full-access`；经 `DSH_PERMISSION_MODE` 传入子进程。stdio 传输**没有审批往返**，越界操作直接失败 |
| `model`           | provider/model 形式 id；`null` = CLI 默认模型                                                                                             |
| `reasoningEffort` | 推理强度；`null` = 模型默认                                                                                                               |
| `workdir`         | 执行工作目录；`null` = 主进程当前目录                                                                                                     |
| `maxConcurrent`   | 同一运行时同时执行的 run 上限，超出排队                                                                                                   |
| `enabled`         | 停用后不再派发执行                                                                                                                        |
| `lastProbe`       | 最近一次探测结论（见下）；从未探测为 `null`                                                                                               |

- 契约中 `RuntimeInput` 除 `name` 外均可省略，省略时取默认值：`protocolFamily=dsh`、`command=dsh`、`profile=multica`、`permissionMode=workspace-write`、`maxConcurrent=1`（取值 1–8，超出按 8 归一）、`enabled=true`、`model/reasoningEffort/workdir=null`。
- 命令解析：命令名扫 PATH + 常见全局目录；带路径分隔符的按路径处理，找不到即失败（不做模糊回退）。Windows 下 `.cmd`/`.bat` 经 shell 启动。
- 凭据：沿用本机 CLI 已有的登录态，**不把任何 token 存进数据库**。

### 探测与健康

- `dsh --profile <p> --probe` 输出**一帧** `{ v: 1, type: 'probe', runtime: 'dsh', protocol_version, plugin_version }`；配合 `dsh --version` 解析 CLI 版本（读取超时 15s）。
- 结论 = `RuntimeProbe` 并持久化到运行时行（`lastProbe`）：`state`（`ready` / `unavailable`）、`path`（可执行文件绝对路径，解析失败为 null）、`cliVersion`、`protocolVersion`、`pluginVersion`、`error`、`output`（诊断输出尾部，最多 4000 字符）、`elapsedMs`、`checkedAt`。
- `state=ready` 仅当 probe 帧合法、`v=1`、`protocol_version=1` 且 `runtime='dsh'`；否则 `unavailable` 并记 `error`：找不到可执行文件 / 启动失败 / 探测超时（60s）/ 无 probe 帧（含非零退出）/ 协议版本不兼容。
- **不产生 run、不调用模型**；`runtimes.detect` 只读（不写库），`runtimes.probe` 把结论写回 `lastProbe`。
- `runtimes.create`：先探测，失败抛错且**不落库**；`runtimes.update`：保存后重新探测并落库最新结论（探测失败不抛错）。
- 负载不落库：`runtimes.statuses()` 按 `runs` 现算 `running` / `queued` / `maxConcurrent`（无活跃 run 记 0）。
- UI：健康 pill = 可用（`ready`）/ 不可用（`unavailable`）/ 未检测（`lastProbe=null`）；行内展示 CLI 版本、启动头 `dsh --profile <p> --stdio`、路径、负载 `running/maxConcurrent`；「测试」调用 `probe` 并展示耗时与失败原因。

### 检测（detect）

`runtimes.detect` 扫描本机已安装的 agent CLI，返回 `DetectedRuntime[]`：

```ts
export interface DetectedRuntime {
  command: string // CLI 命令名，如 dsh / claude
  label: string // 展示名，如 "DeepSeek Harness"
  path: string // 可执行文件绝对路径
  supported: boolean // 当前版本是否可作为运行时接入（协议后端已实现）
}
```

- **扫描目录**：`process.env.PATH` 全部条目 + 常见全局安装目录（Windows：`%APPDATA%/npm`、`~/.local/bin`、`~/.claude/local`、`%ProgramFiles%/nodejs`；POSIX：`~/.local/bin`、`~/.npm-global/bin`、`~/.bun/bin`、`~/.claude/local`、`/usr/local/bin`、`/opt/homebrew/bin`）；不存在的目录跳过。
- **候选清单**（固定顺序）：`dsh`、`claude`、`codex`、`gemini`、`opencode`、`aider`、`cursor-agent`、`qwen`、`goose`、`crush`。`supported` 仅 `dsh` 为 true（其余只展示，暂不可接入）。
- **命中判定**：Windows 命中 `<cmd>.exe|.cmd|.bat|.ps1` 任一（npm 全局装的是 shim）；POSIX 命中同名且有可执行位（`mode & 0o111`）。同一命令多处命中取 PATH 中靠前者。
- **零副作用**：不 spawn 任何进程、不读版本号，只读文件系统。
- **UI 行为**：运行时配置页顶部列出检测结果与路径；`supported=true` 显示「使用」打开新建表单并预填 `label`/`command`（名称与现有运行时重名时改为 `label (command)`），`supported=false` 显示「暂不支持」并禁用；已添加过的命令显示「已添加」并禁用按钮。检测只影响表单预填，不新建运行时记录。

### 执行协议（`dsh --profile <p> --stdio`，JSONL v1）

- 每个 run 启动一个子进程：`dsh --profile <p> --stdio`；stdin / stdout 逐行 JSON，stderr 只保留尾部用于诊断。
- stdin 帧：

| 帧        | 内容                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `execute` | `{ v: 1, type: 'execute', request_id, cwd, prompt, model?, reasoning_effort?, resume_session_id?, mcp_servers: [] }` |
| `cancel`  | `{ v: 1, type: 'cancel', request_id }`                                                                               |

- stdout 帧 → 事件 / 结果：

| 帧               | 处理                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `ready`          | 校验 `runtime='dsh'`；不产生事件                                   |
| `session`        | 记 `session_id`（供聊天续接），并发一条 `status` 事件（`running`） |
| `text`           | 追加 `RunEvent{type:'text'}`，并计入 run.output                    |
| `thinking`       | 追加 `RunEvent{type:'thinking'}`，不并入 output                    |
| `tool_call`      | 追加 `RunEvent{type:'tool_call'}`（tool/callId/input）             |
| `tool_result`    | 追加 `RunEvent{type:'tool_result'}`（tool/callId/output/isError）  |
| `usage`          | 累加到 `run.usage`（input/output/cacheRead/cacheWrite）            |
| `result`         | 终态（见「终态归一」），可带 `resume_rejected`                     |
| `protocol_error` | 记协议错误，终态归 `protocol_error`                                |
| `models`         | 仅 `--list-models` 使用，run 流中不出现                            |

- 校验：帧 `v` 必须为 `1`（否则记 `protocol_error`）；带 `request_id` 的帧必须匹配当前请求，不匹配则忽略。未知帧类型忽略；非 JSON 行忽略（不产生事件、不致命、不计数）。
- 事件**只来自协议帧**，不从原始文本猜测；stderr 不作为模型输出。
- `execute` 的 `model` 为 `{ provider, id }`（由运行时 `provider/model` id 解析；格式不对直接失败并归 `run_failed`）；`reasoning_effort` 仅在配置非空时发送。
- `mcp_servers` 当前固定空数组（协议预留，不做 MCP 注入）。

### 取消、超时与进程树

- 取消：先写 `cancel` 帧 → **3s** 宽限 → `SIGTERM` → **2s** 后 `SIGKILL`；Windows 用 `taskkill /T /F` 杀进程树（POSIX 按进程组发信号）。
- 超时：默认 **30 分钟**（`RUN_TIMEOUT_MS`，契约未暴露配置项）→ 走与取消相同的终止流程，终态 `timeout`。
- 子进程无法启动或 execute 帧写不进去 → `spawn_failed`；异常退出 → `exit_nonzero`；始终没有 `result` 帧 → `no_result`；未收到 `ready` 就退出 → `protocol_error`。

### 终态归一

| 终态      | `run.status`               | `errorCode`                                                                                                              |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| succeeded | `succeeded`                | null                                                                                                                     |
| failed    | `failed`                   | `spawn_failed` / `exit_nonzero` / `run_failed` / `protocol_error` / `no_result` / `runtime_missing` / `runtime_disabled` |
| cancelled | `cancelled`                | `cancelled`                                                                                                              |
| timeout   | `failed`（timeout 计失败） | `timeout`                                                                                                                |

`result` 帧的 `status` 归一：`completed`/`succeeded`/`success` → succeeded；`cancelled`/`canceled`/`aborted` → cancelled；`timeout`/`timed_out` → timeout；其余 → failed。

| `errorCode`        | 含义                                                        |
| ------------------ | ----------------------------------------------------------- |
| `spawn_failed`     | 子进程启动失败，或 execute 帧无法写入                       |
| `exit_nonzero`     | 进程非零退出且没有 `result` 帧                              |
| `run_failed`       | `result` 帧报失败但无更具体归类；后端抛错；模型 id 格式不对 |
| `timeout`          | 执行超时（run 计 `failed`）                                 |
| `cancelled`        | 用户取消（run 计 `cancelled`）                              |
| `protocol_error`   | 协议帧错误，或未就绪就退出                                  |
| `no_result`        | 进程结束但没有终态结果                                      |
| `runtime_missing`  | 运行时不存在（被删）                                        |
| `runtime_disabled` | 运行时已停用                                                |

- `runs` 记录 `runtime_id`、`session_id`、`error_code`、`exit_code`、`duration_ms`、`usage`（列 `usage_json`）；运行事件另存 `run_events`（`seq` 单调递增；`payload_json` 存事件其余字段；`output` = `text` 汇总）。
- 运行时被删后 `runs.runtime_id` 置空（历史记录保留）。

### 会话与续接

- **工作流任务**：每次 run 全新会话，不续接。
- **聊天**：首轮发完整 prompt（System Prompt + 历史 + 结尾提示）；对话保存 `session_id` 后，下一轮 `execute` 带 `resume_session_id`、**只发新消息**，不重发整段历史。若 `result` 帧 `resume_rejected=true`，清空本地会话并用完整历史重试一次；重试仍失败按失败落库。
- 会话由 dsh profile 持久化，主进程可通过 `MULTICA_DSH_SESSION_ROOT` 指定会话目录。

### 调度

- 同一运行时按 `maxConcurrent` 限流：超出上限的 run 保持 `queued`，队列全局 FIFO；不同运行时并行。
- 运行时不存在 / 已停用时不派发，run 直接 `failed` 并记 `runtime_missing` / `runtime_disabled`。
- `runner.ts` 负责：入队、取 `queued` run、写 `running`/`ended_at`、累积事件与输出、按终态触发 `RUN_SUCCEEDED`/`RUN_FAILED`，并 `webContents.send('ai-workflow:changed')`。取消的 run 不推进阶段。

## IPC 契约（`window.aiWorkflow`）

契约定义在 `src/shared/ai-workflow-api.ts`，preload 原样透传，renderer 禁止直接 import electron/fs/child_process。

```ts
export interface AiWorkflowApi {
  runtimes: {
    list(): Promise<Runtime[]>
    /** 创建前先探测；探测失败抛错且不落库 */
    create(input: RuntimeInput): Promise<Runtime>
    /** 保存后重新探测并落库最新结论（不抛探测错误） */
    update(id: string, patch: Partial<RuntimeInput>): Promise<Runtime>
    remove(id: string): Promise<void>
    /** 扫描本机已安装的 agent CLI（只读，不写库） */
    detect(): Promise<DetectedRuntime[]>
    /** 真实探测一次（--probe + --version），把结论写入运行时；不产生 run */
    probe(id: string): Promise<RuntimeProbe>
    /** 各运行时的实时负载（按 runs 现算，不落库） */
    statuses(): Promise<RuntimeStatus[]>
    /** 读取该运行时的模型目录（--list-models）；失败抛错 */
    models(id: string): Promise<RuntimeModelOption[]>
  }
  agents: { list(): Promise<Agent[]>; create(...): ...; update(...): ...; remove(id): Promise<void> }
  workflows: {
    list(): Promise<WorkflowWithStages[]>      // 含有序 stages
    create(input: WorkflowInput): Promise<WorkflowWithStages>
    update(id: string, patch: WorkflowInput): Promise<WorkflowWithStages>  // 含阶段增删改
    remove(id: string): Promise<void>
  }
  tasks: {
    list(workflowId: string): Promise<Task[]>
    create(input: TaskInput): Promise<Task>              // TaskInput.stageId 可指定起始阶段，缺省首阶段
    /** 看板拖拽：直接进入目标阶段，并执行该阶段进入效果 */
    moveToStage(id: string, stageId: string): Promise<Task>
    /** 看板拖拽到「已完成」区 */
    complete(id: string): Promise<Task>
    remove(id: string): Promise<void>
  }
  runs: {
    listByTask(taskId: string): Promise<Run[]>
    /** 该 run 的事件流（运行中可轮询增量） */
    events(runId: string): Promise<RunEvent[]>
  }
  chat: {
    listConversations(): Promise<ChatConversation[]>
    createConversation(agentId: string): Promise<ChatConversation>
    removeConversation(id: string): Promise<void>
    listMessages(conversationId: string): Promise<ChatMessage[]>
    /** 发起一轮：用户消息落库后返回，输出经 onEvent 流式推送 */
    send(conversationId: string, content: string): Promise<void>
    /** 中止该对话正在执行的一轮（无执行中轮次时静默返回） */
    cancel(conversationId: string): Promise<void>
    /** 订阅流事件：{type:'event', event:RunEvent} | {type:'end'}；返回取消订阅函数 */
    onEvent(cb: (event: ChatStreamEvent) => void): () => void
  }
  /** 任意变更/运行进度后触发；返回取消订阅函数 */
  onChanged(cb: () => void): () => void
}
```

- 主进程在每次写操作与 run 进度变化后发 `ai-workflow:changed`；renderer 收到后失效重取（对齐 Multica「事件失效缓存」的做法）。`runtimes.detect` 只读，不发 changed。
- 聊天流走**单独通道** `ai-workflow:chat`：每条 `RunEvent` 以 `{type:'event', event}` 推送，一轮结束时推 `{type:'end'}`（此时结果已落库），renderer 收到 `end` 再重取消息与会话列表。聊天不写 `runs`/`run_events`，也不进入 runner 队列。
- 运行事件流只来自协议帧：`RunEvent` 的 `text`/`thinking`/`tool_call`/`tool_result`/`status` 与协议帧一一对应，不从原始文本猜测；stderr 不作为模型输出。
- 契约新增**不得**改动既有 `window.workbench.notify` 等 shell 契约；只新增 `window.aiWorkflow` 命名空间。

## Code Style

同 shell（TS strict；组件 PascalCase、函数/变量 camelCase、常量 UPPER_SNAKE_CASE；命名导出）。核心风格——阶段流转是纯函数，返回新状态与待执行效果：

```ts
export type StageEffect =
  { type: 'createRun'; stageId: string; agentId: string } | { type: 'waitUser' } | { type: 'none' }

/** 纯函数：不读写库、不 spawn；由 runner/UI 执行返回的 effects */
export function moveTask(
  task: Task,
  event: StageEvent, // RUN_SUCCEEDED | RUN_FAILED（自动流转）
  workflow: WorkflowWithStages,
): { task: Task; effects: StageEffect[] }

/** 纯函数：看板拖拽 —— 落点即目标阶段，不套用 on_complete / on_reject */
export function moveTaskToStage(
  task: Task,
  stageId: string,
  workflow: WorkflowWithStages,
): { task: Task; effects: StageEffect[] }

/** 纯函数：拖到「已完成」区 */
export function completeTask(task: Task): Task
```

## Testing Strategy

- 框架：Vitest + @testing-library/react，测试统一放 `tests/`，与 `src/` 同构镜像（`src/main/ai-workflow/db.ts` ↔ `tests/main/ai-workflow/db.test.ts`，文件名后缀 `*.test.ts(x)`）。
- **阶段状态机（重点，要求分支全覆盖）：** `stage-machine.ts` 纯函数单测——三种 `entry_mode` 的进入效果、`on_complete`/`on_reject` 显式配置与默认解析（下一阶段 / 上一阶段 / 终端 completed / 首阶段原地）、多阶段串联、终端完成、`RUN_FAILED` 打回原地时无 effects（不重试）；以及 `moveTaskToStage`（跨阶段落点、目标不存在、落在当前阶段、已完成不参与）与 `completeTask`。
- **repository：** 用临时 SQLite 文件（或 `:memory:`）测 CRUD 与外键/唯一约束、级联删除、被引用拒绝、起始阶段校验；聊天表另测会话顺序（`updated_at`）、消息顺序（同毫秒按 rowid）、删对话级联删消息、智能体被对话引用时拒绝删除。
- **runner：** 注入假协议后端（不启真进程）测同运行时 `maxConcurrent` 限流、多运行时并行、成功/失败/取消/超时 → 终态与 `errorCode` → 触发流转 → `changed` 事件；运行时缺失/停用路径。
- **运行时探测：** 注入假进程/假流测 `--probe` 帧成功、非零退出、超时、spawn 失败、输出截断、`--version` 解析，并断言不产生 run；另一条用真实 `node -e` 覆盖默认 spawn 路径（不联网）。
- **协议后端：** 逐帧解析（ready/session/text/thinking/tool_call/tool_result/usage/result/protocol_error）、`v`/`request_id` 校验、非 JSON 行忽略、usage 累加、终态归一（含 `run_failed`）；取消信号顺序（cancel 帧 → 3s → SIGTERM → 2s → SIGKILL，Windows `taskkill /T /F`）与进程树终止；`--list-models` 投影。
- **聊天服务：** 假协议后端 + 内存库测 `resume_session_id` 续接（只发新消息）、`resume_rejected` 自动重试一次、事件→落库→end 顺序、非零退出/超时/取消失败落库、并发第二次 `send` 拒绝、对话执行中被删仍正常收尾。
- **IPC：** handler 层 mock 依赖，验证参数透传与返回；`onChanged` 订阅/退订；拖拽/完成的非法路径（有活跃 run、目标阶段无效）；`runtimes.probe` 写回 `lastProbe`、`detect` 只读不发 changed、`statuses`/`models` 路由与失败抛错；`chat.*` 路由与「聊天服务未就绪」。
- **组件：** KanbanBoard 按阶段分列渲染任务，拖拽卡片到列触发 `moveToStage`、拖到「已完成」区触发 `complete`；TaskCard 可拖拽（有活跃 run 时不可拖）并按进入方式显示提示；TaskDialog 选择起始阶段；WorkflowEditor 编辑阶段三项目标；RuntimeManager 健康 pill（可用/不可用/未检测）、CLI 版本、负载、探测按钮 pending/成功/失败、行间独立；RuntimeDialog 字段与校验、模型下拉；RunLog 事件流（text/thinking/tool 折叠、运行中轮询、errorCode 文案、用量/退出码/耗时）；WorkspaceNav 切换条两个栏目切换并渲染上下文列表槽；ConversationList 的智能体选择/新建/选中/删除；ChatPanel 的草稿、Enter 发送、Shift+Enter 换行、发送中中止、空会话与错误提示。
- **聊天 hook（`useChat`）：** 新建/发送/`event` 流式回显/`end` 落库重载/中止/删除/各类错误分支、卸载退订、只处理当前会话的增量。
- **页面：** 两栏布局下工作台默认落在「聊天」栏（侧栏顶部切换条 + 会话列表可见、设置栏目不可见），切「任务」显示看板与运行记录并隐藏输入区，侧栏底部「工作台/设置」分段控件切换视图，设置三栏目互不混排。
- 覆盖率：`stage-machine.ts` 分支覆盖 100%；其余按 `pnpm check` 阈值。

## Boundaries

- **Always：** 阶段流转/默认目标解析只写在 `stage-machine.ts`；SQLite 只在主进程读写，renderer 一律经 `window.aiWorkflow`；进程执行经可注入的协议后端，事件只来自协议帧；提交前 `pnpm check` 通过。
- **Ask first：** 新增 npm 依赖（尤其原生模块）；修改 shell 的 `AppDefinition` 或既有 `WorkbenchApi` 契约；改变数据库文件位置或引入迁移框架；新增协议族（`protocolFamily` 当前仅 `dsh`）。
- **Never：** 在 renderer 直接 `require('electron')`/用 `fs`/`child_process`；把业务规则写进组件；把凭据/token 明文写库；从原始文本猜测事件或把 stderr 当模型输出；删除失败测试或改测试预期来掩盖问题。

## Success Criteria

1. 能添加一个 DeepSeek Harness 运行时（创建前探测通过、健康为可用）、建一个绑定它的智能体，重启后仍在（数据落 SQLite）。
2. 能建一条含 ≥3 阶段的工作流，逐阶段配置【进入时】【完成后进入】【打回时退回到】；`none`/`agent`/`user` 三种进入方式均可保存并在看板生效。
3. 新建任务时可指定**起始阶段**（默认首阶段）；`agent` 阶段经 `--stdio` 协议真实执行并回写事件流与输出，成功后按 `on_complete` 推进、失败/超时按 `on_reject` 退回（由假协议后端单测证明流转；DSH 真跑作为手动验收）。
4. `user` 阶段卡片显示"等待你处理"；把卡片拖到其它阶段列即进入该阶段（落点为准，不限于 `on_complete`/`on_reject`）；有活跃 run 时卡片不可拖动/完成，agent 阶段失败后（无活跃 run）可拖走重试或完成。
5. 自动流转走完全部阶段且无下一阶段时任务 `completed`；手动拖到「已完成」区同样 `completed` 并移出看板。
6. 运行记录（状态、耗时、退出码、errorCode、用量、事件流）可在任务详情查看；同一运行时按 `maxConcurrent` 限流，多运行时并行。
7. 运行时配置页对每条已配置运行时显示健康 pill（可用/不可用/未检测）与负载；点「测试」得到探测结论（CLI 版本、协议版本、耗时、失败原因）；探测不产生 run。
8. 工作台默认落在「聊天」栏（单列侧栏 + 内容区）：侧栏顶部可在聊天/任务间切换，聊天栏可新建对话、选智能体、发消息并看到流式输出，可中止；切到「任务」栏侧栏换成工作流切换器、内容区看到看板与运行记录；侧栏底部切「设置」进入配置视图。
9. 聊天记录落 SQLite（含会话 `session_id`）：新建对话、消息、标题在重启后仍在；删除对话级联删除其消息；同一对话第二轮续接会话，`resume_rejected` 时自动重试一次。
10. 阶段状态机分支覆盖 100%；`pnpm check` 全绿。
11. 顶部栏出现"AI 工作流"标签并可切换（由 shell 承载，app 无需感知）。

## Out of scope（本 MVP 不做）

- 远端 Worker / 多设备执行 / 登录与多用户（仅留架构位）。
- Postgres / Redis 等外部服务；除 SQLite 外无其它存储。
- 多审批人、超时提醒、打回的多级语义、审批意见流。
- 其它协议族的后端实现（claude code / codex 等）：`protocolFamily` 当前仅 `dsh`。
- stdio 审批往返：权限越界直接失败，不弹审批。
- MCP server 注入：协议字段 `mcp_servers` 固定空数组（仅预留）。
- 统计分析、成本/token 看板、任务依赖图（`usage` 已记录，不做统计视图）。
- 聊天的多轮并行（同一对话同一时刻只跑一轮）、附件/图片、消息编辑与重新生成、跨对话搜索、对话与任务/阶段绑定。

## Open Questions

1. **打回默认目标**：未配置【打回时退回到】时，按"退回上一阶段（首阶段原地）"执行；如需默认原地或其它，请指出。
2. **`none` / `user` 阶段的推进方式**：看板上把卡片拖到目标阶段（已按此实现，不再有「推进 / 通过 / 打回」按钮）。
3. **终端阶段**：最后阶段完成后任务置 `completed` 并移出看板；看板末尾的「已完成」区只是拖拽落点（显示已完成数量），不是可反向拖出的虚拟列。
4. **运行时工作目录**：`workdir` 为 `null` 时用主进程当前目录（契约已定）；若希望按任务/项目指定，另行设计。
