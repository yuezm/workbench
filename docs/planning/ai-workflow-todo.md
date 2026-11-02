# Task List: ai-workflow（个人AI工作流 MVP）

> 索引与决策见 [ai-workflow-plan.md](./ai-workflow-plan.md)；规格见 [SPEC-ai-workflow.md](../specs/SPEC-ai-workflow.md)。
> 任务清单按项目约定放 `docs/planning/`（非 `tasks/todo.md`）；v1 的 [todo.md](./todo.md) 不动。

## Phase 1: 地基（数据 + 契约）

## Task 1: SQLite 基座（schema + migration）

**Description:** 在主进程建立 `node:sqlite` 连接与建表机制。

**Acceptance criteria:**

- [x] `openDb(path)` 打开数据库并执行 `schema.sql`，创建 6 张表（runtimes/agents/workflows/workflow_stages/tasks/runs）
- [x] 开启 `PRAGMA foreign_keys = ON`；migration 可重复执行（幂等）
- [x] 用临时文件或 `:memory:` 测试：建表成功、外键违反被拒绝

**Verification:**

- [x] `pnpm test -- src/main/ai-workflow/db.test.ts`
- [x] `pnpm typecheck`

**Dependencies:** None　**Files:** `src/main/ai-workflow/db.ts`、`schema.sql`、`db.test.ts`　**Scope:** S（3 文件）

## Task 2: 共享契约与 preload 暴露

**Description:** 定义 `AiWorkflowApi` 跨进程契约，并通过 preload 暴露 `window.aiWorkflow`。

**Acceptance criteria:**

- [x] `src/shared/ai-workflow-api.ts` 含全部实体类型与 `AiWorkflowApi` 接口，channel 常量集中定义
- [x] preload 暴露 `window.aiWorkflow`，各方法转发到对应 channel；`onChanged(cb)` 订阅/退订可用
- [x] 既有 `window.workbench.notify` 不受影响；`api.d.ts` 有全局声明

**Verification:**

- [x] `pnpm test -- src/preload/index.test.ts`
- [x] `pnpm typecheck`

**Dependencies:** None　**Files:** `src/shared/ai-workflow-api.ts`、`src/preload/index.ts`、`src/renderer/src/shared/api.d.ts`、`src/preload/index.test.ts`　**Scope:** S（4 文件）

## Task 3: repository 全实体 CRUD

**Description:** 纯 SQL 数据访问层，覆盖 6 实体增删改查与关系约束。

**Acceptance criteria:**

- [x] runtimes/agents/workflows/stages/tasks/runs 的 create/read/update/delete
- [x] 读取 workflow 时返回按 `position` 排序的 stages
- [x] 唯一约束、外键、级联删除（删 workflow 连带阶段/任务/run）、被引用运行时/智能体删除被拒，均有测试
- [x] id 用 `crypto.randomUUID()`，时间戳 ISO 字符串

**Verification:**

- [x] `pnpm test -- src/main/ai-workflow/repository.test.ts`
- [x] `pnpm typecheck`

**Dependencies:** T1　**Files:** `src/main/ai-workflow/repository.ts`、`repository.test.ts`　**Scope:** M（2 文件，内容较多）

### ✅ Checkpoint A（T1–T3）

- [x] `pnpm test` 全绿、`pnpm typecheck` 通过
- [x] 临时库建表/外键/级联/被引用拒绝符合 SPEC

## Phase 2: 核心逻辑（最高风险先做）

## Task 4: 阶段状态机（纯函数）

**Description:** 实现阶段流转核心逻辑，独立于 React/DB/子进程。

**Acceptance criteria:**

- [x] 三种 `entry_mode` 的进入效果（none=停留 / agent=createRun / user=waitUser）
- [x] `on_complete` 目标解析：显式配置 / 默认下一阶段 / 已无下一阶段→`completed`
- [x] `on_reject` 目标解析：显式配置 / 默认上一阶段 / 首阶段原地
- [x] 事件转移覆盖 RUN_SUCCEEDED / RUN_FAILED / APPROVE / REJECT / MOVE_NEXT；纯函数、无 IO
- [x] 分支覆盖率 100%

**Verification:**

- [x] `pnpm test -- src/renderer/src/apps/ai-workflow/model/stage-machine.test.ts`
- [x] `pnpm run test:coverage`（该文件 branches 100%）

**Dependencies:** T2（类型）　**Files:** `src/renderer/src/apps/ai-workflow/model/stage-machine.ts`、`stage-machine.test.ts`　**Scope:** S（2 文件，逻辑重）

## Task 5: app 骨架与注册

**Description:** 建 AppDefinition、页面骨架、类型安全 api 封装，并注册进外壳。

**Acceptance criteria:**

- [x] `aiWorkflowApp` 实现 `AppDefinition`（id/name/icon/component）
- [x] `registry.ts` 加一行；registry 契约测试自动纳入（id 唯一、字段齐）
- [x] 侧边栏出现「AI 工作流」入口，点击切换内容区
- [x] `api.ts` 对 `window.aiWorkflow` 做薄封装，供后续组件调用

**Verification:**

- [x] `pnpm test`（含 registry.test）
- [x] `pnpm typecheck`

**Dependencies:** T2　**Files:** `apps/ai-workflow/index.tsx`、`AiWorkflowPage.tsx`、`api.ts`、`shell/registry.ts`　**Scope:** S（4 文件）

### ✅ Checkpoint B（T4–T5）

- [x] 状态机分支 100%；侧边栏可切换「AI 工作流」

## Phase 3: 运行时与智能体（垂直切片 1）

## Task 6: runtimes/agents IPC handlers

**Description:** 把运行时/智能体的 CRUD 接到 repository 并暴露 IPC。

**Acceptance criteria:**

- [x] handlers 覆盖 runtime/agent 的 list/create/update/remove，参数透传正确
- [x] 删除被引用的运行时/智能体返回可读错误（不误删）
- [x] 写操作后发送 `ai-workflow:changed`
- [x] main 入口注册 handlers

**Verification:**

- [x] `pnpm test -- src/main/ai-workflow/ipc.test.ts`
- [x] `pnpm typecheck`

**Dependencies:** T2, T3　**Files:** `src/main/ai-workflow/ipc.ts`、`src/main/index.ts`、`ipc.test.ts`　**Scope:** S（3 文件）

## Task 7: RuntimeManager + AgentManager UI

**Description:** 运行时与智能体的管理界面，挂到页面。

**Acceptance criteria:**

- [x] 运行时：列表/新建/编辑/删除（名称、command、args、prompt_mode、workdir）
- [x] 智能体：列表/新建/编辑/删除（名称、描述、绑定运行时、System Prompt）
- [x] 操作经 `api.ts` 调用并在成功后刷新

**Verification:**

- [x] `pnpm test -- src/renderer/src/apps/ai-workflow/components/RuntimeManager.test.tsx AgentManager.test.tsx`
- [x] `pnpm typecheck`

**Dependencies:** T5, T6　**Files:** `components/RuntimeManager.tsx(+test)`、`components/AgentManager.tsx(+test)`、`AiWorkflowPage.tsx`　**Scope:** M（5 文件）

### ✅ Checkpoint C（T6–T7）

- [x] 能增删改运行时与智能体，重启后仍在（落库）

## Phase 4: 工作流与阶段（垂直切片 2）

## Task 8: workflows/stages IPC

**Description:** 工作流及其阶段（含三项目标）的读写。

**Acceptance criteria:**

- [x] workflow create/update（阶段增删改、自动维护 position）/remove（级联）
- [x] list 返回含有序 stages 的工作流
- [x] 阶段 `on_complete_stage_id`/`on_reject_stage_id` 必须指向同一工作流内阶段，否则拒绝
- [x] `entry_mode=agent` 时必须有 `agent_id`

**Verification:**

- [x] `pnpm test -- src/main/ai-workflow/{ipc,repository}.test.ts`
- [x] `pnpm typecheck`

**Dependencies:** T3, T6　**Files:** `repository.ts`、`ipc.ts`、`ipc.test.ts`、`repository.test.ts`　**Scope:** M（4 文件）

## Task 9: WorkflowSwitcher + WorkflowEditor UI

**Description:** 工作流切换与阶段编辑界面。

**Acceptance criteria:**

- [x] 顶部可切换工作流
- [x] 阶段可增删改与排序
- [x] 每阶段可配【进入时】（none / agent+选智能体 / user）、【完成后进入】、【打回时退回到】（可选阶段或留空=默认）
- [x] 保存后生效并可重新读回

**Verification:**

- [x] `pnpm test -- .../WorkflowSwitcher.test.tsx WorkflowEditor.test.tsx`
- [x] `pnpm typecheck`

**Dependencies:** T7, T8　**Files:** `components/WorkflowSwitcher.tsx(+test)`、`components/WorkflowEditor.tsx(+test)`、`AiWorkflowPage.tsx`　**Scope:** M（5 文件）

### ✅ Checkpoint D（T8–T9）

- [x] 能建 ≥3 阶段工作流并正确保存阶段配置

## Phase 5: 看板与任务（垂直切片 3）

## Task 10: tasks IPC + move 动作

**Description:** 任务 CRUD 与「通过/打回/推进」动作，流转规则复用 stage-machine。

**Acceptance criteria:**

- [x] create task 进入首阶段，`status=active`
- [x] list by workflow 返回任务及当前阶段
- [x] move(approve/reject/next) 调 `stage-machine` 产出新 `current_stage_id`/`status` 并持久化；终端置 `completed`
- [x] 非法动作（如对非 user 阶段 approve）被拒

**Verification:**

- [x] `pnpm test -- src/main/ai-workflow/{ipc,repository}.test.ts`
- [x] `pnpm typecheck`

**Dependencies:** T3, T4, T8　**Files:** `repository.ts`、`ipc.ts`、`ipc.test.ts`、`repository.test.ts`　**Scope:** M（4 文件）

## Task 11: 看板与任务卡 UI

**Description:** 看板列 = 阶段，卡片推进交互。

**Acceptance criteria:**

- [x] KanbanBoard 按阶段分列渲染，completed 任务移出
- [x] TaskCard 显示标题/当前指派；user 阶段显示「通过/打回」，none 阶段显示「推进」
- [x] 操作后看板刷新

**Verification:**

- [x] `pnpm test -- .../KanbanBoard.test.tsx TaskCard.test.tsx`
- [x] `pnpm typecheck`

**Dependencies:** T9, T10　**Files:** `components/KanbanBoard.tsx(+test)`、`TaskCard.tsx(+test)`、`AiWorkflowPage.tsx`　**Scope:** S（5 文件）

## Task 11b: 任务新建/编辑对话框

**Description:** TaskDialog 负责新建/编辑任务（标题、描述、工作流）。

**Acceptance criteria:**

- [x] 可选工作流、填标题/描述创建任务
- [x] 编辑已有任务并保存
- [x] 成功后回调刷新

**Verification:**

- [x] `pnpm test -- .../TaskDialog.test.tsx`
- [x] `pnpm typecheck`

**Dependencies:** T10　**Files:** `components/TaskDialog.tsx(+test)`、`AiWorkflowPage.tsx`　**Scope:** S（3 文件）

### ✅ Checkpoint E（T10–T11）

- [x] 新建任务入首阶段；可手动推过 none/user 阶段（agent 阶段待 Phase 6）

## Phase 6: 执行（垂直切片 4）

## Task 12: RuntimeAdapter + DSH 实现 + runner

**Description:** 真实执行层：DSH 适配器与单并发运行队列。

**Acceptance criteria:**

- [x] `RuntimeAdapter` 接口 + `deepseek-harness.ts` 按运行时配置 spawn（先 spike 确认真实命令）
- [x] runner：queued→running→succeeded/failed/cancelled；单并发 FIFO；累积输出写 `runs`；成功→RUN_SUCCEEDED、失败→RUN_FAILED 触发流转；取消记 cancelled
- [x] 变更后发 `ai-workflow:changed`；用假 adapter 测成功/失败/取消/串行

**Verification:**

- [x] `pnpm test -- src/main/ai-workflow/runner.test.ts`
- [x] `pnpm typecheck`

**Dependencies:** T3, T4, T6　**Files:** `runtime/deepseek-harness.ts`、`runner.ts`、`runner.test.ts`　**Scope:** M（3 文件）

## Task 13: 运行记录 UI + 实时刷新

**Description:** 展示任务运行记录，订阅变更自动刷新。

**Acceptance criteria:**

- [x] `useWorkflow` 初次加载 + `onChanged` 触发失效重取，卸载时退订
- [x] RunLog 展示某任务的 runs（状态、输出、起止时间），运行中自动更新

**Verification:**

- [x] `pnpm test -- .../RunLog.test.tsx hooks/useWorkflow.test.ts`
- [x] `pnpm typecheck`

**Dependencies:** T11, T11b, T12　**Files:** `components/RunLog.tsx(+test)`、`hooks/useWorkflow.ts(+test)`、`AiWorkflowPage.tsx`　**Scope:** M（5 文件）

### ✅ Checkpoint F（T12–T13）

- [x] 假 adapter 跑通「agent 阶段自动执行→成功推进/失败退回」；DSH 真跑留手动验收

## Phase 7: 收尾

## Task 14: 整体验收与门禁

**Description:** 全量质量门禁与端到端验收。

**Acceptance criteria:**

- [x] `pnpm check` 全绿（含覆盖率阈值）
- [x] 手动：添加 DSH 运行时 → 建智能体 → 建含 agent 阶段的工作流 → 新建任务真跑 → 输出回写 → 重启数据仍在
- [x] （可选）补 `e2e/ai-workflow.spec.ts` 关键路径；更新 `docs/testing/TEST-CASES.md` 手动验收项

**Verification:**

- [x] `pnpm check`
- [x] 手动验收清单逐项勾选

**Dependencies:** T13（及其它全部）　**Files:** `e2e/ai-workflow.spec.ts`（可选）、`docs/testing/TEST-CASES.md`　**Scope:** M

### ✅ Checkpoint G（完成）

- [x] SPEC Success Criteria 全部满足（DSH 真跑为手动项）
- [x] 覆盖率门禁通过，可交付审阅
