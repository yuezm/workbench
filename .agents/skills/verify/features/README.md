# Workbench 验证地图

这份目录是 Workbench 用户可见行为的验证源。驱动前先读本索引，再按对应功能文件走。

## 基线前置

- 仓库根执行 `pnpm build`，产出 `out/server` 与 `out/web`（`launch` 缺产物会直接报错）。
- `node .agents/skills/verify/scripts/verify.mjs launch`：一次性数据目录 + 系统分配端口，默认带种子
  （工作流 `验证流程`、项目 `验证项目`、卡片 `验证首张卡` 在 `方案` 列）。
- 换独立 run：`--run <名字>`；不要在两个 run 之间共享数据目录。
- 先 `node .agents/skills/verify/scripts/verify.mjs doctor`，8 项全 `OK` 才驱动。
- 只驱动本次 `launch` 起的实例；`state.json` 里的 `url`/`pid` 是唯一入口。

## 驱动约定

- 每条 journey 都从基线前置状态开始，除非它自己写了别的条件。
- 定位一律用 ARIA 角色 + 无障碍名（`getByRole` / `getByLabel`），不用 CSS 选择器和坐标。
- 界面动作走 `verify.mjs drive <脚本>`；一次查询走 `verify.mjs query <view>`；落库复查走 `verify.mjs sql "SELECT ..."`。
- 改过数据后要复原的方式写在功能文件的 Gotchas 里；证据（`artifacts/`）不在清理范围内。

## 取证与跳过口径

- 证据要同时包含动作与结果状态：点开的弹窗截图 + 结果页截图 + `sql` 查到的库行（或 `query` 读到的视图）。
- 界面证据带 ARIA 快照：`page.locator('body').ariaSnapshot()` 写入 `artifacts/<feature>.aria.txt`。
- 只截最终画面不算证据；只走一个入口不算验完（本文件列了几个入口就走几个）。
- 走不通的入口要报告：贴出尝试的命令和没满足的前置，不许用另一个入口冒充已验证。
- `drive` 打印的 `console.error` / `pageerror` 是证据的一部分，别静默忽略。

## 功能入口契约

每个功能文件以 H1 标题 + 一段用户视角说明开头，然后固定四个 H2：`Sub-features`、
`How to get to it (user POV)`、`Driving it with verify`、`Gotchas`。
`Driving it with verify` 以 `Preconditions:` 开头，每条 bullet = 用户的动作 + 精确命令 + 可观察结果。

## Features

- [看板与任务流转](./kanban-board.md) —— 阶段列、卡片、拖拽换阶段、拖拽归档、归档清单、进入任务详情。
- [新建任务](./new-task.md) —— 弹窗建卡、标题必填、投给哪条工作流/哪个阶段、创建后落到选中的列。
- [项目](./projects.md) —— 新建 / 切换 / 编辑 / 删除项目，以及「默认目录」落点。
- [设置与服务信息](./settings.md) —— 设置七个栏目、服务只读面板（数据目录 / 版本 / 进程号）。
- [工作流编辑器](./workflow-editor.md) —— 新建工作流（空白 / SOP 模板）、编辑阶段、保存、删除。
