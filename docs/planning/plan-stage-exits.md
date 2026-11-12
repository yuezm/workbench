# 计划：阶段出口表（Stage Exits）

> 状态：**待评审**（未动代码）。取代 `on_complete_stage_id` / `on_reject_stage_id` / `gate_*` / `handoff_*` 四组字段。
> 关联：[SPEC-ai-workflow](../specs/SPEC-ai-workflow.md)（阶段状态机、闸门）、[SPEC-review-handoff](../specs/SPEC-review-handoff.md)、[ARCHITECTURE](../ARCHITECTURE.md)。

## 要解决的问题

`离开一个阶段会发生什么` 现在散在四组字段里，形状各不相同：

| 字段                                        | 触发                       | 动作               |
| ------------------------------------------- | -------------------------- | ------------------ |
| `onCompleteStageId`                         | run 成功                   | 本工作流内换阶段   |
| `onRejectStageId`                           | run 出错                   | 本工作流内换阶段   |
| `gate.onPassStageId` / `gate.onFailStageId` | 判定                       | 本工作流内换阶段   |
| `handoffWorkflowId` / `handoffStageId`      | 成功**且** `position` 增大 | 另一工作流建新任务 |

由此产生三类表达不出来或会被误判的东西：

1. **出错时交接**：没有这个形状。`handoff*` 只挂在成功分支（`handoffOnExit` 收 `succeeded=false` 直接返回空）。
2. **成功但去向更前**（回归 / 返工是正常边）：`exitsForward` 比较 `position`，这条边不交接。
3. **判定与去向绑死**：只有配了 `gate` 的阶段才有"业务失败"这个出口；`fail` 的去向又只能在本工作流内。"评审不过 → 开缺陷单"要再加一层配置。

## 目标形状

一个阶段的出口是一张表，每行 = 一个 guard + 一个动作。guard 是"这次离开由谁触发"，动作是"这次离开做什么"。

```ts
// protocol/entities.ts
export const STAGE_GUARDS = ['done', 'errored', 'passed', 'failed', 'manual'] as const
export type StageGuard = (typeof STAGE_GUARDS)[number]

/** 主去向：每个 guard 恰好一条（缺省由内核补齐）。handoff 不是主去向，是附加动作。 */
export type StagePrimary =
  { do: 'goto'; stageId: string } | { do: 'retry'; max: number } | { do: 'await' } | { do: 'close' }

export interface StageExit {
  on: StageGuard
  action:
    | StagePrimary
    | { do: 'handoff'; workflowId: string; stageId: string | null; forwardOnly?: boolean }
}

export interface WorkflowStage {
  // …既有字段全部保留
  /** 出口表：每个 guard 恰好一条主去向 + 0..N 条派单 */
  exits: StageExit[]
  /** 判定者（原 gate 收窄）：只回答「谁给结论 + 预算」，去向在 exits 里 */
  judge: { maxFails: number } | null
}
```

五个 guard 的来源是**两个轴**，不是五个并列状态：

| guard     | 轴   | 谁给                                             |
| --------- | ---- | ------------------------------------------------ |
| `done`    | 执行 | run 正常结束，且本阶段没有判定                   |
| `errored` | 执行 | run 非零退出 / 超时 / 失联                       |
| `passed`  | 业务 | 判定 `verdict=pass` 且 `checks` 非空、退出码全 0 |
| `failed`  | 业务 | 判定 `verdict=fail`                              |
| `manual`  | 人   | 人拖卡片 / 点「完成任务」                        |

`handoff` 不作为主去向，是因为它**不终结本单**：一张工单可以既进下一阶段、又派出一张新单。主去向只能有一条，派单可以有多条（扇出）。这正好把今天"配了交接却还在继续走"的隐式行为变成两条可见的边。

## 缺省补齐（内核，落库即完整）

`completeExits(stage, flow)` 在 `stageRow()` 里跑，补齐后写库；`sameStage()` 比较前两边都先补齐，避免"补齐"被判定成变更。

| guard     | 缺省主去向                                     | 与今天等价？                           |
| --------- | ---------------------------------------------- | -------------------------------------- |
| `done`    | 下一个自己添加的阶段 → 内置「已完成」→ `close` | 是（`resolveNextStage`）               |
| `errored` | `await`                                        | 是（`onReject` 不指定 = 原地零事实）   |
| `passed`  | 同 `done` 的缺省                               | 是（`resolvePassStage`）               |
| `failed`  | `await`                                        | 是（`resolveFailStage` 无配置 = 原地） |
| `manual`  | 无主去向（落点即目标）                         | 是                                     |

`judge != null` 时 `done` 不是可用 guard（更具体者胜：跑完没有结论就不构成去向，与今天闸门一致），校验拒绝同时存在的写法。

**`errored` 在判定阶段必须保留**：执行器崩了 / 超时 / 失联与"业务过没过"是两个轴，今天也是这么处理的（`RUN_FAILED` 不消耗闸门预算、仍走原出错去向）。

## 执行语义

一次 run 结算 → 选 guard → 执行主去向 → 执行全部派单。取消不选边（沿用今天"取消不推进阶段"）。

| 触发                             | guard                             | 结果                                              |
| -------------------------------- | --------------------------------- | ------------------------------------------------- |
| run 正常结束，无判定             | `done`                            | 主去向 + 派单                                     |
| run 正常结束，判定 pass          | `passed`                          | 主去向 + 派单                                     |
| 判定 fail，未达预算              | `failed`                          | 主去向 + 派单，`stageFails + 1`                   |
| 判定 fail，已达 `judge.maxFails` | `passed`（放行）+ `gate:degraded` | 同 `passed`                                       |
| 判定缺结论 / pass 无 checks      | —                                 | 无边，原地等人                                    |
| run 非零退出 / 超时 / 失联       | `errored`                         | 主去向 + 派单                                     |
| run 取消                         | —                                 | 无边                                              |
| 人拖到某阶段                     | `manual`                          | 落点为准，只执行 `handoff`                        |
| 人点「完成任务」                 | `manual`                          | 归档，只执行 `handoff`（`forwardOnly` 视为 true） |

主去向的四种执行：

| 动作    | 事实                                                                           | 说明                                                                            |
| ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `goto`  | `task.moved{from,to}` + 进入效果（`entryRunFacts`）                            | 同一张工单换阶段                                                                |
| `retry` | `task.updated{stageFails+1}` + `run.queued`；`stageFails > max` 时改走 `close` | 原地重跑，预算耗尽收口并打 `stage:failed`                                       |
| `await` | 零事实                                                                         | 显式声明"停在这里等人"；UI 由「最近 run 失败 + 无活跃 run」派生"失败待处理"徽标 |
| `close` | `task.completed`                                                               | 本单结束并归档（今天末阶段的自动行为）                                          |

派单：每条 `handoff` 产 `task.created{origin:'handoff'}` + 隐式线程 + 目标阶段为 agent 时的入口 run（沿用 `handoffFacts`）。

`judge.maxFails` 是**放行护栏**，不是重试次数：连续未通过达到上限后，`failed` 边的去向被 `passed` 取代并打 `gate:degraded`。`null` = 关掉护栏（失败永远按 `failed` 走）。这两件事在旧实现里是同一个数字，容易配出反效果（见下节）。

## 示例：CR 通过 → TEST，不通过 → 研发

需求：CR 工作流的「评审」阶段，业务通过就派进 TEST 工作流，业务不通过就派回研发工作流；执行器自己崩了要停下等人。

```
阶段「评审」  类型 [交给智能体]  智能体 [评审员]
  完成时      —（判定阶段没有这一行）
  出错时      主去向 [停在这里等人 ▾]              另外派单 [ ]
  通过时      主去向 [移到内置阶段 ▾][已完成 ▾]    另外派单 [测试工作流 · 测试中]
  未通过时    主去向 [本单结束并归档 ▾]            另外派单 [研发工作流 · 修复]
  人工拖动    另外派单 [ ]
判定         [x] 由智能体给结论    允许未通过 [不设护栏 ▾] 次后放行
```

对应的 `exits`：

```json
[
  { "on": "errored", "action": { "do": "await" } },
  { "on": "passed", "action": { "do": "goto", "stageId": "<内置 已完成>" } },
  { "on": "passed", "action": { "do": "handoff", "workflowId": "<测试>", "stageId": "<测试中>" } },
  { "on": "failed", "action": { "do": "close" } },
  { "on": "failed", "action": { "do": "handoff", "workflowId": "<研发>", "stageId": "<修复>" } }
]
```

四点必须说清：

1. **执行器成功不等于"进完成阶段"**。在判定阶段，`run.status='succeeded'` 只说明这一轮跑完了，它不选任何边；去向由 `verdict` 决定。只有在没有判定者的阶段，执行成功才等于 `done` 边。
2. **"进完成阶段"和"结束本单"是两件事**。`goto 内置「已完成」` 让卡片停在绿色列、仍是 `active`、不归档；`close` 直接归档移出看板。工单串联建议 `close`——否则 CR 看板会堆满永远不归档的绿卡。
3. **派单不终结本单**，必须显式给主去向。想让本单"只派单、自己结束"就是 `close` + `handoff` 两条边。
4. **护栏不要设 1**。`maxFails: 1` 的含义是"第一次不过就放行"，会把 `failed` 边整个绕过、直接派进 TEST。要"一次不过就回研发"就用 `null`（不设护栏）；要"最多返工 3 次再放行"才填 3。

派单目标要落到目标工作流里 `entryMode='agent'` 的阶段（示例里的「测试中」），否则新单停在「待办」不动——「待办」是 `none`，不会自动起 run。

## 事实与投影

- `stage.created` / `stage.updated` 的 payload 带 `exits` / `judge`（整行演进，沿用现状）。
- 交等去重键从 `(taskId, stageId)` 改为 `(taskId, stageId, runId)`：同一阶段第二次成功要能再发一张单（工单模型下这是修正，不是放宽）。人工拖拽 `runId = null`，不参与去重。
- `Task` 增 `handoffFromRunId: string | null`（弱引用，人工为 null），供 review 定位与审计。
- `Task` 增 `stageFails: number`（默认 0，进入阶段清零），`retry` 预算用它计数。
- 投影列：`workflow_stages.exits_json TEXT NOT NULL DEFAULT '[]'`、`workflow_stages.judge_max_fails INTEGER`、`tasks.stage_fails INTEGER NOT NULL DEFAULT 0`。
- 旧列（`on_complete_stage_id` / `on_reject_stage_id` / `gate_*` / `handoff_*`）**写路径一律写 NULL，读路径不读**，保留到独立的清理任务删除（与 `import.ts` 兼容层同一处置口径）。
- `KERNEL_VERSION` → `M29.0.0`（新列 + 语义变化，触发全量重建）。

**不写迁移脚本**：`project.normalizeStage` 从旧事实的旧字段合成 `exits` / `judge`，重建即迁移。合成函数必须是纯函数并单测：

```
onCompleteStageId → { on:'done', do:'goto', stageId }            （null → 缺省补下一阶段）
onRejectStageId   → { on:'errored', do:'goto', stageId }         （null → await）
gate.onPassStageId→ { on:'passed', do:'goto' }
gate.onFailStageId→ { on:'failed', do:'goto' }
handoffWorkflowId → { on:'done', do:'handoff', workflowId, stageId, forwardOnly:true }
```

`forwardOnly: true` 是旧 `exitsForward` 的唯一残留，且只作用于 `manual` 与旧事实合成出来的 `done` 边——人工拖回更前阶段（返工）不派单，与今天一致。

## 校验（`kernel/workflow/stage-validation.ts` 重写）

顺序固定，返回第一条文案：

1. 阶段数 ≥ 1、名称非空、`entryMode='agent'` 必选智能体。
2. `exits` 条数 ≤ 8 / 阶段；同一 guard 的主去向 ≤ 1；`manual` 只允许 `handoff`。
3. `retry.max` ∈ 1–5。
4. `goto` 目标下标在范围内、不能指向自身（自指一律改用 `retry`）。
5. `judge` 存在时不允许 `done` 边（拒绝而不是静默忽略）；`errored` 允许。
6. `judge` 要求 `entryMode='agent'`；`judge.maxFails` 为 `null`（不设放行护栏，失败永远按 `failed` 边走）或 1–5 的整数。
7. 内置「已完成 / 已取消」不允许任何出口（含 `handoff`）。
8. 跨工作流：目标工作流存在且 ≠ 自身；给了 `stageId` 就必须属于目标工作流。

## UI（`WorkflowEditor.tsx` 阶段详情）

固定三块，不再按"类型"收起字段（删掉 `pruneForKind` 那套"隐藏的字段保存时归一成默认值"）：

```
进来时      类型 [交给智能体 ▾]  智能体 [评审员 ▾]
出口
  完成时      主去向 [进入下一阶段 ▾][评审中 ▾]        另外派单 [+]
  出错时      主去向 [停在这里等人 ▾]                  另外派单 [+]
  通过时      …（判定开关打开后才出现）
  未通过时    …
  人工拖动    只允许派单：[+]
判定         [ ] 本阶段由智能体给结论   允许未通过 [3 ▾] 次后放行
```

下标重映射统一成 `remapExits(exits, fn)`，替换 `stage-draft.ts`（`withBuiltinStages` / `dropStageIndexes` / `insertUserStage`）与 `WorkflowEditor` 里四处 `onCompleteIndex/onRejectIndex/gate.onPassIndex/gate.onFailIndex` 的重复逻辑。

## 改造清单

| 层   | 文件                                             | 改什么                                                                                                                                                                                  |
| ---- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议 | `src/protocol/entities.ts`                       | 新增 `STAGE_GUARDS` / `StagePrimary` / `StageExit`；`WorkflowStage` 加 `exits` / `judge`；`StageInput` 换成 `StageExitInput[]`；`GateConfig` 收窄为 `JudgeConfig`                       |
| 协议 | `src/protocol/validate.ts`                       | `checkGate` → `checkExits`（条数、guard 枚举、动作字段、retry 范围）；`checkStage` 换字段                                                                                               |
| 内核 | `src/kernel/workflow/stage-machine.ts`           | 删 `resolveNextStage` / `resolveRejectStage` / `resolvePassStage` / `resolveFailStage` / `exitsForward`；新增 `completeExits` / `selectExits` / `applyExit`；`moveTask` → `settleStage` |
| 内核 | `src/kernel/workflow/stage-validation.ts`        | 按上节 8 条重写                                                                                                                                                                         |
| 内核 | `src/kernel/commands/workflow.ts`                | `stageRow` 落 `exits` / `judge`；`sameStage` 加 `sameExits` / `sameJudge` 并先补齐再比                                                                                                  |
| 内核 | `src/kernel/commands/run.ts`                     | `stageTransitionFacts` → 调 `settleStage`，一次产出主去向 + 全部派单事实                                                                                                                |
| 内核 | `src/kernel/commands/task.ts`                    | `moveTask` / `complete` 走 `manual` guard，不再伪造 `succeeded=true`                                                                                                                    |
| 内核 | `src/kernel/handoff.ts`                          | `handoffFacts` 收 `exit` 参数（不再读阶段两列）；去重键换 `(task, stage, runId)`；`exitsForward` 依赖删除；`validateStageHandoffs` → `validateStageExits`                               |
| 内核 | `src/kernel/project.ts`                          | `normalizeStage` 合成 `exits` / `judge`；新增 `normalizeTask.handoffFromRunId` / `stageFails`                                                                                           |
| 内核 | `src/kernel/task-effects.ts`                     | 进入阶段清零 `stageFails`；`runAccessOf` 改读 `judge`                                                                                                                                   |
| 投影 | `src/host/schema.ts`                             | 三列新增；`workflow_stages` 旧列保留置空（注释写明废弃与清理任务）                                                                                                                      |
| 投影 | `src/host/store/views.ts`、`projection-apply.ts` | 读写 `exits_json` / `judge_max_fails` / `stage_fails` / `handoff_from_run_id`                                                                                                           |
| 投影 | `src/host/store/builtin-stages.ts`               | 内置阶段的补建行带 `exits: []`（由内核补齐）                                                                                                                                            |
| UI   | `model/stage-draft.ts`                           | `emptyStage` 改 `exits: []`；四个重映射函数换 `remapExits`                                                                                                                              |
| UI   | `model/sop-templates.ts`                         | 模板阶段改写为出口表（内容不变，形状变）                                                                                                                                                |
| UI   | `components/WorkflowEditor.tsx`                  | 阶段详情三块 + 出口表；删 `pruneForKind`                                                                                                                                                |
| UI   | `components/TaskCard.tsx` / `TaskInfoPanel.tsx`  | 「失败待处理」徽标（派生）                                                                                                                                                              |
| 测试 | `tests/kernel/workflow/stage-machine.test.ts` 等 | 见下节                                                                                                                                                                                  |

## 行为变更（必须写进 SPEC 迁移说明）

1. **派单不再看 `position`**：成功但去向更前的合法边也会派单（`forwardOnly` 仅保留给 `manual`）。
2. **同一阶段可以多次派单**：第二次成功会再发一张单（去重键改为 runId）。
3. **`manual` 默认不派单**：旧行为是"拖到更后阶段自动派单"，现在要在 `人工拖动` 行显式加派单（默认 `forwardOnly: true`，语义等价但不隐式）。

其余全部与今天逐字等价，靠"缺省补齐"和"旧事实合成"两层保证。

## 测试

- `completeExits`：五种缺省、末阶段无下一阶段、judge 阶段、内置终态。
- `selectExits`：9 条触发的 guard 选择（含取消无边、判定缺结论无边、预算耗尽放行）。
- `applyExit`：四种主去向的 task 与 effects（`retry` 预算内 / 耗尽）。
- `normalizeStage` 合成：五种旧形状 → 新形状；两次归一幂等。
- 投影 rebuild：老事实集重建后 `exits` 与合成结果全等；新事实集重建与原表全等。
- `stage-validation`：8 条校验各一个用例 + 首条优先。
- 组件：出口表增删行、切类型清空互斥行、下标重映射（插阶段 / 删阶段 / 上下移）后目标不错位。
- 覆盖率：`stage-machine.ts` 分支覆盖 100%（沿用门槛），`pnpm check` 全绿。

## 里程碑

| #   | 内容                                                              | 可独立上线                 | 回滚                                                                          |
| --- | ----------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| S1  | 协议 + 内核 + 投影 + 归一 + 老事实合成                            | 是（行为三条变更随之落地） | 需回退 `KERNEL_VERSION` 并重建；旧列已被置空，**不可无损回滚**——上线前备份 DB |
| S2  | UI 出口表 + `remapExits` + 模板改写                               | 是                         | 纯渲染层，回滚无数据影响                                                      |
| S3  | `retry` 预算 + `stage_fails` + `stage:failed` 徽标与归档可见性    | 是                         | 列可留空                                                                      |
| S4  | 旧列物理清理（12-step 重建 `workflow_stages`）+ 指标（exit 分布） | 否                         | 依赖 S1 稳定后                                                                |

S1 与 S2 之间不要长期停顿：S1 之后旧列不再写，界面上如果还按旧字段渲染，会显示成"所有阶段都没配去向"。

## 不做

- 不新增任务状态：`active` / `completed` 不动，"完成 / 出错 / 成功 / 失败"由 guard + 最近 run 派生，不落列。
- 不新增内置阶段（不加"已失败"列）：收口走 `close` + `stage:failed` 标签，避免动 `STAGE_KINDS` 与看板配色。
- 不做条件表达式（`if: a && b`）：guard 是枚举，不是表达式语言。
- 不把 `exits` 拆成独立投影表：阶段是整行演进，JSON 列与 `acceptance_json` / `options_json` 同口径。
