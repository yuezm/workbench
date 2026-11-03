# Spec: ai-workflow（个人AI工作流）

> Module id：`ai-workflow`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。依赖 `shell`。确认日期：2026-11-02。
>
> 本 Spec 为 MVP：**本地单机最小闭环**。远端 Worker 仅留架构位、不实现（见 Open Questions / Out of scope）。设计参考 Multica 的「本地 UI/状态 + 本机 CLI 执行」边界。

## Objective

在工作台内新增 `ai-workflow` app：把「运行时 → 智能体 → 自定义多阶段工作流 → 看板任务」串成一个能在本地跑起来的最小闭环。

- 配置**运行时**：MVP 只打通本机已安装的 **DeepSeek Harness** CLI；其余运行时（claude code / codex / oh-my-pi 等）后续按同一适配接口接入。
- **识别**已安装的运行时：运行时配置页扫描本机 PATH，自动列出已安装的 agent CLI，点「使用」打开新建表单并把名称与命令预填进去（不自动建记录，参数仍由用户确认）。
- 配置**智能体**：名称、描述、执行配置（绑定某个运行时）、能力（System Prompt）。
- 配置**工作流**：一条有序的**阶段**序列；每个阶段可设【进入时】【完成后进入】【打回时退回到】。
- 用**看板**查看与推进任务：列 = 当前所选工作流的阶段；新建任务时可选**起始阶段**，之后把卡片**拖拽**到其它阶段列（或「已完成」区）推进，不设执行按钮。

**用户故事：**

- 作为使用者，我添加一个"DeepSeek Harness"运行时，再建一个绑定它的智能体。
- 作为使用者，我建一条工作流（如"研发：待办 → 进行中 → 审核中 → 已完成"），把"进行中"配成进入时交给某智能体、把"审核中"配成进入时交给用户审批。
- 作为使用者，我新建一个任务时选好工作流与**起始阶段**；任务进入该阶段，按阶段配置自动交给智能体执行或停下等我处理；我在看板上把卡片**拖到**其它阶段列，卡片随之流转；拖到「已完成」区即收尾。
- 作为使用者，关掉工作台再打开，我的运行时/智能体/工作流/任务/运行记录都还在。

## 界面结构（2026-11-03 调整；同日改为拖拽推进）

app 内只有一个页面，顶部用分段控件（`components/ui/segmented.tsx`）在两个互斥视图间切换：**工作台 / 设置**。

- **工作台**（默认）：左侧看板（列 = 当前工作流的阶段 + 末尾「已完成」落点），右侧运行记录面板（按任务查看 run）。顶栏保留工作流切换器。
- **看板交互**：新建任务时弹窗内选**起始阶段**；卡片**拖拽**到其它阶段列即进入该阶段，拖到「已完成」区即完成任务。看板不提供「通过 / 打回 / 推进」这类执行按钮。`entry_mode=agent` 的当前阶段表示执行中，卡片不可拖拽，由 run 结果推进。
- **设置**：左侧是**二级栏目**（`components/SettingsNav.tsx`：运行时配置 / 智能体配置 / 工作流配置），右侧是当前栏目的内容区；同一时刻只渲染一个栏目的内容。

三类配置归在设置里，工作台不出现任何配置入口：

- **运行时配置**：已配置运行时清单；上方是「已安装的运行时」检测清单（自动扫描本机 CLI，点「使用」打开并预填新建表单）。
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
- 进程执行：主进程 `child_process.spawn` 调用本机 CLI，经**可注入的 `RuntimeAdapter`** 抽象，便于测试。
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
│   └── useWorkflow.ts         # 拉取数据 + 订阅 onChanged 失效刷新
└── components/
    ├── WorkflowSwitcher.tsx   # 看板顶部：切换当前查看的工作流
    ├── WorkflowManager.tsx    # 工作流配置栏目：工作流清单（新建 / 选择 / 编辑）
    ├── SettingsNav.tsx        # 设置页左侧二级栏目（运行时 / 智能体 / 工作流）
    ├── KanbanBoard.tsx        # 列 = 阶段；卡片拖拽跨列 + 「已完成」落点
    ├── TaskCard.tsx           # 标题/描述/进入方式提示（可拖拽卡片）
    ├── TaskDialog.tsx         # 新建任务：标题/描述/起始阶段（居中模态）
    ├── WorkflowEditor.tsx     # 阶段增删改：进入时/完成后进入/打回退回到（模态内表单）
    ├── RuntimeManager.tsx     # 运行时配置页：检测清单 + 已配置清单
    ├── RuntimeDialog.tsx      # 新建运行时（居中模态）
    ├── AgentManager.tsx       # 智能体配置页：已配置清单
    ├── AgentDialog.tsx        # 新建智能体（居中模态）
    └── RunLog.tsx             # 某任务的运行记录与输出

src/main/ai-workflow/
├── db.ts                      # 打开 node:sqlite + 执行 schema/migration
├── schema.sql                 # 建表语句（见「数据模型」）
├── repository.ts              # CRUD（纯 SQL，无业务规则）
├── runner.ts                  # 队列 + 调度：取 queued run → 调 adapter → 写结果 → 触发阶段流转
├── runtime/
│   └── deepseek-harness.ts    # RuntimeAdapter 的 DSH 实现
└── ipc.ts                     # 注册 ai-workflow IPC handlers

src/shared/ai-workflow-api.ts  # 跨进程契约（preload 与 renderer 共用）
```

- `src/preload/index.ts` 增加 `window.aiWorkflow` 暴露（从 `ai-workflow-api.ts` 取类型）；`src/renderer/src/shared/api.d.ts` 增加全局声明。
- 注册：`src/renderer/src/shell/registry.ts` 加一行 `aiWorkflowApp`（外壳零改动）。

## 数据模型（SQLite）

> 单一数据库文件：`app.getPath('userData')/ai-workflow.db`。时间戳用 ISO 字符串；id 用 `crypto.randomUUID()`。

| 表                | 关键字段                                                                                                                                                                | 说明                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimes`        | id, name(uniq), kind, command, args_template, prompt_mode, workdir, created_at                                                                                          | 运行时配置。`kind` MVP 固定 `deepseek-harness`；`args_template` 为 JSON 数组，元素可含 `{prompt}` 占位；`prompt_mode` = `stdin`\|`arg` |
| `agents`          | id, name, description, runtime_id → runtimes, system_prompt, created_at                                                                                                 | 智能体 = 运行时 + 能力（System Prompt）                                                                                                |
| `workflows`       | id, name, description, created_at                                                                                                                                       | 工作流                                                                                                                                 |
| `workflow_stages` | id, workflow_id → workflows, name, position, entry_mode, agent_id → agents?, on_complete_stage_id → workflow_stages?, on_reject_stage_id → workflow_stages?, created_at | `entry_mode` = `none`\|`agent`\|`user`；`position` 决定顺序，`(workflow_id, position)` 唯一                                            |
| `tasks`           | id, title, description, workflow_id → workflows, current_stage_id → workflow_stages, status, created_at, updated_at                                                     | `status` = `active`\|`completed`                                                                                                       |
| `runs`            | id, task_id → tasks, stage_id → workflow_stages, agent_id → agents, status, prompt, output, error, started_at, ended_at                                                 | `status` = `queued`\|`running`\|`succeeded`\|`failed`\|`cancelled`                                                                     |

外键约束开启（`PRAGMA foreign_keys = ON`）。删除工作流级联删除其阶段/任务/运行；删除被引用的运行时/智能体前先校验或拒绝（见 Boundaries）。

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
| ENTER(stage)       | 新建任务 / 流转到某阶段      | 按该阶段 `entry_mode`：`none` 停留等待手动操作；`agent` 置为执行中并创建一条 `queued` run（交给 `agent_id`）；`user` 置为"等待你处理" |
| RUN_SUCCEEDED(run) | agent run 正常结束           | 进入 `on_complete` 目标；到终端则 `completed`                                                                                         |
| RUN_FAILED(run)    | agent run 非零退出/超时/异常 | 进入 `on_reject` 目标                                                                                                                 |
| MOVE_TO(stage)     | 用户把卡片拖到某个阶段列     | 直接进入该阶段（不套用 `on_complete`/`on_reject`）；执行中的 `agent` 阶段不可拖出                                                     |
| COMPLETE           | 用户把卡片拖到「已完成」区   | 任务 `completed`，移出看板（执行中的 `agent` 阶段不可完成）                                                                           |

**流转即触发进入：** 每次进入新阶段都重新按 `entry_mode` 产生对应效果（可能再次创建 run），即"SOP 串联"。

**并发：** MVP 单并发——同一时刻最多一个 `running` run，其余 `queued` 按创建顺序串行执行。任务的阶段在其 run 结束前不变（执行中的卡片不可拖拽）。

## 执行与运行（RuntimeAdapter）

```ts
export interface RunInput {
  prompt: string // 由任务标题+描述+阶段名+智能体 System Prompt 组装
  workdir: string
  signal: AbortSignal
  onOutput(chunk: string): void // 实时输出回写（可存 runs.output）
}
export interface RuntimeAdapter {
  run(input: RunInput): Promise<{ code: number; output: string }>
}
```

- MVP 唯一实现 `deepseek-harness.ts`：按运行时的 `command` + `args_template`（`{prompt}` 占位替换，或 `prompt_mode=stdin` 走标准输入）`spawn` 本机 CLI，`workdir` 取运行时配置。
- `runner.ts` 负责：入队、串行取出、写 `running`/`ended_at`、累积 `output`、结束后据结果触发 `RUN_SUCCEEDED`/`RUN_FAILED`，并 `webContents.send('ai-workflow:changed')`。
- 取消：任务被删除或工作流被删时，中止对应 `AbortController`，run 记 `cancelled`。
- 凭据：沿用本机 CLI 已有的登录态，**不把任何 token 存进数据库**。

## 运行时识别（2026-11-03 新增）

`src/main/ai-workflow/runtime/detect.ts` 扫描本机，返回已安装的 agent CLI 清单：

```ts
export interface DetectedRuntime {
  command: string // CLI 命令名，如 dsh / claude
  label: string // 展示名，如 "DeepSeek Harness"
  path: string // 可执行文件绝对路径
}
```

- **扫描目录**：`process.env.PATH` 全部条目 + 常见全局安装目录（`%APPDATA%/npm`、`~/.local/bin`、`~/.npm-global/bin`、`~/.bun/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、`~/.claude/local`）；不存在的目录跳过。
- **候选清单**（固定顺序）：`dsh`、`claude`、`codex`、`gemini`、`opencode`、`aider`、`cursor-agent`、`qwen`、`goose`、`crush`。
- **命中判定**：Windows 命中 `<cmd>.exe|.cmd|.bat|.ps1` 任一（npm 全局装的是 shim）；POSIX 命中同名且有可执行位（`mode & 0o111`）。同一命令多处命中取 PATH 中靠前者。
- **零副作用**：不 spawn 任何进程、不读版本号，只读文件系统。
- **UI 行为**：运行时配置页顶部列出检测结果与路径；点「使用」打开新建表单并把 `label`/`command` 预填进去（名称与现有运行时重名时改为 `label (command)`），参数与 prompt 模式仍由用户确认后保存。已添加过的命令显示「已添加」并禁用按钮。
- 检测只影响**表单预填**，不新建运行时记录，因此不触及「接入第二个运行时需先确认」的边界。

## IPC 契约（`window.aiWorkflow`）

契约定义在 `src/shared/ai-workflow-api.ts`，preload 原样透传，renderer 禁止直接 import electron/fs/child_process。

```ts
export interface AiWorkflowApi {
  runtimes: {
    list(): Promise<Runtime[]>
    create(input: RuntimeInput): Promise<Runtime>
    update(id: string, patch: Partial<RuntimeInput>): Promise<Runtime>
    remove(id: string): Promise<void>
    /** 扫描本机已安装的 agent CLI（只读，不写库、不发 changed） */
    detect(): Promise<DetectedRuntime[]>
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
  runs: { listByTask(taskId: string): Promise<Run[]> }
  /** 任意变更/运行进度后触发；返回取消订阅函数 */
  onChanged(cb: () => void): () => void
}
```

- 主进程在每次写操作与 run 进度变化后发 `ai-workflow:changed`；renderer 收到后失效重取（对齐 Multica「事件失效缓存」的做法）。
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

- 框架：Vitest + @testing-library/react，测试就近放置（`*.test.ts(x)`）。
- **阶段状态机（重点，要求分支全覆盖）：** `stage-machine.ts` 纯函数单测——三种 `entry_mode` 的进入效果、`on_complete`/`on_reject` 显式配置与默认解析（下一阶段 / 上一阶段 / 终端 completed / 首阶段原地）、多阶段串联、终端完成；以及 `moveTaskToStage`（跨阶段落点、目标不存在、落在当前阶段、已完成不参与）与 `completeTask`。
- **repository：** 用临时 SQLite 文件（或 `:memory:`）测 CRUD 与外键/唯一约束、级联删除、被引用拒绝、起始阶段校验。
- **runner：** 注入假 `RuntimeAdapter`（不起真进程）测入队→串行→成功/失败→触发流转→`changed` 事件；取消路径。
- **IPC：** handler 层 mock 依赖，验证参数透传与返回；`onChanged` 订阅/退订；拖拽/完成的非法路径（执行中、目标阶段无效）。
- **组件：** KanbanBoard 按阶段分列渲染任务，拖拽卡片到列触发 `moveToStage`、拖到「已完成」区触发 `complete`；TaskCard 可拖拽（`agent` 阶段不可拖）并按进入方式显示提示；TaskDialog 选择起始阶段；WorkflowEditor 编辑阶段三项目标。
- 覆盖率：`stage-machine.ts` 分支覆盖 100%；其余按 `pnpm check` 阈值。

## Boundaries

- **Always：** 阶段流转/默认目标解析只写在 `stage-machine.ts`；SQLite 只在主进程读写，renderer 一律经 `window.aiWorkflow`；进程执行经 `RuntimeAdapter` 注入；提交前 `pnpm check` 通过。
- **Ask first：** 新增 npm 依赖（尤其原生模块）；修改 shell 的 `AppDefinition` 或既有 `WorkbenchApi` 契约；改变数据库文件位置或引入迁移框架；接入第二个运行时。
- **Never：** 在 renderer 直接 `require('electron')`/用 `fs`/`child_process`；把业务规则写进组件；把凭据/token 明文写库；删除失败测试或改测试预期来掩盖问题。

## Success Criteria

1. 能添加一个 DeepSeek Harness 运行时、建一个绑定它的智能体，重启后仍在（数据落 SQLite）。
2. 能建一条含 ≥3 阶段的工作流，逐阶段配置【进入时】【完成后进入】【打回时退回到】；`none`/`agent`/`user` 三种进入方式均可保存并在看板生效。
3. 新建任务时可指定**起始阶段**（默认首阶段）；`agent` 阶段真实调用本机 DSH CLI 执行并回写输出，成功后按 `on_complete` 推进、失败按 `on_reject` 退回（由假 adapter 单测证明流转；DSH 真跑作为手动验收）。
4. `user` 阶段卡片显示"等待你处理"；把卡片拖到其它阶段列即进入该阶段（落点为准，不限于 `on_complete`/`on_reject`）；执行中的 `agent` 阶段卡片不可拖动。
5. 自动流转走完全部阶段且无下一阶段时任务 `completed`；手动拖到「已完成」区同样 `completed` 并移出看板。
6. 运行记录（状态、输出、起止时间）可在任务详情查看；同一时刻最多一个 run 在执行，其余排队。
7. 阶段状态机分支覆盖 100%；`pnpm check` 全绿。
8. 侧边栏出现"AI 工作流"入口并可切换（由 shell 承载，app 无需感知）。

## Out of scope（本 MVP 不做）

- 远端 Worker / 多设备执行 / 登录与多用户（仅留架构位）。
- Postgres / Redis 等外部服务；除 SQLite 外无其它存储。
- 多审批人、超时提醒、打回的多级语义、审批意见流。
- claude code / codex / oh-my-pi 等其余运行时的实际接入（仅留同一适配接口）。
- 统计分析、成本/token 看板、任务依赖图。

## Open Questions

1. **DSH headless 调用方式**：`dsh` CLI 的确切命令/参数（是否支持非交互 `-p`、prompt 走 stdin 还是参数、工作目录与环境变量）需在实现前确认；Spec 以「运行时可配 command + args 模板 + prompt_mode」抽象，DSH 预设值实现时填入。若你已知具体命令请直接给出。
2. **打回默认目标**：未配置【打回时退回到】时，按"退回上一阶段（首阶段原地）"执行；如需默认原地或其它，请指出。
3. **`none` / `user` 阶段的推进方式**：看板上把卡片拖到目标阶段（已按此实现，不再有「推进 / 通过 / 打回」按钮）。
4. **终端阶段**：最后阶段完成后任务置 `completed` 并移出看板；看板末尾的「已完成」区只是拖拽落点（显示已完成数量），不是可反向拖出的虚拟列。
5. **运行时工作目录**：`workdir` 默认取运行时配置，未配置时用用户主目录；若希望按任务/项目指定，另行设计。
