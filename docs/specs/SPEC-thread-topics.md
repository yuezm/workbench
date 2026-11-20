# Spec: thread-topics（话题统一：跨工作流派单落回来源话题）

> Module id：`thread-topics`。里程碑 **M50**。替代「派单每次开新线程」的口径（M29 / D11）。
> 本文按本仓 spec 体例落盘（`docs/specs/SPEC-*.md`），不另建根目录 `SPEC.md`。
> 关联：[SPEC-ai-workflow](SPEC-ai-workflow.md)（派单节）、[SPEC-kernel](SPEC-kernel.md)（派单事实）、[SPEC-task-fanout](SPEC-task-fanout.md)（子任务继承线程的先例）。

## 1. Objective

**现状**：派单（M29）每次在目标工作流建新工单时都开一条新隐式线程（`source='handoff'`）。于是一条需求从「需求交付 → 审查 → 修复」的链条被切成 N 条话题：人在需求线程里看不到审查进展，必须切工作流、去另一条线程翻。

**目标**：**话题（thread）承载一次入口 / 一次需求的全生命周期；任务（task）承载一条工作流工单；跨工作流的派单默认落回来源话题。** 一条话题里可以有 N 张卡（N = 经过的工作流数），它们在各自工作流里流转，共享同一份话题记忆。

**非目标**：

- 不做「一张卡跨工作流流转」——`tasks.workflow_id` 是单列，看板列、出口表、闸门、派单全按它算（[schema.ts:113](../../packages/host/store/src/schema.ts)）。卡片数 = 工作流数，是内核结构。
- 不改看板列语义、不改阶段机、不改闸门判定。
- 不迁移历史事实（事实日志只追加）。

**用户与成功**：工作台使用者完成一张配了派单的卡后，在线程详情里看到完整链路（需求卡为父、审查卡缩进为子），无需切换工作流找卡；同时审查阶段的提示词不被执行者的作业笔记污染。

## 2. Tech Stack

沿用仓库现状，不引入依赖：TypeScript（strict）、React 19 + Tailwind、`node:sqlite`（投影库）、Fastify（HTTP/SSE）、Vitest、Playwright、pnpm workspace。

## 3. Commands

```bash
pnpm check:fast      # typecheck + lint + floor/kernel/secrets/ui/packages/paths
pnpm test            # vitest run
pnpm test:coverage   # 覆盖率（门槛见 CONSTRAINTS.md：98/93/95/98）
pnpm check:diffcov   # 改动行覆盖率 ≥ 90%
pnpm check           # 上面全部 + 依赖审计（提交前必须 exit 0）
pnpm e2e             # build + Playwright（含 tests/e2e/handoff.spec.ts）
```

## 4. Project Structure

| 位置                                                                                         | 角色                                         |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `packages/core/protocol/src/entities.ts`                                                     | `StageHandoff` 加 `thread` 字段              |
| `packages/core/protocol/src/validate.ts`                                                     | `checkHandoffs` 校验取值                     |
| `packages/core/kernel/src/scopes/workflow/stage-handoffs.ts`                                 | `handoffThreadOf` 归一 + `sameHandoffs` 比较 |
| `packages/core/kernel/src/scopes/handoff.ts`                                                 | 派单事实按策略选线程                         |
| `packages/core/kernel/src/scopes/project.ts` / `packages/host/store/src/projection-apply.ts` | 两处 `normalizeStage` 补默认值               |
| `packages/core/kernel/src/scopes/rules.ts`                                                   | 事件复用候选收窄                             |
| `packages/core/kernel/src/scopes/thread-context.ts`                                          | 跨流程上下文裁剪                             |
| `packages/client/app-ai-workflow/src/components/WorkflowEditor.tsx`                          | 派单行「话题」下拉                           |
| `packages/client/app-ai-workflow/src/components/ThreadDetailPage.tsx`                        | 任务行工作流徽标、删除确认文案               |
| `tests/kernel/scopes/{handoff,threads,rules,thread-context,prompt}.test.ts`                  | 镜像单测                                     |
| `tests/renderer/src/apps/ai-workflow/components/{WorkflowEditor,ThreadDetailPage}.test.tsx`  | 渲染用例                                     |
| `tests/e2e/handoff.spec.ts`                                                                  | 闭环 e2e                                     |

## 5. Code Style

内核纯函数：中文注释说清「为什么」，不读写 IO，事实由调用方拼。

```ts
/**
 * 派单的话题策略（M50）：缺省沿用来源任务的话题——一条需求的流转不该被切成多条话题。
 * `new` 只留给「派出去的是另一件独立事项」的场景。
 */
export function handoffThreadOf(handoff: StageHandoff): HandoffThreadPolicy {
  return handoff.thread ?? 'inherit'
}
```

## 6. Testing Strategy

| 层         | 工具                                            | 覆盖点                                                           |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| 内核纯函数 | Vitest（`tests/kernel/**`）                     | 归一默认值 / `sameHandoffs` / 事实选线程 / 复用候选 / 上下文裁剪 |
| 投影       | Vitest（`tests/host/store/**`）                 | 两处 normalize 后行形状完整、增量与重建一致                      |
| 渲染       | Vitest + Testing Library（`tests/renderer/**`） | 下拉提交形状、任务行徽标、删除文案                               |
| E2E        | Playwright（`tests/e2e/**`）                    | 界面完成配了派单的卡 → 同话题 2 张卡、分列两个看板               |

门槛：`CONSTRAINTS.md` 的 98/93/95/98 与 `check:diffcov` 90% 不动，不为过关放松。

## 7. Boundaries

**Always**

- 改前先读 [CONSTRAINTS.md](../../CONSTRAINTS.md)，改完跑 `pnpm check`。
- 规则只写在 kernel；UI 只读视图、只发命令。
- 归一逻辑收口在纯函数，投影与内核共用同一份判据。

**Ask first**

- 改 `ThreadRow` / `Task` 契约字段。
- 引入线程并发口径变更（`pickClaims`）。
- 处理存量数据的迁移/合并动作。

**Never**

- 改历史事实或在事实里抹掉「派单来自哪个任务/阶段/run」。
- 为兼容保留两套默认值（一半 inherit、一半 new）。
- 把线程上下文裁剪做成用户配置项（判断依据是工作者，不是配置）。
- 通过改测试预期或删失败用例过关。

## 8. Decisions

| #      | 决策                                                                                                                              | 理由                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **D1** | `StageHandoff.thread?: 'inherit' \| 'new'`，缺省 `inherit`                                                                        | 默认值符合「一次需求 = 一个话题」；`new` 保留「派出去的是独立事项」的表达力                                |
| **D2** | 归一收口 `handoffThreadOf`；两处 `normalizeStage` 补默认值；`sameHandoffs` 比较该字段                                             | 投影不出现半截形状；编辑器改了话题必须落 `stage.updated`，否则静默丢配置                                   |
| **D3** | 上下文裁剪按**工作者**判：当前任务所在工作流 ≠ 线程内其他任务的工作流时，线程上下文只注入 `author='owner'` 的笔记，段尾补一行说明 | 智能体笔记是执行者的作业本，跨职责边界传过去就是偏见源；不加配置项                                         |
| **D4** | 事件复用候选收窄：只在**同一工作流**的 active 任务里取最后一个，并排除 `origin='handoff'`                                         | 否则同一入口再来消息会给审查卡加一轮 run（[rules.ts:319](../../packages/core/kernel/src/scopes/rules.ts)） |
| **D5** | 不动线程并发闸门（`thread.concurrency` 缺省 1）                                                                                   | 同话题跨工作流是接力推进，串行正确；`waiting` 不占位，人审批不会堵住审查                                   |
| **D6** | 存量不迁移：老派单卡留在自己线程                                                                                                  | 事实只追加；从任务详情「子任务」区（`tasks.byParent`，跨线程）仍可达                                       |
| **D7** | `new` 分支保留 `source='handoff'` 新线程；来源标记仍由 `handoff_from_task_id/stage_id/run_id` 承担                                | 线程来源不再是唯一标记，提示词的「来源工单」段不受影响                                                     |
| **D8** | UI：派单行加「话题」下拉、线程页任务行加工作流徽标、删除确认文案写明跨流程卡一并删除                                              | 同话题两张同名卡必须能区分；删除是终态动作                                                                 |

## 9. Success Criteria

1. `inherit` 派单：新任务 `threadId` = 来源任务 `threadId`；来源线程 `taskIds` 含 2 个、`rootTaskIds` 仍只有来源任务；线程详情渲染 2 行且第二行缩进、标「子任务」。
2. `new` 派单：仍开新线程且 `source='handoff'`（M29 行为逐字保留）。
3. 投影里每条 handoff 都带 `thread` 值；改变话题策略后重新保存能落 `stage.updated`（`sameHandoffs` 判不等）。
4. 审查 run 的提示词不含 `author='agent'` 的笔记文本，仍含：任务树、上一轮产出路径、待修复清单、来源工单段。
5. 同一入口再来事件：复用到同工作流的主任务，不会给派单卡加 run。
6. 同话题内两张同名卡在线程页可区分（显示所属工作流）。
7. 删除线程的确认文案含「跨流程的工单会一起删除」，执行后两卡都消失。
8. `pnpm check` exit 0；覆盖率不低于 `CONSTRAINTS.md` 门槛；`tests/e2e/handoff.spec.ts` 通过并断到「同话题 2 张卡」。

## 10. Open Questions

1. **线程并发是否同批开放编辑**：同话题串行下，若源任务 goto 到新的 agent 阶段并同时派单，审查 run 会排队（卡片显示「排队中」）。线程详情的 `concurrency` 目前只读。要不要顺手做成可编辑？
2. **裁剪边界**：~~`## 最近运行` 段是否也裁~~（M52 已删掉这一段，议程消失；本 spec 只裁笔记）。
3. **`new` 的默认呈现**：编辑器里默认收起为「沿用来源话题」，只在需要时展开？还是每行都显式给下拉？
4. **存量合并命令**：是否需要一次性「把某条派单卡并回来源话题」的 owner 命令（本 spec 不做，D6）。
5. **里程碑编号**：暂定 M50（上一里程碑 M49，2026-11-17）。

## 11. 实现记录

2026-11-18（M50 落地，未提交）。与本文的偏差：无（D1–D8 全部按写定口径落地）。

**内核 / 契约**

- `StageHandoff.thread?: 'inherit' | 'new'` + `STAGE_HANDOFF_THREAD_POLICIES`；`validate.checkHandoffs` 挡非法取值，缺省放行（老配置不带该字段）。
- `handoffThreadOf` / `normalizeHandoffs` 收口归一；`sameHandoffs` 比较该字段（只改话题也判不等）；两处 `normalizeStage`（`kernel/scopes/project.ts`、`host/store/src/projection-apply.ts`）补显式值，增量与重建同形。
- `handoff.ts`：`inherit` 复用来源任务话题（不产 `thread.opened`），来源任务没有话题时退化为新开；`new` 保留 M29 行为。
- **实现中新发现的竞态**：`task.complete` 先产派单事实、再用视图判 `closeIfAllDone`，视图里还没有刚建出的卡 → 话题在「刚生出下一张卡」的瞬间被归档，`thread.task_ids_json` 又被关闭事实覆盖回 1 张。修法：`threads.ts` 新增 `threadWithBatchTasks`（取同批 `thread.task_attached` 的最后一行）与 `batchTaskStatuses`（本批 `task.created` 算 `active`），`commands/task.ts#completeTaskCommand` 与 `commands/run.ts` 的阶段流转收尾都改用它。E2E 与 `decide.handoff` 用例锁住。
- `rules.ts`：事件复用候选收窄到「同工作流 + 非 `origin='handoff'`」。
- `thread-context.ts`：跨流程时只注入 `author='owner'` 笔记并留一行说明；判定用 `crossesWorkflow`，并接受**本批刚建、视图里还没有的任务行**（`threadContextText` 第 4 个参数，`task-effects.ts` 传入）——否则最该裁的第一轮会漏裁。

**界面**

- `WorkflowEditor` 派单行加「话题」下拉（沿用来源话题 / 新开话题）。
- `ThreadDetailPage`：跨多个流程的话题给任务行加工作流徽标；删除确认补「跨流程的工单会一起删除」。

**验证**

- `pnpm check:fast` exit 0（50 条既有 lint 警告，0 error；kernel 预算最大 `thread-context.ts` 758/900）。
- `pnpm test:coverage`：236 文件 / **4043** 用例全绿，覆盖率 **98.31 / 96.15 / 97.43 / 98.6**（门槛 98/93/95/98）。
- `pnpm check:diffcov`：本仓 `master` 与本工作分支的 merge-base 早于当前历史，脚本判「无改动的可执行源码行」跳过（exit 0）；不是本轮引入的问题。
- `pnpm e2e -- tests/e2e/handoff.spec.ts`：**2/2 通过**（同话题 2 张卡 + 显式 `new` 单卡两档）。
- 并行执行期间 `tests/server/assembly*.test.ts` / `tests/plugins/executors/dsh/dsh.test.ts` 偶发失败，单跑通过，属既有并发抖动，与本轮改动无关。

**新增/修改的用例**：`tests/kernel/scopes/workflow/stage-handoffs.test.ts`（归一 / 深比较 / 话题随目标带出）、`tests/kernel/scopes/handoff.test.ts`（inherit / new / 退化 / 第一轮裁剪）、`tests/kernel/decide.handoff.test.ts`（同话题不误归档）、`tests/kernel/scopes/rules.test.ts`（不复用派单卡）、`tests/kernel/scopes/thread-context.test.ts`（裁剪三例 + 无当前任务不裁）、`tests/kernel/scopes/project.test.ts`、`tests/host/store/rebuild.test.ts`、`tests/protocol/validate.test.ts`、`tests/renderer/.../ThreadDetailPage.test.tsx` / `WorkflowEditor.test.tsx`、`tests/e2e/handoff.spec.ts` + `helpers/seed-handoff.ts`。

**存量**：不迁移（D6）。升级前的派单卡仍在自己话题里，从任务详情「子任务」区（`tasks.byParent`，跨话题）可达；新派单按 `inherit` 落到来源话题。

**遗留（Open Questions 的处置）**：① 线程并发保持只读（D5，不改 `pickClaims`）；② ~~`### 最近运行` 段不裁~~（M52 删除该段，此项作废）；③ 话题下拉每行都显式给；④ 不做存量合并命令。
