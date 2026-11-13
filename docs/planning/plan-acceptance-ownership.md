# 计划：验收归属（M34）——执行阶段不自评，闸门才有验收

> 取代 `flexible-workflow-plan` 的 M20/M21（验收自评 + 阶段内续轮）与 `plan-stage-exits` 的 M33（出口 `retry` 计数）。行为基线见 [SPEC-ai-workflow](../specs/SPEC-ai-workflow.md) 的「柔性工作流（M19–M34）」与「M34 升级」，内核口径见 [SPEC-kernel](../specs/SPEC-kernel.md)「验收归属（M34）」，回执口径见 [SPEC-plugins](../specs/SPEC-plugins.md)。

## 为什么改

M20/M21 把「这个阶段做完了吗」交给干活的那个 run 自己回答：提示词里同时出现阶段说明和验收条目，回执用 `acceptance[]` 自评，未达就在原地续轮。这和 M32 的闸门判定叠在一起后，同一个 run 既被要求交付、又被要求证明交付合格，`checks` 里贴的也是他自己跑的命令。

改成：**执行阶段不谈业务结论**（执行器成功即业务成功），**闸门阶段只做验收**（不实现，只对上一个阶段产出逐条给证据）。于是每个 run 只有一种职责，验收永远来自另一个智能体。

## 行为变更

| 维度 | 改前（M20/M21/M33） | 改后（M34） |
| --- | --- | --- |
| 执行阶段 `run.succeeded` | 读 `acceptance[]`，未全达且未超轮次 → 原地续一轮 | 直接走 `exits.done`，不读任何业务结论 |
| `acceptance` 归属 | 任意 `entry_mode='agent'` 阶段都可配 | 只有闸门阶段（`judge` 非空）可配，其它阶段非空即拒收 |
| 闸门 `pass` 条件 | 至少一条 `checks` 且退出码全 0 | 同上，且**每条验收**要有一条 `exitCode=0` 且 `acceptance=n` 指向它的 `checks` |
| 自动重跑 | `maxRounds`（阶段内）+ `retry{max}`（出口表）两套 | 都没有；再来一轮只能人触发（拖回阶段 / 「重新执行」） |
| 回执键 | 十一个（含 `acceptance`） | 十个；`acceptance` 出现即忽略 |
| 判定者与被验者 | 无约束 | 同一智能体即拒收 |
| 阶段指标 | `runs / avgRounds / repairExhausted / degraded / asks / humanComments` | `runs / verdicts / degraded / asks / humanComments` |
| 提示词轮次段 | 「本阶段第 N 轮（上限 M 轮）」 | 整段删除；同阶段第 2 次起开新会话的会话策略不变（内核算，不进提示词） |

## 代码改动清单

### protocol

- `entities.ts`：删 `AcceptanceCheck`、`STAGE_ROUND_LIMITS`、`STAGE_EXIT_RETRY_LIMITS`、`Task.stageFails`、`Stage.maxRounds`；`STAGE_EXIT_ACTIONS` 去掉 `'retry'`，`StageExit` 联合删 `{do:'retry'}` 分支；`GateCheck` 加 `acceptance?: number`；`Stage.acceptance` 注释改为「闸门阶段的判据清单」。
- `inputs.ts`：`Receipt` 删 `acceptance`。
- `validate.ts`：删 `maxRounds` 校验；`checks[].acceptance` 校验为正整数；删 `receipt.acceptance` 校验；新增「`acceptance` 非空 ⇒ `judge` 非空」。
- `receipt-keys.ts`：删 `acceptance` 键、其文案与上限文案里的「`acceptance` 12 条」；`checks` 文案补 `acceptance: n` 的写法。

### kernel

- `workflow/stage-validation.ts`：删 `retry` 分支；新增两条保存校验——验收只许闸门、判定者 ≠ 被验阶段智能体（被验阶段 = 本阶段之前 position 最大的 `entry_mode='agent'` 阶段）。
- `workflow/stage-machine.ts`：删 `retry` 分支与 `stageFails` 读写；`done` / `passed` / `failed` 语义不变。
- `workflow/acceptance.ts`：保留条目归一，注释改为闸门专用。
- `commands/run.ts`：删 `unmetAcceptance` / `repairRoundFacts` / `repairCommentText` / `STAGE_FAILED_LABEL` 与「先自评后判定」的分流；闸门 `pass` 校验加验收覆盖。
- `prompt.ts`：`acceptanceText` 只在闸门产出并带 1 基序号；`taskReceiptKeys` 删 `acceptance`；闸门段加一句「每条验收要有一条全 0 的 `checks` 指向它」；**删 `roundText` 与「本阶段第 N 轮（上限 M 轮）」段**（续轮没了，这句话只剩噪音）。
- `task-effects.ts`：删 `round` 选项与 `StageRound` 类型；保留 `previousRounds` 用于会话策略（第 2 次起 `fresh`），不再往提示词传轮次。
- `commands/workflow.ts`：删 `maxRounds` 归一与 `STAGE_EXIT_RETRY` 归一，`sameStage` 比较去掉 `maxRounds`。
- `project.ts` / `handoff.ts` / `rules.ts` / `spawn.ts` / `commands/task.ts`：删 `stageFails: 0`。

### host

- `schema.ts`：`workflow_stages` 删 `max_rounds`，`tasks` 删 `stage_fails`，删 `TASKS_M33_ADDED_COLUMNS` 与对应 ALTER。
- `db.ts`：12-step 重建两张表（外键 OFF → 临时表 → 拷行 → 删旧 → 改名），`KERNEL_VERSION` → `M34.0.0`。
- `store/views.ts`、`store/projection-apply.ts`、`store/import.ts`：删两列映射。
- `reconcile.ts`：新增 M34 归一（幂等、写事实）：普通阶段 `acceptance` 清空、`exits_json` 的 `{do:'retry'}` → `{do:'await'}`，作废条数记一条启动日志。

### renderer

- `WorkflowEditor.tsx`：普通阶段不渲染验收与轮次；闸门阶段渲染验收条目（1 基序号前缀，说明「判定者要逐条给证据」）；闸门的智能体下拉排除被验阶段的智能体；保存错误就地展示。
- `model/stage-draft.ts`、`model/sop-templates.ts`：删 `maxRounds`；模板里原本挂在执行阶段的验收挪到紧随其后的闸门阶段，没有闸门就不带验收。
- 阶段指标面板：删 `avgRounds` / `repairExhausted` 两列，加 `verdicts`。

## 迁移与回滚

- 迁移只做「作废 + 归一」，不猜原意：不替用户新建判定阶段、不把验收条目搬进阶段说明。
- 回滚只靠升级前的 DB 备份；`KERNEL_VERSION` 已递增，降级不回读。
- 存量事实重放：`stage.updated{acceptance: []}` 与 `task.updated` 由 reconcile 作者写入，重建投影与增量结果一致。

## 测试清单

单测（`tests/kernel`、`tests/protocol`）：

- 执行阶段 `run.succeeded` → 恰好一条流转事实、零 `run.queued`、零评论（黄金用例）。
- 执行阶段配 `acceptance` 保存 → reject 且文案可读；闸门配验收 → 通过。
- 闸门 `pass`：验收 3 条、`checks` 只覆盖 2 条 → 零事实（停闸门）；覆盖 3 条 → `passed`；某条覆盖它的 `checks` 退出码非 0 → 仍算未覆盖。
- 判定者与被验阶段同一 agent → reject；被验阶段是内置「待办」时取再往前一个 agent 阶段。
- 出口表：`{do:'retry'}` 输入被拒；老事实里的 retry 归一成 `await`。
- `checks[].acceptance` 非法值 → 整块忽略；`acceptance` 键出现 → 忽略且不连累 `verdict`。
- 提示词：同一阶段第 2 次进入**不含**「第 N 轮」段；`task-effects` 仍给 `fresh` 会话。
- 迁移：造含 `max_rounds` / `stage_fails` 的库 → 重建后列不存在、行数不变、归一事实幂等（跑两次第二次零事实）。

组件（`tests/renderer`）：

- 编辑器：执行阶段看不到验收与轮次；闸门看到验收与护栏；选同一智能体被拦并给原因。
- 指标面板：只展示 `runs / verdicts / degraded / asks / humanComments`。

验证命令：`pnpm check`（含 `pnpm check:ui`）。改动行覆盖率 ≥ 90%，不放松阈值。

## 完成标准

1. 任意工作流里，执行阶段的 run 不带验收、不续轮、不自动重跑；业务结论只出现在闸门阶段。
2. 闸门 `pass` 不可能漏判验收条目（漏判 = 停在闸门、零事实）。
3. 同一智能体不能既执行又判定同一阶段。
4. 老库首启迁移后行为符合上表，且不丢任务与历史 run。
5. `pnpm check` 全绿。

## 实现记录（2026-11-13）

落地口径与上文清单一致，四处按实际情况收窄：

1. **存量归一走内核纯函数，不写事实**：`normalizeStage` 对 `judge === null` 的阶段把 `acceptance` 归一成空数组，`legacyExits` 把旧 `{do:'retry'}` 归一成 `{do:'await'}`。投影重建与读新库得到同一形状，省掉一条启动步骤与一批 `stage.updated` 事实。
2. **两列物理删除靠既有 12-step 机制**：`max_rounds` 进 `LEGACY_STAGE_COLUMNS`、`stage_fails` 进新的 `LEGACY_TASK_COLUMNS`；表里还有就重建一次，`TASKS_M33_*` 常量与补列语句一并删除（否则重建后又被 ALTER 加回来）。
3. **顺手修了一处既有缺陷**：`store/views.ts` 的 `TASK_COLUMNS` 漏了 `gate_fails`，闸门预算读回来恒为 `undefined`（被内核 `?? 0` 兜住，表现为「连续未通过次数永远从 0 开始」）。本轮补列，读回真实的 0。
4. **清掉一条不可达路径**：`applyExit` 的 `goto` 自指从「重建入口 run」改成「原地停住」，`run.ts` 的 M33 原地重跑分支随之删除——重跑只能由人触发（拖回阶段 / 详情页「重新执行」）。

另：判定阶段的 `run.access` 仍至少 `full`（跑核对命令所需），这条留在 Open Questions，未在本轮收窄。

验证：`pnpm check` 全绿——196 文件 / 3390 用例、覆盖率 99.84 / 99.16 / 99.89 / 99.93、改动行 75/75 = 100%、`floor-guard` clean、依赖审计 0 漏洞。`pnpm e2e` 未跑（未改主进程启动与打包路径）。
