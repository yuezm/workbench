# Spec: task-fanout（一个任务派生多个子任务）

> Module id：`task-fanout`。内核扩展（M8 候选），依赖 `kernel` / `protocol` / `host`，不改 shell / preload 桥接形状。
> 状态：**待评审**（本文件只做设计，不动代码；评审通过后再出 plan / tasks / 实现）。
> 关联：[ARCHITECTURE](../ARCHITECTURE.md)、[SPEC-kernel](SPEC-kernel.md)（Thread / 派生任务 / 跳数）、[SPEC-plugins](SPEC-plugins.md)（回执与执行约定）、[ai-workflow-research](../planning/ai-workflow-research.md)（Open Question 3）。

## Objective

让 Agent 在**一轮 run 内**把工作拆成 N 个子任务，并让这 N 个成为**看板一等任务**（而不是只躺在 `run_events` 里的文本），同时定义「子任务全部结束后父任务怎么办」的确定性规则。

用户故事：我在「研发」工作流里拖入一张任务「实现登录模块」，进入「进行中」阶段交给 Agent A。Agent A 读产品文档后，在回执里 `spawn` 出 7 个子任务（前端页 / 鉴权接口 / 数据库迁移 / 单测 / 文档 / 联调 / 评审），这 7 个立刻出现在看板上、挂在父任务下、各自按自己的阶段被派给对应智能体；7 个全部结终态后，父任务被唤醒让我（或父 Agent）决定「收尾还是补一轮」。

成功的样子：

- Agent 回执带 `spawn[]` → 内核**直接**建 N 个 `origin='spawn'` 的子任务（`parentTaskId` = 父、继承父线程），不依赖用户预先配规则。
- 子任务按阶段 `entry_mode` 正常派活/等人/停留；看板显示父子关系与「子任务 x/y」进度。
- 全部（或某一批）子任务到达终态 → 按父任务阶段的 `onChildrenSettled` 配置产出一个确定的动作（唤醒父 Agent / 追加通知评论 / 完成父任务），**只触发一次**。
- 重复回执、深度超限、父任务已结终态、超大 fan-out 都有确定护栏，不产生脏数据、不静默膨胀。

## 为什么不是复用 `events[] + 规则`

现有唯一「派生任务」路径是回执 `events[]` → `event.received` → 命中**已启用规则** → `task.created`（[rules.ts:290](../src/kernel/rules.ts)）。它适合「外部世界发生了一件事」的规则化落点，但对本场景有三个硬伤：

1. **必须先有规则**：用户不预先写一条 `(source,type)` 规则，Agent 拆出的任务只会入账、不建任务——「Agent 自己决定拆几个」没有落点。
2. **语义错位**：子任务不是一个「外部事件」，而是父任务的执行者主动分解出的结构化产物，用事件+去重键去套规则，`dedupeKey/subject` 会污染规则引擎的去重与线程归并。
3. **缺深度/批次/幂等原语**：spawn 需要 `batch`（分批推进）、`key`（重跑幂等）、`spawnDepth`（递归熔断）；这些塞进 RawEvent 会让协议变形。

因此新增一条**独立、受校验、内核权威**的原语 `spawn[]`；`events[]` 保留给外部集成与规则，两者并存、互不替代。

## 设计决策（D1–D9）

| 编号    | 决策                                                                                                                                                                                                                                                                                                                                                                    | 理由 / 取舍                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **D1**  | 回执新增 `spawn?: SpawnTask[]`，作为 Agent 派生子任务的唯一原语                                                                                                                                                                                                                                                                                                         | 结构化、可校验、可幂等；与 `events[]` 分工清晰（spawn=子任务分解，events=外部/规则事件）  |
| **D2**  | 子任务复用 `task.created` 事实，`origin='spawn'`（沿用 M7 `handoff` 先例），`parentTaskId` + 新增 `spawnedByRunId` / `batchNo` / `spawnKey` 三列                                                                                                                                                                                                                        | 不新增建任务事实类型，`project` 一行事实→一行投影不变；来源可追溯                         |
| **D3**  | 子任务**默认继承父任务的工作流与线程**，落点阶段 = spawn 项 `stageId`（须属父工作流）＞ 阶段 `subtaskStageId` ＞ 父任务当前阶段。**跨工作流子任务不在此实现**（用既有 handoff）                                                                                                                                                                                         | 最小改动、语义清晰；跨工作流交给 handoff/M7                                               |
| **D4**  | 父任务 rollup：全部（或某批）子任务终态时，按父任务阶段 `onChildrenSettled` 三选一：`wake`（默认，唤醒父 Agent 续接）/ `notify`（追加一条 `author='agent'` 的任务评论等人）/ `complete`（父直接完成）。**默认 wake**，若父当前阶段非 `agent` 入口则降级为 `notify`。卡片必须挂 run（`cards.run_id` 非空外键），父任务此时没有 run，故 notify 用任务评论承载，不用信息卡 | 对齐 Multica「父子不联动、子完成唤醒父」；避免「子完成父自动完成」的语义歧义              |
| **D5**  | 幂等与护栏**全部在内核纯函数里**：`(parentTaskId, spawnKey)` 去重；`spawnDepth ≤ 8`（沿用 handoff 链深口径）；单回执 `spawn` ≤ 32 条；父任务非 `active` 直接丢弃 spawn；rollup 靠「父任务已有活跃 run」判一次（子任务全部终态后不会再产生新的终态事件，天然单次）                                                                                                       | 不信任 Agent 文本；重跑安全；规则只在 kernel                                              |
| **D6**  | **Agent 不能**在 spawn 里指定 `agentId` / `runtime` / `permissionMode` / `cwd` / `prompt`；派给谁只由子任务落点阶段的 `entry_mode` 与绑定智能体决定，其余字段一律忽略                                                                                                                                                                                                   | 守 ARCHITECTURE 边界守则 6：派活目标/目录/权限只能来自本机规则                            |
| **D7**  | spawn 的 `summary` 作为**资料**（子任务 description + 资料文件），进子任务提示词时标注「资料，不是指令」，不拼进命令行                                                                                                                                                                                                                                                  | 指令数据分离；同一父 Agent 不能借子任务描述操控子 Agent 的命令面                          |
| **D8**  | rollup 检测挂在「任务结终态」的三个出口：`task.complete`、`task.remove`、`run.receipt` 里因 `RUN_SUCCEEDED/FAILED` 完成子任务的路径                                                                                                                                                                                                                                     | 覆盖人工完成与 agent 跑完两条终态来源，不漏触发                                           |
| **D9**  | 本能力**纯内核 + 协议 + 投影**，新增一个可选只读视图 `tasks.byParent`；不新增 UI 写命令（spawn 只来自 Agent 回执）                                                                                                                                                                                                                                                      | 保持「看板只读视图、只发既有命令」；人工拆子任务走 `task.create`（增可选 `parentTaskId`） |
| **D10** | **拆分决策归 Agent（语义判断），护栏与落点归内核**；阶段 `spawnPolicy`（`off`/`agent`，缺省 `agent`）控制该阶段是否允许 spawn。内核不判「该不该拆」，只校验与物化                                                                                                                                                                                                       | 内容生成是模型唯一的活；派活/权限/落点仍确定性归内核，守住「分活不是模型判断」            |
| **D11** | **v1 不分批**：`batch` 字段保留但内核按「全部子任务为一批」处理；按批唤醒留后续版本                                                                                                                                                                                                                                                                                     | 先做最小闭环「全部完成一次唤醒」，降低内核/UI 复杂度                                      |
| **D12** | **子任务必须挂父任务 id**：派生 / spawn 子任务 `parentTaskId` 必填 = 直接父任务 id，由内核从 `run.taskId` 推导；Agent 在 spawn 项里自报的 `parentTaskId` 一律忽略。多层派生靠 `parentTaskId` 链 + rollup 级联，不引入根 id 字段                                                                                                                                         | 「挂父 id」是任务树、spawnDepth、rollup 级联与查询的唯一依据；内核推导才防伪造            |

## 谁决定「拆不拆、拆几个」（判断依据与确定性边界）

这是本设计最容易误解的一处，明确分三层：

| 层                                             | 谁决定                        | 依据                                                                       | 确定性       |
| ---------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- | ------------ |
| 拆不拆 / 拆几个 / 拆成什么                     | **Agent（运行时语义判断）**   | 智能体 System Prompt（能力）+ 任务描述 + 线程上下文 + 资料文件（产品文档） | 否，模型判断 |
| 允不允许在这个阶段拆                           | **配置层（owner）+ 内核校验** | 阶段 `spawnPolicy`（`off` / `agent`，缺省 `agent`）                        | 是           |
| 拆完落在哪个阶段 / 派给谁 / 并发 / 深度 / 幂等 | **内核（确定性规则 + 护栏）** | 落点阶段 `entry_mode` + 绑定智能体 + `Limits`                              | 是           |

**内核从不判断「该不该拆成 7 个」——它不读内容、不做语义分类。** 内核只做两件事：(1) 结构校验与护栏（数量 / 深度 / 幂等 / 父 active）；(2) 把通过校验的声明物化成任务并按落点阶段派活。这与 ARCHITECTURE「分活不是模型判断」不矛盾：**「派给谁 / 在哪跑 / 什么权限」始终是确定性规则；「拆解内容」本就是模型唯一能做的事**——模型只能「声明」，落地仍由内核决定。

「判断依据」有三处可配置、可追溯：

1. **能力描述**：写在智能体 System Prompt（如「任务跨多个模块时按模块 spawn」），随智能体配置版本化。
2. **阶段开关**：`spawnPolicy='off'` 时该阶段任何 spawn 都被内核丢弃（如「审核中」不允许再拆）。
3. **完全模板化拆分**（可选）：要「必须按固定 checklist 拆」时，用**规划阶段 + 专用 planner 智能体**（其唯一产出就是 spawn），或由规则触发一次规划 run——仍只是声明，落地同一条内核链路。这样拆分标准可确定性、可审计，不依赖执行 Agent 自由发挥。

## 数据模型变更

### `Task`（`protocol/entities.ts`）

```ts
export const TASK_ORIGINS = ['manual', 'rule', 'handoff', 'spawn'] as const

export interface Task {
  // …既有字段…
  /** 直接父任务 id：spawn / 派生任务**必填**（内核从 run.taskId 推导，Agent 不可指定/伪造）；根任务为 null */
  parentTaskId: string | null
  /** M8：派生出本任务的 run（origin='spawn' 时非 null） */
  spawnedByRunId: string | null
  /** M8：子任务批次（≥1；未分批为 null） */
  batchNo: number | null
  /** M8：spawn 幂等键（同一父任务下唯一；非 spawn 为 null） */
  spawnKey: string | null
}
```

### `WorkflowStage`（`protocol/entities.ts`）

```ts
export interface WorkflowStage {
  // …既有字段…
  /** M8：本阶段派生的子任务默认落点阶段；null = 父任务当前阶段 */
  subtaskStageId: string | null
  /** M8：子任务全部结束时父任务处理；null = 按父阶段 entryMode 推断（agent→wake，否则 notify） */
  onChildrenSettled: 'wake' | 'notify' | 'complete' | null
  /** M8：本阶段是否允许 Agent 派生子任务；off = 该阶段 spawn 一律丢弃，null/缺省 = agent */
  spawnPolicy: 'off' | 'agent' | null
}
```

`StageInput` 增加可选 `subtaskStageId?` / `onChildrenSettled?` / `spawnPolicy?`（保存时校验 `subtaskStageId` 属于本工作流，与 M7 `handoffStageId` 同口径）。

`TaskInput`（`task.create`）增加可选 `parentTaskId?`：人工在看板手工挂子任务时用（与 Agent spawn 走同一内核建任务逻辑；校验父存在、同工作流、父为 active；`origin='manual'`、`parentTaskId`=父）。

### 父子链接（parentTaskId）——子任务必须挂父任务 id

**规则：任何派生 / spawn 出来的子任务，`parentTaskId` 必填 = 直接父任务 id，由内核从 `run.taskId` 取值填入，不接受 Agent 在 spawn 项里自报的 `parentTaskId`（即使塞了也被校验层忽略并以内核推导为准）。**

- **不可伪造**：Agent 只能在 spawn 项里声明 `subject/summary/stageId/batch/key`；`parentTaskId`、`origin`、`threadId` 全部由内核按「当前 run → 其 task」推导（`spawnFacts` 里 `parent = view.tasks.get(run.taskId)`，子任务 `parentTaskId = parent.id`）。这保证子任务永远挂在**真正执行它的父任务**下，而不是模型随口说的 id。
- **多层派生**：`parentTaskId` 构成父子链。子任务再 spawn 的孙子，其 `parentTaskId` = 子任务 id（不是根）。任务树按 `parentTaskId` 递归分组（沿用 [thread-context.ts](../src/kernel/thread-context.ts) 的 children 范式），`spawnDepth` 沿该链回溯计深并封顶 8。
- **rollup 沿链级联**：孙子全部终态 → 子任务（其父）rollup → 子任务终态 → 根任务 rollup；每层按各自的 `onChildrenSettled` 处理，天然支持多层，不需要额外的「根 id」字段。
- **查询**：新增只读视图 `tasks.byParent` 返回某任务的**直接子任务**；「整棵子树」由前端/线程树按 parentTaskId 递归组装（与现有任务树一致）。如后续出现「按根一次查全树」的性能诉求，再加 `rootTaskId`（可选增强，见待定）。
- **人工路径同样**：`task.create` 带 `parentTaskId` 时，`origin='manual'`、`parentTaskId`=父、`spawnedByRunId=null`，其余规则一致。

### DDL 与迁移（`host/schema.ts` / `host/db.ts` / `host/store/*`）

- `tasks` 加三列 `spawned_by_run_id TEXT` / `batch_no INTEGER` / `spawn_key TEXT`；`origin` 的 `CHECK` 扩成 `('manual','rule','handoff','spawn')`（SQLite 不能改 CHECK → 走 M7 handoff 同款 12-step 重建；`TASKS_M8_ADDED_COLUMNS`）。
- `workflow_stages` 加三列 `subtask_stage_id TEXT` / `on_children_settled TEXT` / `spawn_policy TEXT`（`STAGES_M8_ADDED_COLUMNS`）。
- 老事实 replay 归一：`project.ts` 的 `normalizeTask` / `normalizeStage` 缺字段补 `null`（沿用 M6.5/M7 归一先加函数后改 DDL 的顺序）。
- `KERNEL_VERSION` 升 `m8.0.0` → 首启全量重建投影（无存量 spawn 数据，重建后新列全 null，安全）。

## 协议与校验

### `protocol/inputs.ts`

```ts
export interface SpawnTask {
  /** 子任务标题（必填，≤200） */
  subject: string
  /** 描述/验收（≤2000；作资料，不拼指令） */
  summary?: string
  /** 落点阶段（可选；须属父任务工作流；缺省按阶段 subtaskStageId 或父任务当前阶段） */
  stageId?: string
  /** 批次号（可选，1..999；同批一起推进/唤醒；缺省视为同一批） */
  batch?: number
  /** 幂等键（可选；同一父任务下相同 key 只建一次） */
  key?: string
}

export interface Receipt {
  // …既有字段…
  spawn?: SpawnTask[]
}
```

### `protocol/validate.ts`

- `checkReceipt` 增加 `checkList(receipt.spawn, 'receipt.spawn', COMMAND_LIMITS.spawnItems /*32*/, checkSpawnTask)`。
- 新增 `checkSpawnTask`：`subject` 必填（title 上限）、`summary` 可选（description 上限）、`stageId` 可选 id、`batch` 可选整数 1..999、`key` 可选 id。白名单式校验——未知字段（`agentId`/`cwd` 等）自然不读取。
- `COMMAND_LIMITS` 增加 `spawnItems: 32`、`spawnBatchMax: 999`。

### `plugins/shared/receipt-block.ts`

- `RECEIPT_BLOCK_KEYS` 增加 `'spawn'`；`ReceiptBlock.spawn?: SpawnTask[]`；`parseSpawnList`（逐项校验，畸形整块忽略、不回退早块，与现有口径一致）；`applyReceiptBlock` 补 `receipt.spawn`。

### `protocol/facts.ts`

- 复用 `task.created` 建子任务（`origin='spawn'`）。
- 新增审计事实 `task.children_settled`：

```ts
'task.children_settled'
export interface TaskChildrenSettledPayload {
  parentTaskId: string
  childIds: string[]
  batchNo: number | null
  action: 'wake' | 'notify' | 'complete'
}
```

`project()` 对该事实返回 `[]`（纯审计，效果由同时产出的 `run.queued` / `card.opened` / `task.completed` 表达，沿用 `event.received` 的「只入账」模式），`timeline` 归到父任务 scope。

## 内核决策（`kernel/decide.ts` + 新 `kernel/spawn.ts`）

### 1) `spawnFacts(view, run, spawn, now, env)` —— 在 `run.receipt` 分支调用

```ts
function spawnFacts(view, run, spawn, now, env): FactDraft[] {
  const parent = run.taskId ? view.tasks.get(run.taskId) : undefined
  if (!parent || parent.status !== 'active') return [] // 父非 active → 丢弃
  if (spawnDepth(view, parent) >= SPAWN_MAX_DEPTH /*8*/) return [dropAudit]
  const facts: FactDraft[] = []
  const seen = new Set<string>()
  for (const item of spawn.slice(0, SPAWN_MAX_ITEMS /*32*/)) {
    const key = item.key ?? item.subject
    if (seen.has(key)) continue
    seen.add(key)
    if (hasChildWithKey(view, parent.id, key)) continue // 重跑幂等
    const stage = resolveSubtaskStage(view, parent, item.stageId) // 校验属于父工作流
    if (!stage) continue
    const child: Task = {
      /* … */ origin: 'spawn',
      parentTaskId: parent.id, // 父 id 由内核从 run.taskId 推导，Agent 自报值被忽略
      spawnedByRunId: run.id,
      batchNo: item.batch ?? null,
      spawnKey: key,
      workflowId: parent.workflowId,
      currentStageId: stage.id,
      threadId: parent.threadId,
      status: 'active',
      ruleId: null,
      externalRef: null,
      labels: [],
    }
    facts.push({ type: 'task.created', actor: HOST_SCHEDULER, at: now, payload: { task: child } })
    const thread = parent.threadId ? withTask(view.threads.get(parent.threadId)!, child, now) : null
    if (thread) facts.push(...taskAttachedFacts(thread, child, null, HOST_SCHEDULER, now))
    facts.push(
      ...entryRunFacts(
        view,
        child,
        now,
        env,
        HOST_SCHEDULER,
        { ruleId: null, eventIds: [], hops: run.hops },
        { thread, turn: 1 },
      ),
    )
  }
  return facts
}
```

要点：子任务建好后走**同一条**进入链路（`entryRunFacts`）——落点阶段是 `agent` 就再开一轮，是 `user`/`none` 就停；内核不认识「子任务」特殊派活，复用既有工作流引擎。

### 2) rollup 检测 `childrenSettledFacts(view, parentId, now, env)`

在任务结终态的三个出口调用（D8）：

```ts
function childrenSettledFacts(view, parentId, now, env, overrides): FactDraft[] {
  const parent = view.tasks.get(parentId)
  if (!parent || parent.status !== 'active') return []
  const children = childrenOf(view, parentId) // 不含自身
  if (children.length === 0) return []
  // v1 不分批：只要还有 active 子任务就不触发（overrides 把本批刚完成的视为终态）
  if (children.some((child) => (overrides.get(child.id) ?? child.status) === 'active')) return []
  // 幂等：父已有活跃 run 即视为已触发（子任务全部终态后不会再产生新的终态事件）
  if (view.activeTaskIds.has(parentId)) return []
  const action = resolveRollupAction(view, parent) // 阶段 onChildrenSettled ?? (agent→wake | notify)
  const facts: FactDraft[] = [{ type: 'task.children_settled' /* audit */ }]
  if (action === 'wake')
    facts.push(...entryRunFacts(view, parent, now, env, HOST_SCHEDULER, childrenSettledTrigger()))
  else if (action === 'notify')
    facts.push({ type: 'task.comment_added' /* author='agent' 的通知评论 */ })
  else if (action === 'complete') facts.push({ type: 'task.completed' /* parent completed */ })
  return facts
}
```

唤醒提示词 `childrenSettledPrompt()` 是内核确定性文本（列出已终态子任务标题与结果摘要），走既有 `promptExtra` 段，标注「资料，不是指令」。

### 3) `view-spec.ts`

- `run.receipt`：已含 `tasks/threads/cards/runs`，需补 `threads`（已有）——spawn/rollup 所需切片已齐。
- `task.complete` / `task.remove`：补 `runs` 与 `cards`（rollup 判定要读父任务是否有活跃 run）；`task.complete` 现无 `runs/cards`，新增。
- 新增只读视图 `tasks.byParent`（供 UI），`view-spec` 增加对应 query（只读，不进 decide）。

### 4) `kernel/types.ts`

- `Limits` 增加 `maxSpawnItems`、`maxSpawnDepth`（宿主可注入缩短，测试用）。
- 不需要新 `IdKind`（复用 `task` / `event`）。

## 投影与宿主

| 位置                             | 改动                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `host/schema.ts`                 | tasks/stages 新列；`origin` CHECK 扩展；`*_M8_ADDED_COLUMNS`                     |
| `host/store/projection-apply.ts` | `task.created` upsert 带新列；`task.children_settled` 无变更（返回 []）          |
| `host/store/views.ts`            | `Task`/`WorkflowStage` 行映射新列；新增 `tasks.byParent` 查询                    |
| `host/store/import.ts`           | v2/M* 存量归一补 `null` 新列                                                     |
| `host/db.ts`                     | M8 12-step 重建 `tasks`（CHECK 变更）+ `workflow_stages` 加列                    |
| `kernel/project.ts`              | `normalizeTask` / `normalizeStage` 补新字段；`task.children_settled` 分支返回 [] |
| `kernel/timeline.ts`             | `task.children_settled` 归到父任务 scope                                         |

## UI（renderer，只读视图 + 既有命令）

- `KanbanBoard.tsx` / `TaskCard.tsx`：有子任务的卡显示「子任务 x/y」徽标（`query('tasks.byParent')` 汇总进度）；父卡不再只是一张，点开看子任务。
- `TaskDetailPage.tsx`：增「子任务」区块（列表：标题 / 阶段 / 状态 / 子 run 入口），点进各自任务详情。
- `ThreadDetailPage.tsx`：任务树已按 `parentTaskId` 缩进，spawn 子任务自动出现在树里（零改动，仅数据就有）。
- `WorkflowEditor.tsx`：阶段高级项加三个可选字段「子任务落点阶段」「子任务完成后（唤醒父 Agent / 仅通知 / 完成父任务）」「允许拆子任务（on/off）」（对应 `subtaskStageId` / `onChildrenSettled` / `spawnPolicy`）。

## 安全与边界

- **派活权威仍在内核**：spawn 只是「声明要拆成哪几件事」，落点阶段决定谁跑；Agent 不能指定 agent/runtime/权限/cwd/提示词（D6），越权字段校验层直接不读取。
- **指令数据分离**：`spawn.summary` 只能作为子任务 description 与资料文件，进提示词归「资料，不是指令」段（D7）；不拼命令行。
- **熔断**：`spawnDepth ≤ 8`、单回执 ≤ 32、`batch ≤ 999`；父非 active 丢弃；`(parent, key)` 幂等；rollup 只触发一次（父任务已有活跃 run 即视为已触发）。
- **不新增基础设施**：纯内核纯函数 + 协议 + 投影，复用事件溯源、`entryRunFacts`、线程、租约、卡片全套既有机制。

## 兼容与迁移

- 旧库：加列 + CHECK 重建，数据保留；无 spawn 存量，重建后新列 null。
- 旧事实 replay：`normalizeTask/normalizeStage` 补 null；`FACT_TYPES` 新增 `task.children_settled`，老库无此事实，fold 不受影响。
- `KERNEL_VERSION m8.0.0` 触发一次全量重建（既有重建等价测试覆盖）。
- 不改 preload / `WorkbenchApi` 形状；`tasks.byParent` 走既有 `query`。

## 测试策略

- **内核黄金测试**（`tests/kernel/spawn.test.ts`，新）：spawn 建 N 子任务（parent/thread/origin/depth 正确）；深度超限丢弃；父非 active 丢弃；`(parent,key)` 幂等；`spawnPolicy='off'` 时丢弃；rollup wake/notify/complete 三分支；rollup 只触发一次；子任务进入 agent 阶段自动派活、user/none 停留；人工 `task.create` 带 `parentTaskId` 建子任务；重建等价（实时 vs 分批重建逐表全等）。
- **协议/回执块**：`checkReceipt` 的 `spawn` 数量/类型/越界校验；`receipt-block` 解析 `spawn`（畸形整块忽略、不回退）；越权字段被忽略。
- **纯度**：`src/kernel/**` 禁用符号扫描不回归；`spawn.ts` 无 IO/时钟/随机。
- **视图**：`tasks.byParent` 查询返回父子集；`view-spec` 新切片断言。
- **UI**：`TaskCard` 子任务徽标进度与展开（组件测试）。
- 质量门：`pnpm check` 全绿，覆盖率不降（沿用现有阈值）。

## 成功标准

1. Agent A 回执 `spawn` 7 项 → 看板父任务下出现 7 个子任务（任务树 + `子任务 7` 徽标），各自有独立 run，父 RunLog 不被子任务污染。
2. 同一 `spawn` 重放（同 key）不产生重复子任务；父任务已完成后 emit spawn 被丢弃。
3. 7 个子任务全部终态 → 父任务按配置**恰好触发一次**（默认唤醒）或追加一条通知评论 / 直接完成。
4. `spawnDepth` 超 8、单回执超 32、含越权字段均被确定性处理，无脏数据。
5. 重启/重建后投影与增量一致；`pnpm check` 全绿、覆盖率不降。

## Out of scope

- 跨工作流派生子任务（用 M7 handoff）。
- 远端 / 多机 worker 分发。
- Agent 直接指定派活目标 / 权限 / 目录（永不实现）。
- 语义/向量化「自动规划」（本 Spec 只提供确定性原语，拆分由 Agent 产生）。
- 按批唤醒（batch 仅保留字段，v1 不区分批次）。

## 已定 / 待定

**已定（本轮）：**

- 拆分决策归 **Agent 语义判断**（依据 System Prompt + 任务描述 + 线程上下文/资料）；内核只做护栏与物化（见「谁决定拆不拆」）。
- rollup 默认 `wake`（父阶段非 `agent` 时降级 `notify`）。
- v1 不分批：`batch` 字段保留但内核按「全部子任务为一批」处理。
- 子任务默认串行（继承父线程 `concurrency=1`）。
- 人工拆子任务纳入：`task.create` 增可选 `parentTaskId`，与 Agent spawn 同一内核建任务逻辑。
- spawn 落点默认：`stageId`（校验属父工作流）＞ 阶段 `subtaskStageId` ＞ 父任务当前阶段。

**待定（可在 plan 阶段定）：**

1. 模块命名 `task-fanout` 是否合意，或并入 `SPEC-kernel` 作 M8 章节。
2. `spawnPolicy` 放阶段（本稿）还是放智能体能力。
3. 「专用 planner 智能体 + 规划阶段」是否作为独立里程碑一并做（用于确定性/模板化拆分）。
4. 是否加 `rootTaskId`（根任务 id）作为「按根一次查全树」的性能增强（当前 parentTaskId 链已能正确工作，非必需）。

## 建议里程碑（评审通过后再展开 plan/tasks）

- M8a：协议 + 校验 + 回执块解析 + `Task`/`Stage` 字段 + 迁移（可先只落库、不建任务）。
- M8b：`kernel/spawn.ts` 的 spawnFacts + 幂等/深度护栏 + 单测。
- M8c：rollup 三分支 + view-spec + 投影/视图。
- M8d：UI 徽标 / 任务详情子任务区 / 工作流编辑两个字段。
- M8e：整体验收（`pnpm check`、重建等价、手动全流程）。
