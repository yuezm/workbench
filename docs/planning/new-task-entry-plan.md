# 新建任务入口收敛 + 可选工作流（M41）

2026-11-17 落地。相关 Spec：[SPEC-ui §13](../specs/SPEC-ui.md)、[SPEC-ai-workflow](../specs/SPEC-ai-workflow.md)。

## 由来

两件事同时存在：

1. 任务只能建在「看板当前那条工作流」上——想投给别的流程，得先切侧栏再建，而弹窗里不说清这件事；
2. 列底还有一条「+ 新建任务」，就地填标题回车即建——和头部弹窗是同一件事的两个入口、两套校验（列内那套没有必填标识、没有 `role="alert"`）。

用户的心智模型是「任务像 GitHub issue，由工作流接收」：issue 本身不属于某条流程，投给谁是在创建时定的。按这个模型，**归属由「工作流 + 起始阶段」决定，不由入口决定**。

## 决定

- 入口收敛为看板头部「新建任务」一处，列底虚线按钮下线；「从指定的中间阶段起卡」改由弹窗里的「起始阶段」承担。
- 弹窗里可选择**所属工作流**（默认当前看板那条）。
- **只在 UI 层解耦，不动协议**：`TaskInput.workflowId` 与 `Task.currentStageId` 仍是必填归属，看板仍按 `workflowId` 分组。不做「没有工作流的收件箱 / 建完再分派」——那要改内核与投影，不是这次的目标。
- 顺序是**先加后删**：先让弹窗能选工作流并上线，再删列内入口。反过来会出现一段「列内已删、弹窗还不能换流程」的真空。

## 落地

| 文件                                                            | 改动                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/client/app-ai-workflow/src/components/TaskDialog.tsx` | props 改为 `workflows: readonly WorkflowWithStages[]` + `defaultWorkflowId`；新增「所属工作流」「起始阶段」两个 `Select`；选中值只存用户点过的那个、失效在渲染期派生回落；没有可用阶段时就地报错 |
| `packages/client/app-ai-workflow/src/AiWorkflowPage.tsx`        | 删 `quickCreateTask`；`createTask` 成功后 `setSelectedId(input.workflowId)`；弹窗渲染条件改为 `dialogOpen && workflows.length > 0`                                                               |
| `.../components/KanbanBoard.tsx`                                | 删 `QuickAddTask`（含 `TASK_TITLE_MAX` / `TASK_DESCRIPTION_MAX`）与 `onQuickCreateTask` prop                                                                                                     |
| `tests/renderer/.../TaskDialog.test.tsx`                        | props 迁移；新增「换工作流后阶段回落」「默认工作流 id 失效回落」「没有阶段时提交报错」                                                                                                           |
| `tests/renderer/.../KanbanBoard.test.tsx`                       | 删除「列内快速新建」整组（功能下线）                                                                                                                                                             |
| `tests/renderer/.../AiWorkflowPage.test.tsx`                    | 4 条列内新建用例改写为弹窗路径（**断言目标不变**：`projectId=null`、指定阶段、`stageId`、页面错误条 + 弹窗各一份、输入保留）；新增「建成后看板切到任务所属工作流」                               |
| `tests/e2e/thread.spec.ts`                                      | 「看板列内快速新建」改为「新建任务弹窗：标题 + 描述落到指定起始阶段」；DB 断言原样保留（多行描述原样落库、`agent` 阶段建完即产 `queued` run）                                                    |
| `tests/e2e/helpers/seed-two-workflows.ts`                       | 新增：两条互不相干的工作流 + 一个项目（**不复用 `seedRulesBase`**——给它多塞一条工作流会让一批既有用例的默认看板漂移）                                                                            |
| `tests/e2e/new-task-workflow.spec.ts`                           | 新增：弹窗换工作流 → 阶段回落 → 建成后看板跟着切 → 别的流程看不到这张卡 → 落库口径                                                                                                               |

## 没做的事

- 「新建任务」按钮**没有**提到页面顶栏。工作流多起来以后该重估：那时正确的解法是顶栏按钮 + 对当前看板列预选阶段，而不是把列内新建加回来。
- 弹窗不记住上次选的工作流/阶段。要做就落渲染层偏好（`model/entity-order.ts` 同一套机制），会牵动既有偏好模块，这次不做。
- 「描述字段化」（`model/task-brief.ts`，按阶段反推「目标 / 不做什么 / 参考」等段）与本次正交，两者都改 `TaskDialog`，建议串行。

## 已知代价

常用路径从「某列回车建卡」变成「弹窗 → 选工作流 → 选阶段 → 填内容」，多两次点击。缓解只有三条，都不彻底：默认工作流 = 当前看板那条、默认阶段 = 该工作流首阶段、起始阶段带 hint「任务从这里开始执行」。
