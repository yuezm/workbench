# 新建任务

「新建任务」弹窗是建卡唯一入口：填标题/描述，指定投给哪条工作流、从哪个阶段起，创建后卡片落在看板对应列。

## Sub-features

- `new-dialog` 看板右上「新建任务」打开弹窗（所属项目只读展示落点目录）。
- `title-required` 标题必填：空标题点「创建」给 `role="alert"` 文案「任务标题必填」，焦点回标题框，弹窗不关。
- `choose-workflow` 弹窗里可换工作流，起始阶段候选随之整批换掉。
- `choose-stage` 起始阶段默认该工作流首阶段（内置「待办」），可改任意阶段。
- `brief-modes` 描述默认自由文本；可切「需求 / BUG」按字段填，提交时序列化成带 `##` 段头的正文（
  段用 `#`、段内小节用 `##`，见 `packages/client/app-ai-workflow/src/model/task-brief.ts` 首段注释）。
- `created-lands` 创建成功后弹窗关闭、侧栏工作流切到任务所属那条、卡片出现在选中的列。

## How to get to it (user POV)

- 看板右上角「新建任务」按钮。

## Driving it with verify

Preconditions:

- `doctor` 全 `OK`；默认种子在跑（工作流 `验证流程`、项目 `验证项目`）。
- 脚本用 `await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: 'AI 工作流' }).click()` 先进 app。

- **打开弹窗。** `await page.getByRole('button', { name: '新建任务', exact: true }).click()`；`const dialog = page.getByRole('dialog')`。
  「所属工作流」显示当前工作流、「起始阶段」显示 `待办`；先 `shot('new-task-dialog')` 留动作证据。
- **标题必填。（反向）** 不填标题直接点 `dialog.getByRole('button', { name: '创建' })` → `await dialog.getByRole('alert').waitFor()` 文本「任务标题必填」，`dialog` 仍可见。
- **填内容并创建。** `await dialog.getByLabel('任务标题').fill('验收：新建任务')`、`await dialog.getByLabel('任务描述').fill('由 verify harness 新建')`，点「创建」→ `await page.getByRole('button', { name: '任务：验收：新建任务' }).waitFor()`。
- **落库复查。** `sql("SELECT w.name AS workflow, s.name AS stage, t.description FROM tasks t JOIN workflows w ON w.id=t.workflow_id JOIN workflow_stages s ON s.id=t.current_stage_id WHERE t.title=?", ['验收：新建任务'])` → `验证流程 / 待办 / 由 verify harness 新建`。
- **换起始阶段。** 重新打开弹窗 → `dialog.getByRole('combobox', { name: '起始阶段' }).click()` → `page.getByRole('option', { name: '实施' }).click()` → 创建 → 卡片出现在 `阶段：实施`。

## Gotchas

- 起始阶段默认是工作流**首阶段**（内置「待办」），不是看板当前停留的列。
- 建成后侧栏会自动切到任务所属工作流；否则卡片不出现，人只会当成没建成。
- 弹窗里的「所属项目」只读：项目在左侧切换器里选，弹窗只展示落在哪个目录。
- 描述有总字数上限（含字段段头），超长会被拒并在弹窗内提示，不会静默丢弃。
- 标题 `maxLength` 与协议一致；填满后再输入不会继续增长，assert 用渲染值。
