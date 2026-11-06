# 任务清单：M8 任务派生（1 → N 子任务）

> 计划见 [m8-plan.md](./m8-plan.md)；设计见 [SPEC-task-fanout](../docs/specs/SPEC-task-fanout.md)。状态：`[ ]` 未做 / `[x]` 完成。写作用域见计划「任务拆分」；同一文件同一时刻只允许一个 owner 改。

## T1 契约与协议（lead）

- [x] `src/protocol/inputs.ts`：`SpawnTask`（subject 必填 / summary / stageId / batch / key）、`Receipt.spawn?`
- [x] `src/protocol/entities.ts`：`Task` + `spawnedByRunId` / `batchNo` / `spawnKey`（`parentTaskId` 已有，注释标明派生必填）；`TASK_ORIGINS` + `'spawn'`；`WorkflowStage` + `subtaskStageId` / `onChildrenSettled` / `spawnPolicy`；`StageInput` 三个可选字段；`TaskInput.parentTaskId?`
- [x] `src/protocol/facts.ts`：`task.children_settled` 与 payload（`parentTaskId/childIds/batchNo/action`）
- [x] `src/protocol/validate.ts`：`checkSpawnTask`（白名单，不读取 parentTaskId/agent 等）；`COMMAND_LIMITS.spawnItems=32` / `spawnBatchMax=999`；`checkReceipt` 加 `spawn`；`task.create` 校 `parentTaskId`
- [x] `src/plugins/shared/receipt-block.ts`：`RECEIPT_BLOCK_KEYS` + `spawn`、`parseSpawnList`、`applyReceiptBlock` 补 spawn
- [x] `src/kernel/types.ts`：`Limits.maxSpawnItems/maxSpawnDepth`、`KERNEL_VERSION=m8.0.0`
- [x] `src/kernel/view-spec.ts`：`run.receipt` / `task.complete` / `task.remove` 切片（runs/cards）；`tasks.byParent` 视图 id 注册
- [x] 单测：`tests/protocol/**`（spawn 校验 / 越权字段忽略 / task.create parentTaskId）、`tests/plugins/shared/receipt-block.test.ts`

## T2 账本、投影与宿主存储（lead）

- [x] `src/host/schema.ts`：`tasks` 三列 + `origin` CHECK 扩展（含 `spawn`）；`workflow_stages` 三列；`TASKS_M8_ADDED_COLUMNS` / `STAGES_M8_ADDED_COLUMNS`；`tableDdl` / `PROJECTION_TABLES` 一致
- [x] `src/host/db.ts`：`tasks` 物理重建（临时表法，`PRAGMA foreign_keys=OFF`）；`workflow_stages` 加列
- [x] `src/host/store/projection-apply.ts`：`task.created` upsert 带新列；`task.children_settled` 无变更
- [x] `src/host/store/views.ts`：`Task` / `WorkflowStage` 行映射新列；`tasks.byParent` 查询（DB 视图 + 注册）
- [x] `src/host/store/import.ts`：存量归一补 `null` 新列
- [x] `src/kernel/project.ts`：`normalizeTask` / `normalizeStage` 补字段；`task.children_settled` → `[]`
- [x] `src/kernel/timeline.ts`：`task.children_settled` 归父任务 scope
- [x] 单测：`tests/host/{schema,db}/**`、`tests/host/store/**`、`tests/kernel/project.test.ts`

## T3 内核 spawn（kernel-dev）

- [x] `src/kernel/spawn.ts`：`spawnFacts`（父 active 校验、`parentTaskId=parent.id` 内核推导、深度 `spawnDepth≤8`、`(parent,key)` 去重、`spawnPolicy='off'` 丢弃、落点 `resolveSubtaskStage`、`task.created` + `thread.task_attached` + `entryRunFacts`）
- [x] `src/kernel/decide.ts`：`run.receipt` 分支在 cards/events/notes/ask 之间接入 `spawnFacts`
- [x] 单测 `tests/kernel/spawn.test.ts`：建 N 子任务（parent/thread/origin/spawnedByRunId）、父非 active 丢弃、深度超限、幂等、spawnPolicy off、越权 parentTaskId 被忽略、落点三优先级

## T4 内核 rollup（kernel-dev）

- [x] `src/kernel/spawn.ts`：`childrenSettledFacts`（全部子终态 / 幂等：活跃 run 或 open `children-settled` 卡）、`resolveRollupAction`（阶段 `onChildrenSettled` ?? agent→wake / 否则 notify）、`childrenSettledPrompt`
- [x] `src/kernel/decide.ts`：`task.complete` / `task.remove` / 成功流转（`stageTransitionFacts`/拖拽/直接完成）三处出口挂钩；`wake`→`run.queued`、`notify`→`card.opened` 信息卡、`complete`→`task.completed`
- [x] `src/kernel/view-spec.ts`：上述输入补 `runs` / `cards`
- [x] 单测 `tests/kernel/rollup.test.ts`：wake/notify/complete 三分支、只触发一次、多层沿链级联、父非 agent 降级 notify

## T5 人工拆子任务（kernel-dev）

- [x] `src/kernel/decide.ts`：`task.create` 支持 `input.parentTaskId`（父存在、同工作流、active；`origin='manual'`、`parentTaskId`=父、`spawnedByRunId=null`）
- [x] 单测 `tests/kernel/task-create.test.ts`：合法建子任务 / 父不存在 / 跨工作流 / 父非 active 各自 reject

## T6 renderer（ui-dev）

- [x] `TaskCard.tsx`：有子任务显示「子任务 x/y」进度徽标（读 `tasks.byParent` 汇总）
- [x] `TaskDetailPage.tsx`：子任务列表区（标题 / 阶段 / 状态 / 入口），点进各任务
- [x] `WorkflowEditor.tsx`：阶段高级项三字段（子任务落点阶段 / 子任务完成后 / 允许拆子任务）+ `toDraft` 回传
- [x] `kernelStore.ts`：`task.created` / `task.children_settled` / `thread.*` 失效（确认已有覆盖）
- [x] 组件测试 `tests/renderer/**`

## T7 装配、e2e 与门禁（lead）

- [x] e2e `tests/e2e/spawn.spec.ts`：种子库 → 起 app → 回执带 `spawn` → 直读库断言 7 子任务 parentTaskId/thread/origin；子全完成后父 rollup 一次
- [x] `pnpm check` exit 0；覆盖率不低于基线；`check:diffcov` ≥90%；`pnpm e2e` 全绿

## T8 文档与收尾（lead）

- [x] SPEC-kernel（派生任务/线程补 spawn） / SPEC-plugins（回执 spawn 约定）同步
- [x] CAPABILITY-MAP / TEST-CASES / refactor-plan 记录 M8
- [x] 决定 `SPEC-task-fanout` 保留独立或并入 SPEC-kernel
