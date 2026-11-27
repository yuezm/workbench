# 项目

项目 = 本地文件夹 + 名字，是任务的容器和执行工作目录。侧栏顶部常驻项目切换器，任务看板跟着项目走。

## Sub-features

- `project-add` 标题行「+ 添加」打开「新建项目」，名称 + 文件夹路径必填。
- `project-switch` 点项目行切换；当前项 `aria-current="page"`。
- `project-edit` 选中项旁的「编辑」打开「编辑项目」。
- `project-remove` 编辑态「删除项目」（项目下任务归回默认目录）。
- `default-dir` 列表末尾常驻「默认目录」= 没有项目文件夹时的落点，没有编辑入口。

## How to get to it (user POV)

- 左侧「项目」分区：`+ 添加` 新建；点行切换；选中行右侧「编辑」；「默认目录」行。

## Driving it with verify

Preconditions:

- `doctor` 全 `OK`；默认种子（已有项目 `验证项目`）。
- 新建项目时路径填本次 run 已存在的绝对目录：脚本里 `state.dataDir`。

- **新建。** `await page.getByRole('button', { name: '+ 添加' }).click()` → 弹窗里 `getByLabel('项目名称').fill('验收项目')`、`getByLabel('文件夹路径').fill(state.dataDir)` → 点「保存」→ `await page.getByRole('button', { name: '项目：验收项目' }).waitFor()`；`sql('SELECT name FROM projects')` 含 `验收项目`；`shot('project-created')`。
- **切换。** 点 `项目：验证项目` 行 → 该行 `aria-current="page"`，看板换成该项目的任务。
- **编辑。** 选中 `验收项目` → `await page.getByRole('button', { name: '编辑项目 验收项目' }).click()` → 改名 → 「保存」→ 行名跟着变（库里 `projects.name` 同步）。
- **删除。** 编辑弹窗里 `getByRole('button', { name: '删除项目' }).click()` → 行消失：`await page.getByRole('button', { name: '项目：验收项目' }).waitFor({ state: 'hidden' })`；`projects` 里没有它。
- **默认目录。** 点「默认目录」行 → `aria-current="page"`，看板显示的是 `tasks.unassigned`（无项目任务）。

## Gotchas

- 名称与路径任一为空时「保存」禁用，旁边写明「名称与文件夹路径都必填」。
- 文件夹路径就是该项目任务的运行目录：手输错一个字符就落到别的目录，验证时用 `state.dataDir` 这种确定的绝对路径。
- 删除有执行中任务的项目会被内核拒绝，错误就地展示（先停执行再删）。
- 「编辑」按钮只挂在当前选中项上；没选中就找不到它。
- 删除项目不会删任务：任务归回默认目录，`tasks.project_id` 变 null。
