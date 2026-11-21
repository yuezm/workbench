# 计划：任务「完成」与「归档」分离（含派单血缘拆分）

> 2026-11-21 起草。起因：人在线程 `0668c0f8-87d8-48f1-a7a5-391dc7fd8b4d`（「故障绑定页面，状态位的语义问题」）上连续踩到三件事——三张流水线工单被画成父子树、停在「已完成」列的任务仍显示「进行中」、派单链的第三张卡从 14:11 起一直卡在「待办」。
> 状态：**执行中（2026-11-21，`/agent-skills-build auto`）**。规格增量已落 `docs/specs`（SPEC-ai-workflow / SPEC-kernel / SPEC-task-fanout / SPEC-authority），按 P1 → P2 → P3 逐片 RED→GREEN→回归→commit。
> 关联：[SPEC-kernel](../specs/SPEC-kernel.md)（任务命令、事实目录）、[SPEC-ai-workflow](../specs/SPEC-ai-workflow.md)（阶段类别、出口表、看板、任务状态）、[SPEC-task-fanout](../specs/SPEC-task-fanout.md)（rollup）、[SPEC-ui](../specs/SPEC-ui.md)（看板 / 详情页）。

## 结论

系统的「完成」和「归档」是同一个动作（`task.completed`），而「流程走完」只是换了个列——三者纠缠在一起。按人的口径拆成三条互不覆盖的轴：

| 轴 | 载体 | 谁写 | 业务后果 |
| --- | --- | --- | --- |
| 流程位置 | `tasks.current_stage_id` + 阶段类别 `pending / active / done / closed` | 内核流转 | 派活、闸门、拖拽 |
| 业务完成 | **派生**：阶段类别 ∈ `done / closed`（类别区分完成与取消），另落 `task.finished` 事实供同批收尾用 | 进入终态阶段 | rollup、线程收尾、结局通知、收卡、子任务进度 |
| 追踪意图 | `tasks.archived_at`（可清空，可逆） | 只有人 | **零业务后果**，只影响看板与清单默认过滤 |

派单（handoff）与派生子任务（spawn）拆成两种关系：`handoff_from_task_id` = 血缘（回溯、链深、去重，不缩进、不 rollup），`parent_task_id` = 从属（只 spawn 写，树形 + rollup + 上下文注入）。

三片交付：**P1 口径统一（展示层）→ P2 完成与归档分离（内核 + 数据模型 + UI）→ P3 派单血缘与落点**。P1 独立可验收且立刻消掉「进行中 / 已完成」自相矛盾；P2 是主改动；P3 可并行。

## 证据（真实库，`dev-data/ai-workflow.db`）

| 任务 | 来源 | 工作流 / 阶段 | status | 关键事实 |
| --- | --- | --- | --- | --- |
| `5c0a0bc9` | manual | FULL需求交付 / **已完成**(done) | completed | 11-20 14:36 建；**11-21 14:22:40 owner 点「完成任务」**才变 completed |
| `a6e02161` | handoff ← `5c0a0bc9` | 审查 / **已完成**(done) | completed | 15:49「自测 passed」派单建；**14:20:57 owner 点「完成任务」** |
| `3bfe91bd` | handoff ← `a6e02161` | 验收 / **待办**(todo) | active | 14:11「Code Review passed」派单建；派单目标阶段 `entry_mode=none`，无人拖动即停 |

三张卡是 A→B→C 的流水线，线程页按 `parentTaskId` 建树（`ThreadDetailPage.tsx:64-89`），渲染成 1 父 + 2 子、缩进、挂「子任务」徽标；`depth > 0` 一律打标，spawn 与 handoff 在界面上无法区分。前两张卡的「已完成」徽标是在 owner 手动归档后才出现的——在那之前它们停在「已完成」列却显示「进行中」。

## 问题清单

| ID | 级别 | 症状 | 根因 | 位置 |
| --- | --- | --- | --- | --- |
| F1 | P0 | 停在「已完成 / 已取消」列的任务显示「进行中」，子任务进度停在 `0/1` | 徽标与进度读 `task.status`（= 是否归档），不读阶段类别 | `ThreadDetailPage.tsx:103`、`TaskDetailPage.tsx:342,361,366`、`KanbanBoard.tsx:96` |
| F2 | P0 | 「完成」没有独立概念：只有归档才触发 rollup / 线程收尾 / 结局通知 | 收尾全套挂在 `task.completed` 上，而它同时是「移出看板」 | `commands/run.ts:364`、`commands/task.ts:207-256` |
| F3 | P0 | agent 跑完自动落到「已完成」列零后果；人点「完成任务」= 完成 + 归档，两条路径不对称 | 同上（`goto` 只产 `task.moved`，`close` / `task.complete` 才产 `task.completed`） | `stage-machine.ts:158`、`run.ts:321,364` |
| F4 | P1 | 流水线工单被画成父子树，缩进 + 「子任务」徽标 | handoff 同时写 `handoff_from_task_id` 与 `parent_task_id` | `handoff.ts:114`、`spawn.ts:199-206` |
| F5 | P1 | 已归档任务不能拖回阶段（安全网缺失）；反向「取消归档」入口不存在 | `moveTaskToStage` 用 `status === 'completed'` 早退，归档不可逆 | `stage-machine.ts:216` |
| F6 | P2 | 派单链停在不派活的目标阶段，无人知晓原因 | 阶段派单只校验「目标阶段属于目标工作流」，不校验是否派活 | `workflow/stage-handoffs.ts:163-193` |

## 数据模型目标

### 协议（`packages/core/protocol`）

```ts
/** 任务阶段语义：由当前阶段类别派生，不落表。 */
export const TASK_PHASES = ['todo', 'active', 'finished', 'cancelled'] as const
export type TaskPhase = (typeof TASK_PHASES)[number]

export function taskPhaseOf(stage: { builtin?: BuiltinStageKey | null } | null | undefined): TaskPhase
// pending → 'todo'；active → 'active'；done → 'finished'；closed → 'cancelled'；阶段缺失 → 'todo'

export interface Task {
  // status 删除
  /** 归档时刻；NULL = 仍在追踪（看板与清单默认显示） */
  archivedAt: string | null
}
```

- `stageKindOf` 已有（`entities.ts:353`），`taskPhaseOf` 只做类别 → 阶段语义的映射，不重复实现。
- 删除 `TASK_STATUSES` / `TaskStatus`，`TASK_PHASES` 是唯一词汇。

### 事实

| 变化 | 类型 | payload | 何时产 |
| --- | --- | --- | --- |
| 新增 | `task.finished` | `{ task, outcome: 'done' \| 'cancelled' }` | 进入 `builtin ∈ {done, cancelled}` 的同一批（与 `task.moved` 并出）；`close` 出口、rollup `complete`、人工拖到终态列都走它 |
| 改名 | `task.completed` → **`task.archived`** | `{ task }`（含 `archivedAt`） | 人点归档 / 取消归档；`close` 出口额外补一条 |
| 不变 | `task.moved` | 原样 | 换阶段 |

同批收尾（`closeIfAllDone`、`childrenSettledFacts`、`closeCardsOnFinish`、结局通知）全部改挂 `task.finished`，不再看 `task.completed`。

### 命令面

| 命令 | 变化 |
| --- | --- |
| `task.complete` | **删除**，由 `task.archive` 取代（`{ id, archived?: boolean }`，缺省归档，`false` 取消归档；幂等） |
| `task.move` | 语义扩到「移动到任意阶段」，含内置「已完成 / 已取消」；进入终态即完成（F3 的对称性由此补齐） |
| `task.rerun` / `task.reask` | 拒绝条件从 `status !== 'active'` 改为「阶段类别不是 `active`」（文案：`任务已结束（阶段「已完成」）不能重新执行`） |
| `task.create` | 父任务校验改「父任务未结束」（阶段类别 ∈ `pending/active`），与归档无关 |

命令数 41 → 41（删一加一）。

### 投影 / 迁移

- `tasks` 表：删 `status`，加 `archived_at TEXT`（`NULL` = 在追踪）；`KERNEL_VERSION` → `m53.0.0` 触发重建。
- 老事实归一（`project.ts#normalizeTask` 同层）：
  - `task.completed` → `archivedAt = fact.at`；
  - 同一条事实若 `currentStageId` 不在终态阶段（老 `close` 出口的产物）→ 投影里把阶段归一到该工作流内置「已完成」的 id，使历史徽标与「完成」一致；工作流或阶段已不存在时保持原样并在 `archivedAt` 上体现（不猜）。
- 不保留 `status` 兼容字段（项目硬约束：废弃字段不陪跑）。

## 守卫分流表（`status` 的 44 处按语义重新归属）

| 归属新轴 | 判定改法 | 位置 |
| --- | --- | --- |
| 关**业务结束** | `taskPhaseOf(stage) === 'finished' \| 'cancelled'` | `commands/task.ts:62,301,350`（父任务校验、rerun、reask）、`spawn.ts:111,198`（父任务拦截）、`commands/run.ts:301`（已结束任务零流转）、`threads.ts:154`（`activeTasksOfThread`：规则复用只看还没结束的任务）、`threads.ts:376`（`closeIfAllDone`：线程内还有任务没结束就不收） |
| 关**归档** | `archivedAt !== null` | `KanbanBoard.tsx:76,78,96`、`TaskDetailPage.tsx:303`、归档清单 |
| 关**展示** | `taskPhaseOf(stage)` | `ThreadDetailPage.tsx:103`、`TaskDetailPage.tsx:342,361,366`、`TaskInfoPanel` |
| 直接删 | 不再需要 | `stage-machine.ts:216`（归档任务不在看板，无法拖动）、`enterStage` 里的 `status: 'active'` |

`closeIfAllDone` 的 `overrides?: ReadonlyMap<Id, TaskStatus>` 同步改 `ReadonlyMap<Id, TaskPhase | 'removed'>`（同批刚流转 / 刚删除的任务在视图里还是旧态）。

`spawn.ts:261` 的 rollup `complete` 动作改产「移动到内置已完成」（`task.moved` + `task.finished`），不再直接归档父任务。

## 切片

### P1 口径统一：徽标与进度只看阶段类别（0.5 天，独立可验收）

**改动**

- `packages/core/protocol/src/entities.ts`：新增 `TASK_PHASES` / `TaskPhase` / `taskPhaseOf`。
- `ThreadDetailPage.tsx:103`：「已完成 / 进行中」徽标改 `taskPhaseOf` 四态（未开始 / 进行中 / 已完成 / 已取消），按 `stage-kinds.ts` 取色。
- `TaskDetailPage.tsx:342,361,366`：子任务进度分子与行内文案改阶段类别。
- `KanbanBoard.tsx:96`：卡片子任务统计改阶段类别。
- `TaskInfoPanel`：状态行改为「阶段类别徽标 +（已归档角标，P2 接）」。

**验收**

- 停在「已完成」列的任任务，线程页、详情页、子任务进度、卡片统计四处都显示「已完成」，无需归档。
- 取消归档不参与本片判定（此时还读 `status`），`归档` 区计数保持原样。

**测试**：新增协议用例（`taskPhaseOf` 四态 + 阶段缺失）；改 `ThreadDetailPage` / `TaskDetailPage` / `KanbanBoard` 里以 `status` 造徽标的断言（约 12 处）。

### P2 完成 ≠ 归档：事实拆分 + `archivedAt`（1.5 天，主改动）

**改动顺序（每步可编译、可测）**

1. **协议**：`Task.status` → `archivedAt`；命令面 `task.complete` → `task.archive`；`task.finished` / `task.archived` 事实类型进事实目录与 `view-spec` 切片。
2. **内核 · 完成语义**：`stage-machine` 的 `completeTask()` 删除（改 `archiveTask(task, now)`）；`moveTask` 在目标为终态内置阶段时返回 `finished` 标记；`run.ts#stageTransitionFacts` 在进入终态时与 `task.moved` 同批产 `task.finished`；`close` 出口产 `finished` + `archived`。
3. **内核 · 收尾搬家**：`closeIfAllDone`、`childrenSettledFacts`、`closeCardsOnFinish`、宿主结局通知（`host/notices`）从 `task.completed` 改挂 `task.finished`（含 `run.receipt` 与 `clock.tick` 的视图切片）。
4. **内核 · 命令**：`archiveTaskCommand`（幂等、可逆、执行中拒绝）；`moveTaskToStage` 去掉 archive 早退；`task.rerun` / `reask` / `task.create` 的父任务校验按分流表改判。
5. **投影 / 迁移**：`schema.ts` 换列；`columns.ts`；`normalizeTask` 加老事实归一；`KERNEL_VERSION=m53.0.0`。
6. **UI**：详情页右上动作变「移到已完成」（`task.move` 到内置 done）+「归档 / 取消归档」；`TaskCard` 拖拽条件只看活跃 run；归档区只收 `archivedAt !== null`，「查看归档」清单同口径；`TaskInfoPanel` 补「已归档」角标。

**验收**

| 场景 | 期望 |
| --- | --- |
| agent 跑完自动落「已完成」列 | 产 `task.moved` + `task.finished`；结局通知、收卡、线程收尾、rollup 全部触发；任务**仍在看板上** |
| 拖到「已取消」列 | 产 `task.finished{outcome:'cancelled'}`；不被算作「完成」，归档清单徽标为「已取消」 |
| 点「归档」 | 只写 `archivedAt`；零业务事实；卡片移出看板、进归档清单；可「取消归档」拖回来 |
| 已归档任务被 rollout 或人工再次 move | 允许；不自动清 `archivedAt`（归档是人的意图，不静默改） |
| 执行中点归档 | 内核拒绝（`执行中的阶段不能归档`） |
| 老库重建（`m52` → `m53`） | `task.completed` 展开成 `archivedAt` + 阶段归一到终态；看板与归档清单的历史结果逐条不变 |

**测试**：改 4 条锁旧口径的用例（`stage-machine.test.ts:615`、`scheduler.test.ts:964`、`decide.test.ts:1932,1997`）与 TC-AIW-092；新增 6 条（完成后果、归档零后果、取消归档、执行中拒绝、重建归一、徽标四态）。受影响全量约 90 处断言（`tests/` 内 `task.complete|status: 'completed'` 共 139 处，其余是与 run 状态无关的匹配）。

**风险与回滚**

- 存量重建会改历史行的阶段 → 先在 `backups/` 留一份 `ai-workflow-pre-m53.db`（沿用现有备份约定），重建失败可整库回滚。
- 事实类型改名不可逆（新的 `task.archived` 老版本读不了）——单包发布 + 单一数据库，接受；`docs/testing/` 记录版本跳变。

### P3 派单血缘与落点（0.5 天，可与 P2 并行）

**改动**

- `handoff.ts:114`：不再写 `parentTaskId`；链深、去重仍走 `handoffFromTaskId`（`HANDOFF_MAX_DEPTH=8` 已不依赖队列）。
- `spawn.ts:199-206`：删掉 `children.every(origin === 'handoff')` 混合守卫（拆完字段后无意义）。
- `ThreadDetailPage`：带 `handoffFromTaskId` 的任务不缩进、改为平铺按创建时间，行尾小字「承接自 <标题>」；「子任务」徽标只给有 `parentTaskId` 的行。
- 迁移：`normalizeTask` 对 `origin === 'handoff'` 的 `task.created` 把 `parentTaskId` 归一为 `null`（重建生效，不写新事实）。
- `stage-handoffs.ts`：新增 `handoffWarnings(stage, view)` → 目标阶段 `entry_mode === 'none'` 时给「目标阶段「待办」不派活，链条会停在这里等人」；编辑器展示为提示，内核不拦（投进待办等人认领是合法用法）。
- 编辑器 `stage-draft`：新建派单时默认目标阶段取目标流程第一个 `agent` / `script` 阶段。

**验收**

- 该线程重建后渲染为三行平铺（A / B / C），无缩进、无「子任务」徽标，行尾各带「承接自」。
- spawn 派生任务仍是树 + `1/2` 进度 + rollup 触发；handoff 不再触发 rollup。
- 把派单目标改成「验收 / 自动验收」后保存，第四张卡自动起跑（`entryRunFacts` 已有能力）。

## 交付顺序与依赖

```
P1（展示口径） ──┐
                 ├─→ P2（事实 + 模型 + UI 动作）─→ 收尾验收
P3（血缘 + 落点）┘（与 P2 并行，只碰 handoff / 线程页 / 编辑器）
```

- P2 必须在 P1 之后（`taskPhaseOf` 是 P2 断言的基座）。
- P3 与 P2 的交叉点只有 `normalizeTask` 与线程页，安排在 P2 第 5 步之后合并即可。

## 验收命令

```bash
pnpm check:fast          # typecheck / lint / floor / kernel / secrets / ui
pnpm test:coverage       # 全量单测 + 覆盖率（阈值 98/93/95/98）
pnpm e2e:api             # 纯 API 档
pnpm e2e                 # 看板拖拽 / 归档 / 线程闭环
pnpm check               # 含依赖审计与改动行 ≥90%
```

## 开放问题

1. **归档是否该自动发生**：本轮明确不做（人：完成 ≠ 归档，归档 = 不想追踪了）。若以后要，做成独立的「收纳策略」，与完成语义无关。
2. **`task.archived` 改名是否需要兼容读**：不做双写（单包发布），老版本不回滚到能写归档的方向。
3. **`close` 出口是否保留**：保留——它表达「本单结束并顺手收纳」，与「结束但留在已完成列回看」是两种意图；P2 之后二者第一次可区分。
