---
name: verify
description: 驱动 Workbench（Node 常驻服务 + 浏览器界面）走真实用户路径并取证：起一个隔离实例、点界面 / 调三动词接口、截图 + 查 SQLite。当需要证明看板、任务、项目、设置、工作流某处改动在真实应用里生效，复现界面缺陷，或给行为留可复查证据时用它。
---

# verify（Workbench 验证驱动器）

一个 run = 一次性数据目录 + 系统分配端口 + 一个脱离本会话的服务进程。**只驱动自己起的实例**，
不碰本机常驻的 `~/.workbench`（默认 3000）。

## Launch

```bash
pnpm build                                                   # 前置：产出 out/server + out/web（缺了 launch 直接报错；pnpm dev 在跑也算）
node .agents/skills/verify/scripts/verify.mjs launch         # 默认 run=default，带种子
node .agents/skills/verify/scripts/verify.mjs launch --run fix-kanban --empty
```

- 就绪判据：服务日志出现 `workbench listening on http://127.0.0.1:<port>`。`launch` 自己等这一行，
  实测 ~0.5s；成功即打印 state JSON（`url` / `pid` / `dataDir` / `dbPath` / `artifactsDir` / `seeded`）。
- 默认种子（全走公开命令，与界面同一条路径）：工作流 `验证流程`（待办 / 方案 / 实施 + 三个内置阶段）、
  项目 `验证项目`（路径 = `<run>/data/workdir`）、一张卡 `验证首张卡`（在 `方案`）。
  阶段一律 `entryMode:'none'`，不起任何子进程。`--empty` 不写种子（界面是「尚无工作流」空态）。
- 启动分两段：先在一个 `PATH` 为空的目录里起一次服务、只写一条 `plugins.replace`（停用飞书通道），
  再正常起。**这一步不能省**：飞书读本机 `~/.lark-cli` 的真实登录态，起来就会用真人身份挂事件流。
- 运行态在 `.scratch/verify/<run>/`：`state.json`（台账）、`data/`（一次性数据目录）、`artifacts/`（证据）、
  `server.log` / `server-phase1.log`（两段启动日志）。

## Doctor

```bash
node .agents/skills/verify/scripts/verify.mjs doctor
```

一条只读体检，8 项，逐条打印 `OK` / `FAIL`，任一失败 `exit 1`：state 存在、`out/web` 存在、
数据目录在本次 run 下、进程存活、`GET /api/health`、`GET /api/info` 的 `pid`+`dataDir` 与本实例一致
（端口没被别的进程占）、`/` 返回带 `<title>Workbench</title>` 的 HTML、飞书已停用。
任何地方看着不对，先跑它。

## Drive

```bash
node .agents/skills/verify/scripts/verify.mjs drive <script.mjs> [--headed]
node .agents/skills/verify/scripts/verify.mjs query tasks.byProject --params '{"projectId":"..."}'
node .agents/skills/verify/scripts/verify.mjs sql "SELECT title, current_stage_id FROM tasks"
```

`drive` 用仓库自带的 Playwright Chromium（`@playwright/test`）打开 `state.url`，再把 ctx 交给脚本：

| ctx 字段 | 含义 |
| --- | --- |
| `page` | 已 `goto(state.url)` 的页面（1280×800） |
| `browser` / `url` / `state` | 浏览器、本实例地址、完整 state |
| `artifacts` / `runDir` | 证据目录、run 目录 |
| `shot(name)` | 整页截图到 `artifacts/<name>.png`，返回路径 |
| `api.query(view, params)` / `api.dispatch(command)` | 走 `/api/query`、`/api/dispatch`（`ok:false` 直接抛错） |
| `sql(text, params)` | 只读查本次实例的 SQLite（只放行 `SELECT` / `WITH` / `PRAGMA`） |

脚本写法：`export default async function (ctx) { ... return 可 JSON 化的小结 }`。一次失败不会留在半路——
`drive` 总会关浏览器；页面 `console.error` / `pageerror` 会打印出来，别当噪声。
可运行的样板：`scripts/example-drive.mjs`（看板 → 新建任务 → 查库复查）。

## Evidence

证据落在 `.scratch/verify/<run>/artifacts/`，`stop` 不删。一次合格的取证包含三件事：

1. **动作**：真的走用户路径——点按钮、填表单、`locator.dragTo()` 拖卡；不用内部 setter 或测试专用接口。
2. **结果状态**：动作之后的界面（截图）**加**副作用（`sql` 查库行 / `api.query` 读视图 / 文件）。
   只截最后一张图不算证据；先截「点开的弹窗」，再截「创建后的看板」。
3. **可复查定位**：截图文件名带 feature id；返回的 summary 里带主键（标题、任务 id、阶段名）。

界面证据建议同时存一份 ARIA 快照：`await page.locator('body').ariaSnapshot()` 写进 `artifacts/*.aria.txt`。
对照功能地图的每个入口都走一遍，只走一个入口不算验完。

## Cleanup

```bash
node .agents/skills/verify/scripts/verify.mjs stop            # 按 state.pid 停自己起的进程，保留 data/ 与 artifacts/
node .agents/skills/verify/scripts/verify.mjs stop --purge    # 再删 data/（证据仍保留）
```

只按 `state.json` 里的 pid 停，绝不按进程名杀（本机还有别的 node）。重跑前先 `stop`；同一个 `--run`
已有存活实例时 `launch` 会直接拒绝，换 `--run` 或先停。

## Helpers

- `scripts/verify.mjs` — 上表全部子命令（`launch` / `doctor` / `status` / `query` / `sql` / `drive` / `stop`）。
- `scripts/example-drive.mjs` — 可直接跑的示例 journey。
- `scripts/journeys/*.mjs` — 功能地图五个功能的逐条 journey（`kanban` / `new-task` / `projects` /
  `settings` / `settings-panels` / `workflow-editor`），一次一个功能；每条都按 `<feature>.md` 的
  bullet 顺序走，结果是一份 `{ feature, steps[] }`（`ok` + `detail` 各自独立，不因一条失败而跳过）。

## 特性地图

`features/README.md` 是这份验证的维护源：基线前置、取证口径、5 个功能（看板 / 新建任务 / 项目 / 设置·服务 / 工作流编辑器）。
改完代码先读对应 feature 文件，再决定这次要跑哪几条 journey。

## Gotchas

- `launch` 报「已有实例在跑」= 上次没 `stop`；`doctor` 报 pid 不符 = 端口被别人占了。
- Windows 上 `stop` 最终落到 `taskkill /T /F`（外部进程收不到可优雅处理的 SIGTERM）；SQLite WAL 保证强杀不坏库。
- `server-phase1.log` 里的 `[secure-dir] icacls ENOENT` 是阶段一空 PATH 的副作用，不是故障。
- 新建任务弹窗的起始阶段默认是工作流**首阶段**（内置「待办」），不是看板当前列。
- 详情页先渲染「读取任务中…」：等 `section[aria-label="任务详情"]` 里的标题出现再截图，否则截到空壳。
- 看板只显示**当前工作流**的任务；卡片拖到「归档区」是 `task.archive`（可逆、不是完成）。
- SOP 模板的阶段是「智能体」类型，没给每个阶段选智能体时保存被拒——种子/无人值守场景走「从空白创建」。
