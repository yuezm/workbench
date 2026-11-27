# 工作流编辑器

工作流 = 一串阶段 + 每阶段的流转配置。设置 → 工作流 里新建（空白或 SOP 模板预填）、改名、改阶段、保存、删除，
列表顺序还可在界面上拖动调整（渲染层偏好，跨刷新保留）。

## Sub-features

- `wf-new-blank` 「新建工作流」下拉 →「从空白创建」：草稿只有四个内置阶段（待办 / 已阻塞 / 已完成 / 已取消）。
- `wf-new-template` 下拉第二组「SOP 模板」七条：产品发现 / 研发交付 / 测试质量 / 缺陷修复 / 发版运维 / 事故复盘 / 迭代回顾。
- `wf-edit` 行内「编辑」打开「工作流定义」弹窗，改名称/阶段后「保存」。
- `wf-reorder` 拖动行（`拖动排序：工作流 <名字>`）调顺序，顺序进 localStorage，刷新后仍在。
- `wf-remove` 行内「删除工作流 <名字>」。

## How to get to it (user POV)

- 侧栏「设置」→ 左栏「工作流」→ 右上「新建工作流」下拉；每行右侧「编辑 / 删除」。

## Driving it with verify

Preconditions:

- `doctor` 全 `OK`；默认种子（已有工作流 `验证流程`）。
- 行内「编辑 / 删除」每行各一个：先用 `getByRole('listitem').filter({ has: page.getByRole('button', { name: '选择工作流 <名字>' }) })` 收窄到行，否则命中两个按钮。

- **从空白新建。** `await page.getByRole('button', { name: '新建工作流' }).click()` → `await page.getByRole('menuitem', { name: '从空白创建工作流' }).click()` → 弹窗 `getByLabel('工作流名称').fill('空白验证流')` → 「保存」→ `await page.getByRole('button', { name: '选择工作流 空白验证流' }).waitFor()`；`sql('SELECT name FROM workflows')` 含它。
- **从模板新建（预期被拒，先证前置）。** 下拉里点 `menuitem name='使用模板 产品发现'` → 编辑器预填 `产品发现`、阶段列表 10 项（6 模板阶段 + 4 内置）→ 直接「保存」→ 弹窗内出现「阶段「机会识别」设为交给智能体时必须选择智能体」。逐个阶段选好智能体后保存才会成功；无人值守的验证走「从空白创建」。
- **改名。** 选中行 → 行内「编辑」→ `getByLabel('工作流名称').fill('空白验证流-改名')` → 「保存」→ 行名变 `选择工作流 空白验证流-改名`，`workflows.name` 同步。
- **拖拽排序。** `await page.getByRole('button', { name: '拖动排序：工作流 空白验证流-改名' }).dragTo(page.getByRole('button', { name: '拖动排序：工作流 验证流程' }))` → 行序变成 `[空白验证流-改名, 验证流程]`（读 `选择工作流 *` 的 aria-label 列表）；`page.reload()` 后仍是这个顺序。
- **删除。** 行内「删除工作流 <名字>」→ `await page.getByRole('button', { name: '选择工作流 <名字>' }).waitFor({ state: 'hidden' })`；`workflows` 里没有它；`shot('workflow-deleted')`。

## Gotchas

- 模板只预填阶段与每阶段「要干什么」，保存前不落库；模板阶段是「智能体」类型，未选智能体时保存被拒（见上）。
- 阶段名称必填，为空时保存被拒并在对应的 `阶段<n>名称` 上标错。
- 保存提交整份定义（阶段 id 回传保留历史）；改一半取消不会写库。
- 列表顺序是渲染层偏好在 `localStorage`，不进库——换浏览器 profile / 清缓存就回到视图顺序。
- 编辑弹窗里还有出口表、派单、验收等大段配置；只改名称时不要误动这些字段，保存前会做悬空目标校验。
