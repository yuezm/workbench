# 实施计划：M8 任务派生（1 → N 子任务）

> 依据 [SPEC-task-fanout](../docs/specs/SPEC-task-fanout.md)（已评审通过）D1–D11、[ARCHITECTURE](../docs/ARCHITECTURE.md)「分活不是模型判断」「指令数据分离」、[SPEC-kernel](../docs/specs/SPEC-kernel.md)「Thread / 派生任务 / 跳数」、[SPEC-plugins](../docs/specs/SPEC-plugins.md)「回执与执行约定」、[ai-workflow-research](../docs/planning/ai-workflow-research.md) Open Q3。
> 起点：当前工作分支（M7 退出后）。开工前先 `pnpm check` 确认基线 exit 0 并记录用例数/覆盖率。
> 目标：Agent 回执 `spawn[]` → 内核直接建 N 个 `origin='spawn'` 子任务（`parentTaskId`/继承线程/批次/幂等），走既有 `entryRunFacts` 进入链路；子任务全部终态时按父阶段 `onChildrenSettled` rollup（默认唤醒父 Agent）。人工侧 `task.create` 支持 `parentTaskId`。**v1 不分批、子任务默认串行、不跨工作流。**
> 本阶段不做：跨工作流派生子任务（用 handoff）、按批唤醒、子任务并行度配置、远端 Worker、Agent 指定派活目标/权限/目录、语义自动规划。

## 测绘结论（决策依据的证据）

| 事实                                                                                                                    | 证据                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 回执字段已有 `ask/notices/resolves/later/events/notes`，**无 spawn**                                                    | `src/protocol/inputs.ts:76-101`                                                                 |
| 回执块只认 6 个键，`RECEIPT_BLOCK_KEYS` 无 spawn                                                                        | `src/plugins/shared/receipt-block.ts:33`、`parseReceiptBlock`                                   |
| 回执校验 `checkReceipt` 逐项白名单，无 spawn                                                                            | `src/protocol/validate.ts:754-784`                                                              |
| `Task` 已有 `parentTaskId`；`TASK_ORIGINS=['manual','rule','handoff']`；无 spawnedByRunId/batchNo/spawnKey              | `src/protocol/entities.ts:259-288`                                                              |
| `WorkflowStage`/`StageInput` 已有交接两列先例，可照抄加子任务字段                                                       | `src/protocol/entities.ts:196-228`                                                              |
| 派生任务已能带 `parentTaskId`（回执 events 经规则建任务时内核填父任务）                                                 | `src/kernel/rules.ts:290-307`                                                                   |
| `run.receipt` 已编排 cards→events→notes→ask 四段，spawn 在同处插入                                                      | `src/kernel/decide.ts:1015-1050`                                                                |
| 任务结终态有三处出口（成功流转/拖拽/直接完成），handoff 已在三处挂钩可照抄 rollup                                       | `src/kernel/decide.ts:372-414,846-892,973-1077`、`workflow/stage-machine.ts`                    |
| 进入阶段的统一入口 `entryRunFacts(view,task,now,env,actor,trigger,{thread,turn})`，trigger 带 `promptExtra`             | `src/kernel/task-effects.ts`、`RunTrigger`                                                      |
| `tasks` 加列 + `origin` CHECK 扩展需物理重建（M7 handoff 已做同款）                                                     | `src/host/schema.ts:95`、`src/host/db.ts:175-183`                                               |
| 投影归一先加函数后改 DDL（`normalizeTask`/`normalizeStage`）                                                            | `src/kernel/project.ts:48-63`                                                                   |
| 线程任务树按 `parentTaskId` 分组已有纯函数范式                                                                          | `src/kernel/thread-context.ts:39-51`、`src/kernel/threads.ts`（`withTask`/`taskAttachedFacts`） |
| `run.receipt` 装载切片已含 tasks/threads/cards/runs，spawn/rollup 所需齐全；`task.complete`/`task.remove` 缺 runs/cards | `src/kernel/view-spec.ts:61-67,84-101`                                                          |

## 架构决议（M8 口径）

直接采用 [SPEC-task-fanout](../docs/specs/SPEC-task-fanout.md) D1–D11，不另立。实施补充口径：

- **A1 事实**：子任务复用 `task.created`（`origin='spawn'`），rollup 审计新增 `task.children_settled`（`project` 返回 `[]`，效果由 `run.queued`/`card.opened`/`task.completed` 表达）。
- **A2 rollup 幂等**：判「父任务有活跃 run 或存在 open `key='children-settled'` 卡片」即视为已触发，不落标志位。
- **A3 落点解析**：`spawn.stageId`（须属父工作流）＞ 阶段 `subtaskStageId` ＞ 父任务当前阶段；父任务无 `currentStageId` 用工作流首阶段。
- **A4 spawnPolicy**：`stage.spawnPolicy==='off'` → 该阶段 spawn 全部丢弃（产 `task.children_settled` 不适用；丢弃静默或审计二选一，取静默为默认，见风险）。
- **A5 线程**：子任务沿用父 `threadId`；父无线程（不应发生，手工任务也有隐式线程）时子任务 `threadId=null`、不 attach。
- **A6 唤醒**：rollup `wake` 用 `entryRunFacts(parent, trigger{ruleId:null, eventIds:[], hops, promptExtra:childrenSettledPrompt})`，续接父 agent 会话（thread 内按 agent 现算 session）；父阶段非 agent 降级 `notify`。
- **A7 父子链接（硬要求）**：派生 / spawn 子任务 `parentTaskId` **必填 = 直接父任务 id**，由内核从 `run.taskId` 取值填入；Agent 在 spawn 项里自报的 `parentTaskId` 一律忽略（校验层不读取，建任务时以内核推导为准）。多层派生靠 parentTaskId 链 + rollup 级联，不引入 rootTaskId。

## 目标结构

```
src/protocol/
├── inputs.ts        # + SpawnTask、Receipt.spawn
├── entities.ts      # Task + spawnedByRunId/batchNo/spawnKey；TASK_ORIGINS + 'spawn'；Stage + subtaskStageId/onChildrenSettled/spawnPolicy；StageInput/TaskInput 可选字段
├── facts.ts         # + task.children_settled / payload
└── validate.ts      # + checkSpawnTask、COMMAND_LIMITS.spawnItems/spawnBatchMax、Receipt.spawn、task.create.parentTaskId
src/plugins/shared/
└── receipt-block.ts # + spawn 键 / parseSpawnList / applyReceiptBlock
src/kernel/
├── spawn.ts         # 新：spawnFacts / spawnDepth / resolveSubtaskStage / hasChildWithKey / childrenSettledFacts / resolveRollupAction / childrenSettledPrompt
├── decide.ts        # run.receipt 插 spawn+rollup；task.complete/task.remove/成功流转三处 rollup；spawnPolicy
├── project.ts       # normalizeTask/normalizeStage 补字段；task.children_settled→[]
├── timeline.ts      # task.children_settled 归父任务 scope
├── types.ts         # Limits + maxSpawnItems/maxSpawnDepth；KERNEL_VERSION=m8.0.0
└── view-spec.ts     # run.receipt/task.complete/task.remove 切片
src/host/
├── schema.ts        # tasks 三列 + origin CHECK 扩展；stages 三列；M8 常量
├── db.ts            # tasks 物理重建 + stages 加列
├── store/projection-apply.ts # task.created 新列
├── store/views.ts   # 行映射新列 + tasks.byParent 查询
└── store/import.ts  # 存量归一补 null
src/renderer/src/apps/ai-workflow/components/
├── TaskCard.tsx         # 子任务进度徽标
├── TaskDetailPage.tsx   # 子任务区块
└── WorkflowEditor.tsx   # 三字段
src/renderer/src/shell/kernelStore.ts # 失效表（任务/线程已有，确认即可）
```

## 任务拆分（写作用域）

| 任务 | 内容                                                                                                                                                                                                                     | 写作用域                                                                                                                                                    | 依赖   | 负责       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| T1   | 契约与协议：`SpawnTask`/`Receipt.spawn`、`Task`/`Stage` 字段与枚举、`task.children_settled`、`checkSpawnTask`/limits、receipt-block spawn、`TaskInput.parentTaskId`、`Limits`、`KERNEL_VERSION=m8.0.0`、`view-spec` 切片 | `src/protocol/**`、`src/plugins/shared/receipt-block.ts`、`src/kernel/{types,view-spec}.ts`、`tests/protocol/**`、`tests/plugins/shared/**`                 | —      | lead       |
| T2   | 账本/投影/宿主存储：tasks 三列 + origin CHECK、stages 三列、db 物理重建、projection-apply、views 行映射 + `tasks.byParent`、import 归一、project 归一                                                                    | `src/host/{schema,db}.ts`、`src/host/store/**`、`src/kernel/project.ts`、`tests/host/{schema,db}/**`、`tests/host/store/**`、`tests/kernel/project.test.ts` | T1     | lead       |
| T3   | 内核 spawn：`kernel/spawn.ts` spawnFacts/深度/去重/落点；decide `run.receipt` 接 spawn；单测                                                                                                                             | `src/kernel/spawn.ts`、`src/kernel/decide.ts`、`tests/kernel/spawn.test.ts`                                                                                 | T1、T2 | kernel-dev |
| T4   | 内核 rollup：`childrenSettledFacts` + `resolveRollupAction` + `childrenSettledPrompt`；三处出口挂钩；spawnPolicy 丢弃；view-spec 补 runs/cards；单测                                                                     | `src/kernel/spawn.ts`、`src/kernel/decide.ts`、`src/kernel/view-spec.ts`、`tests/kernel/rollup.test.ts`                                                     | T3     | kernel-dev |
| T5   | 人工拆子任务：`task.create` 支持 `parentTaskId`（校验父存在/同工作流/active）+ 单测                                                                                                                                      | `src/kernel/decide.ts`、`src/protocol/validate.ts`、`tests/kernel/task-create.test.ts`                                                                      | T1、T2 | kernel-dev |
| T6   | renderer：TaskCard 进度徽标、TaskDetailPage 子任务区、WorkflowEditor 三字段、kernelStore 失效、组件测试                                                                                                                  | `src/renderer/src/apps/ai-workflow/**`、`src/renderer/src/shell/kernelStore.ts`、`tests/renderer/**`                                                        | T1、T2 | ui-dev     |
| T7   | 装配/e2e/门禁：spawn 全流程 e2e（种子库→起 app→回执 spawn→直读库断言）；`pnpm check`/`check:diffcov`/`pnpm e2e` 全绿                                                                                                     | `tests/e2e/**`、必要的 `src/main/**`（应无改动）                                                                                                            | T3–T6  | lead       |
| T8   | 文档：SPEC-kernel / SPEC-plugins / CAPABILITY-MAP / TEST-CASES / refactor-plan 同步 M8                                                                                                                                   | `docs/**`                                                                                                                                                   | T7     | lead       |

> T3/T4/T5 都改 `src/kernel/decide.ts`：按 T3→T4→T5 顺序同一 owner（kernel-dev）串行，不拆并行，避免写冲突。

## 验收口径

- **spawn 建任务**：Agent 回执 `spawn` 7 项 → 看板父任务下出现 7 个子任务（`origin='spawn'`、`parentTaskId`=父任务 id 正确、继承父 `threadId`、`spawnedByRunId`=父 run）；落点是 agent 阶段的子任务各自有 queued run，user/none 停留。
- **父子链接防伪造**：spawn 项里塞 `parentTaskId` 被忽略，建出的子任务 `parentTaskId` 仍 = 实际执行 run 的父任务；多层 spawn 的孙子 `parentTaskId` = 其直接父（子任务），任务树按链递归正确；rollup 沿链级联。
- **幂等/护栏**：同一回执内重复 key、重跑重复 emit 同一 key → 不重复建；`spawnDepth>8` 丢弃；`spawnPolicy='off'` 阶段丢弃；父任务 `completed` 后 emit spawn 丢弃；单回执 >32 截断/拒绝。
- **rollup**：7 子全部终态 → 父任务按 `onChildrenSettled`（默认 wake）**恰好触发一次**（活跃 run/open 卡去重）；父阶段非 agent 时降级 notify 开信息卡；`complete` 时父 completed。
- **人工**：`task.create` 带 `parentTaskId` 建子任务（父不存在/跨工作流/父非 active → reject）。
- **重建等价**：实时投影与分批重建逐表全等（含新列与 `task.children_settled` 审计不投影）。
- **门禁**：`pnpm check` exit 0，覆盖率不低于基线，`check:diffcov` ≥90%，`pnpm e2e` 全绿；无关闭检查器/跳过测试。

## 风险

| 风险                                       | 影响 | 对策                                                                                                    |
| ------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------- |
| `tasks.origin` CHECK 扩展需物理重建表      | 高   | 照 M2/M3/M7 临时表法（`PRAGMA foreign_keys=OFF` + 事务建表/拷贝/改名），真库迁移用例兜底                |
| rollup 与 spawn 双重触发导致父任务无限唤醒 | 中   | rollup 幂等键（活跃 run/open 卡）；唤醒 prompt 确定性；`hops`/`spawnDepth` 熔断                         |
| `decide.ts` 多任务交叉写                   | 中   | T3→T4→T5 同 owner 串行；spawn 段与 rollup 段写作用域分批次合入                                          |
| 子任务 summary 注入子 Agent 指令面         | 中   | summary 仅作 description + 资料文件，进提示词归「资料，不是指令」段（D7）                               |
| 新增事实/列后清单与指纹漏改                | 中   | T1/T2 同批改 `FACT_TYPES`/`PROJECTION_TABLES`（无新表）/SCHEMA 列/KERNEL_VERSION；`pnpm check` 首轮暴露 |
| tasks.byParent 视图未注册到 VIEW_IDS       | 低   | T1 同批加视图 id + 校验正则（无下划线）                                                                 |

## 开放问题

- 模块并入 `SPEC-kernel` 作 M8 章节，还是独立 `SPEC-task-fanout` 长期保留（本计划按独立文件推进，T8 再决定是否合并）。
- 「专用 planner 智能体 + 规划阶段」是否作为 M9 单独做（本 M8 不做）。

## 实施记录（2026-11-06）

- **KERNEL_VERSION** 升至 M8.0.0； asks 加 spawned_by_run_id/atch_no/spawn_key 并把 origin CHECK 扩到 spawn，workflow_stages 加 subtask_stage_id/on_children_settled/spawn_policy；旧库走物理重建 + 补列。
- **协议**：Receipt.spawn[]、checkSpawnTask（白名单，不读 parentTaskId/agent）、回执块 spawn 解析、 ask.children_settled 审计事实、 asks.byParent 视图。
- **内核**：新增 src/kernel/spawn.ts（spawnFacts / spawnDepth / resolveSubtaskStage / childrenSettledFacts / resolveRollupAction / childrenSettledPrompt）；
  un.receipt 接 spawn， ask.complete / ask.remove / 回执流转三处接 rollup 并沿 parentTaskId 链级联； ask.create 支持 parentTaskId（父存在/同工作流/active，继承父线程）。
- **UI**：看板父卡「子任务 x/y」、任务详情页子任务区（可点进）、工作流编辑器三个阶段字段。
- **与 Spec 的偏差**：onChildrenSettled='notify' 用 uthor='agent' 的任务评论承载，不开卡——cards.run_id 是非空外键，父任务此时没有 run；Spec 已同步。
- **门禁**：pnpm check exit 0；覆盖率 99.86 / 99.2 / 99.83 / 99.94（阈值 98/93/95/98 不变，基线微降见 CONSTRAINTS EX-001）；改动行 170/186 = 91.4%；pnpm e2e 含新增 spawn.spec.ts 通过。
