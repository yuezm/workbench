# 看板与任务流转

看板是工作台的主界面：按阶段分列显示当前工作流的任务卡，卡片能拖到别的列、拖进归档区、点开进任务详情。

## Sub-features

- `board-columns` 按阶段分列渲染，列头是阶段名 + 该列卡片数。
- `card-open` 单击卡片进入任务详情页；「返回」或 Esc 回到看板。
- `drag-stage` 把卡片拖到另一列 = `task.move`，卡片换列且落库。
- `archive-drop` 拖到下方「归档区」= `task.archive`（移出看板，不是完成、不是删除）。
- `archived-list` 「查看归档」按钮打开归档清单（归档数为 0 时禁用）。
- `board-scope` 看板只显示当前工作流的任务；左侧项目切换器换项目 = 换一批任务。

## How to get to it (user POV)

- 打开实例地址 → 顶部 `AI 工作流` 标签 → 默认落在第一条工作流的看板。
- 左侧「项目」列表选项目；「工作流」下拉换流程。
- 点卡片 = 进详情；详情页左上「返回」= 回看板。

## Driving it with verify

Preconditions:

- `doctor` 全 `OK`；默认种子在跑（`验证首张卡` 在 `方案` 列，工作流 `验证流程`）。
- 写一个 drive 脚本（ctx 里有 `page / shot / sql`），或直接用 `scripts/example-drive.mjs` 的形状改。

- **列存在。** 看板列出内置四列与两个用户阶段。`await page.getByRole('group', { name: '阶段：方案' }).waitFor()`（同法查 `待办` / `实施` / `已阻塞`）。每列头带卡片数。
- **卡片在正确的列。** `await page.getByRole('group', { name: '阶段：方案' }).getByRole('button', { name: '任务：验证首张卡' }).waitFor()`。
- **拖到另一列。** `await page.getByRole('button', { name: '任务：验证首张卡' }).dragTo(page.getByRole('group', { name: '阶段：实施' }))`。
  结果：`实施` 列里出现该卡；`sql("SELECT s.name AS stage FROM tasks t JOIN workflow_stages s ON s.id=t.current_stage_id WHERE t.title=?", ['验证首张卡'])` 返回 `实施`。
- **拖进归档区。** `await card.dragTo(page.getByRole('group', { name: '归档区' }))`。
  结果：卡片从看板消失、底部「归档」计数 +1；`sql('SELECT archived_at FROM tasks WHERE title=?', [title])` 非空。
- **归档清单。** `await page.getByRole('button', { name: '查看归档任务' }).click()`，弹窗里能看到刚归档的标题；`shot('archived-dialog')`。
- **进详情。** 点卡片 → 等 `page.locator('section[aria-label="任务详情"]')` 里出现该任务标题（会先渲染「正在读取任务…」）→ `shot('task-detail')`；点「返回」回到 `工作流「<名字>」` 标题。

## Gotchas

- 执行中的任务（有 queued/running 的 run）不可拖：卡片 `draggable=false`，归档也会被内核拒绝。
- `dragTo` 走原生 HTML5 拖拽，只有真浏览器有效（jsdom 单测只能证明事件接线）。
- 归档 ≠ 完成 ≠ 删除：任务仍在库里（`archived_at` 非空），可从「查看归档」翻回去。
- 看板只显示当前工作流：别的工作流的卡在这里看不到，assert 时要先切对流程。
- 阶段列固定宽度、横向滚动：1100 宽只露出前三列，截图取证要断言特定列而不是「全部可见」。
- 详情页首帧是 `正在读取任务…`，直接截图会截到空壳。
