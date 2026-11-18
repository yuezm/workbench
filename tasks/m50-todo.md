# M50 todo — thread-topics

> Plan：[m50-plan.md](m50-plan.md)｜Spec：[SPEC-thread-topics](../docs/specs/SPEC-thread-topics.md)

- [x] T1 契约：`StageHandoff.thread`
  - Acceptance: `thread?: 'inherit' | 'new'` 可选；`validate.checkHandoffs` 拒非法取值；老 payload 缺字段仍通过
  - Verify: `pnpm test tests/protocol`
  - Files: `packages/core/protocol/src/entities.ts`、`packages/core/protocol/src/validate.ts`、`tests/protocol/*`

- [x] T2 归一与深比较
  - Acceptance: `handoffThreadOf` 缺省 `inherit`；`sameHandoffs` 只改 `thread` 也判不等；两处 `normalizeStage` 输出行内 handoff 均带 `thread`
  - Verify: `pnpm test tests/kernel/scopes/workflow/stage-handoffs.test.ts tests/host/store`
  - Files: `stage-handoffs.ts`、`kernel/scopes/project.ts`、`host/store/src/projection-apply.ts`

- [x] T3 派单事实按策略选线程
  - Acceptance: `inherit` 复用来源线程且派单卡不入 `rootTaskIds`；`new` 仍开新线程 `source='handoff'`；源线程 `taskIds` 增 1
  - Verify: `pnpm test tests/kernel/scopes/handoff.test.ts tests/kernel/scopes/threads.test.ts`
  - Files: `kernel/scopes/handoff.ts`

- [x] T4 事件复用收窄
  - Acceptance: 同一入口再来事件复用到同工作流主任务；派单卡（`origin='handoff'`）不被复用
  - Verify: `pnpm test tests/kernel/scopes/rules.test.ts`
  - Files: `kernel/scopes/rules.ts`

- [x] T5 跨流程上下文裁剪
  - Acceptance: 线程内存在其他工作流任务时，线程上下文不含 `author='agent'` 笔记、仍含任务树/运行摘要/产出路径/待修复清单；同工作流时不裁
  - Verify: `pnpm test tests/kernel/scopes/thread-context.test.ts tests/kernel/scopes/prompt.test.ts`
  - Files: `kernel/scopes/thread-context.ts`

- [x] T6 UI：话题下拉、任务行徽标、删除文案
  - Acceptance: 派单行可选「沿用来源话题 / 新开话题」并落 `stage.updated`；线程任务行显示工作流名；删除确认含跨流程提示
  - Verify: `pnpm test tests/renderer/src/apps/ai-workflow/components/WorkflowEditor.test.tsx tests/renderer/src/apps/ai-workflow/components/ThreadDetailPage.test.tsx` + `pnpm check:ui`
  - Files: `WorkflowEditor.tsx`、`ThreadDetailPage.tsx`

- [x] T7 e2e 与文档
  - Acceptance: e2e 断到「界面完成配派单的卡 → 同一话题 2 张卡，分列两个看板」；SPEC 实现记录、SPEC-ai-workflow、SPEC-kernel、TEST-CASES 更新
  - Verify: `pnpm e2e -- handoff`；`pnpm check`
  - Files: `tests/e2e/handoff.spec.ts`、`docs/specs/SPEC-ai-workflow.md`、`docs/specs/SPEC-kernel.md`、`docs/testing/TEST-CASES.md`
