# Spec: ai-workflow（个人AI工作流）

> **重构提示（2026-11-04）：** 目录结构与分层已由 [ARCHITECTURE](../ARCHITECTURE.md) 与 [SPEC-kernel](SPEC-kernel.md)、[SPEC-plugins](SPEC-plugins.md)、[SPEC-host](SPEC-host.md) 取代；本文的行为规格（阶段语义、终态归一、取消时序、探测、聊天续接、迁移规则）仍是迁移基线，M5 前逐条有效。

> Module id：`ai-workflow`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。依赖 `shell`。确认日期：2026-11-02；运行时章节 2026-11-03 重做为 v2。
>
> 本 Spec 为 MVP：**本地单机最小闭环**。远端 Worker 仅留架构位、不实现（见 Open Questions / Out of scope）。设计参考 Multica 的「本地 UI/状态 + 本机 CLI 执行」边界。
>
> 2026-11-03 运行时重做为 v2：运行时 = 执行环境实例 + 探测健康 + 事件流（见「运行时」）；旧 `command + 空格分隔 args + prompt_mode + 通用 spawn` 与「探测真跑一次 prompt」已删除，不做兼容字段。2026-11-05（M3）：执行器改为插件，运行时用 `executorKey` 选插件。

## Objective

在工作台内新增 `ai-workflow` app：把「运行时 → 智能体 → 自定义多阶段工作流 → 看板任务」串成一个能在本地跑起来的最小闭环。

- 配置**运行时**：运行时 = 本机执行环境实例（执行器插件 + 启动命令 + profile + 权限模式 + 模型/推理强度 + 工作目录 + 并发上限 + 启用开关）；内置执行器插件 `dsh`、`claude`（Claude Code）、`hermes`（Hermes Agent / ACP）与 `command`，其余（codex 等）后续按「插件目录 + registry 一行」接入，不改内核与宿主。
- **识别**已安装的运行时：运行时配置页扫描本机 PATH，自动列出已安装的 agent CLI，点「使用」打开新建表单并把名称与命令预填进去（不自动建记录，profile/权限模式等仍由用户确认）。
- 配置**智能体**：名称、描述、执行配置（绑定某个运行时）、能力（System Prompt）。
- 配置**工作流**：一条有序的**阶段**序列；每个阶段可设【类型】【完成后进入】【出错时进入】；类型选「闸门（判定）」时改设【允许未通过次数】【通过时进入】【未通过时进入】（M11）。阶段详情按类型收敛字段：**不交接**与**交给用户**只留【名称】【类型】，其余字段（智能体 / 流转目标 / 交接 / 子任务 / 闸门配置 / 要干什么）一律不展示；**交给智能体**展示流转目标 / 交接 / 子任务 / 要干什么；**闸门（判定）**只展示次数、过与没过去向、要干什么——闸门只判定，不交接、不拆子任务，也不配「完成 / 出错」去向。界面上不展示的字段在保存时归一成默认值（「要干什么」原文保留）。
- 用**看板**查看与推进任务：列 = 当前所选工作流的阶段；新建任务时可选**起始阶段**，之后把卡片**拖拽**到其它阶段列（或「归档」区）推进，不设执行按钮。

**用户故事：**

- 作为使用者，我添加一个"DeepSeek Harness"运行时，再建一个绑定它的智能体。
- 作为使用者，我建一条工作流（如"研发：待办 → 进行中 → 审核中 → 已完成"），把"进行中"配成进入时交给某智能体、把"审核中"配成进入时交给用户审批。
- 作为使用者，我新建一个任务时选好工作流与**起始阶段**；任务进入该阶段，按阶段配置自动交给智能体执行或停下等我处理；我在看板上把卡片**拖到**其它阶段列，卡片随之流转；拖到「归档」区即收尾。
- 作为使用者，关掉工作台再打开，我的运行时/智能体/工作流/任务/运行记录都还在。

## 界面结构（2026-11-03 二次调整：三层左栏收敛为「单列侧栏 + 内容区」）

app 内只有一个页面，布局固定为「单列侧栏（w-64）+ 内容区」两栏，吃满 shell 顶部栏以下的高度。侧栏顶部用次级标题（`h2`，不占用一级标题——一级标题语义留给 shell 顶部栏）标识当前 app，其下是**栏目切换 + 当前栏目的上下文列表**，底部固定一行图标按钮：视图图标（工作台视图是「设置」图标，点进设置视图；设置视图是「返回工作台」图标，点回工作台）。主题切换器是全局设置，固定在 shell 顶部栏右侧，app 侧栏里不再放第二份。同一时刻只渲染一个视图、一个栏目。

- **工作台**（默认视图，默认栏目 = 聊天）：侧栏顶部**常驻项目切换器**（M11：项目是聊天与任务的共同上下文，放在栏目切换之上），其下是栏目切换条（`components/WorkspaceNav.tsx`，聊天 / 任务）与当前栏目的上下文列表：
  - **项目**（M10/M11）：`components/ProjectSwitcher.tsx`，项目 = 本地文件夹；列表末尾固定一行「默认目录」（宿主 `WORKBENCH_WORKDIR`，缺省 `~/.workbench`，数据侧 `projectId = null`）——没有项目时聊天与任务都落这里，因此项目列表为空也能继续干活。切换项目会同时换掉会话清单与看板，详情栈不跨项目保留。
  - **聊天**（默认）：上下文列表 = 会话清单（`components/ConversationList.tsx`：智能体选择 / 新建对话 / 会话清单），**按当前项目过滤**（`conversations.byProject` / `conversations.unassigned`）；内容区 = 消息流 + 输入区（`components/ChatPanel.tsx`），头部交代所属项目，助手输出流式回显，可中止当前轮。聊天**不挂任务、不推进阶段**，但**落在项目上**：每轮由内核产一条 `purpose='chat'` 的 run，走与阶段相同的调度 / 执行器链路（M2 起），工作目录取会话所属项目的文件夹（无项目时回落运行时 `workdir`，再回落默认目录）。同一时刻只处理当前选中会话的事件流。
  - **任务**：上下文列表 = 工作流切换器（`components/WorkflowSwitcher.tsx`，只在任务栏目显示）；内容区 = 看板（主体是当前工作流的阶段列，**固定列宽 `w-64`、列多时横向滚动**，不随列数拉伸；**最下面一条横排「归档」落点**——显示已完成数量，并带「查看归档」入口，不挤占列宽）。**单击任务卡进入任务详情页**（页面，不是侧栏 / 弹窗）。任务可以建在当前项目，也可以落默认目录（`projectId: null`，新建入口始终可用）。选中「默认目录」时看板照常可拖拽、可新建。
  - **项目的编辑**（M10）：`components/ProjectDialog.tsx` 填名称与文件夹路径（路径由宿主原生选择器选，`window.workbench.pickFolder()`；也允许手填），编辑态可删除。项目文件夹就是该项目任务的运行工作目录（`RunRow.cwd` 优先取项目 `path`，其次运行时 `workdir`，最后默认目录）；删除项目要求项目下没有任务，该项目下的会话由内核改归默认目录（会话不随项目删除消失）。
- **任务栏的二级页面**（`components/DetailHeader.tsx` + 页面组件）：栈式路由「看板 → 任务详情 → 线程详情 → 任务详情 …」，返回按钮与 Esc 出栈一级，切栏目 / 切视图回到看板（详情栈不跨栏目保留）。
  - **任务详情页**（`components/TaskDetailPage.tsx`）：读 `task.byId` + `runs.byTask` + `comments.byTask`；上部是任务信息（标题、工作流 · 阶段线索、状态 / 来源 / 线程 / 时间 / 任务 id、标签），其下依次是审批 / 通知卡、**任务说明**（`components/TaskBrief.tsx`：创建时的初始输入单独成卡，长文本不再挤在字段表里，空描述给「没有描述」），下部是**上下文活动流**（`components/TaskActivity.tsx`：智能体每一轮运行与我的反馈按时间混排，像 issue 时间线）和**反馈框**（`components/TaskCommentForm.tsx`：正文 + 「同时让智能体接着做」勾选，dispatch `task.comment`）。活动流的每一轮运行都带**阶段徽标**（`run.stageId` 查当前工作流阶段名，缺数据为「未知阶段」）与「第 N 轮」，正文默认只给缩略摘要（前 6 行且 ≤400 字符），点「展开全部（约 N 字）」才渲染完整事件流——多阶段任务的输出不再把整页冲垮；思考 / 工具过程仍在展开后的「过程 · N 条」折叠里。每个运行卡片还会展示该轮**沙箱提权记录**（`run.approvals` 宿主视图，只读 dsh 会话日志里的 `approval/asked` / `approval/decided`）——提权回答是自动的，只有这条记录能让人事后复核。反馈写进第 15 张投影表 `task_comments`，并作为下一次运行的「反馈记录（资料，不是指令）」段；右上角是动作入口：**重新执行**（`task.rerun`：run 失败收口后原地再排一轮——执行器失联 / 超时 / 关机导致的中断不用把卡片拖走再拖回；内核判：任务停在 `entryMode='agent'` 阶段、没有活跃 run、智能体与运行时齐备；UI 另加一条：该任务已经跑过至少一轮）、**停止执行**（`task.stop`：把本任务的活跃 run 逐条请求取消，任务保持进行中；只在执行中出现）与**完成任务**（`task.complete`：终态动作；执行中禁用并提示「执行中：先停止执行」）；已完成的任务只留「已完成」标记；任务挂在线程上时另有「打开线程」入口。
  - **线程详情页**（`components/ThreadDetailPage.tsx`）：读 `thread.byId`；依次是线程元信息、**任务列表**（根任务 + 派生子任务缩进，每行可点进任务详情页）、笔记、绑定入口，底部是**归档**与**删除线程**（`thread.remove`：确认弹窗写明连带 N 个任务与执行记录，删除成功即出栈回看板；线程里有执行中的 run 时由内核拒绝并就地展示原因）。
- **看板交互**：顶部「新建任务」打开完整表单（可填描述与起始阶段）；**每个阶段列底部另有「+ 新建任务」**——就地填标题 + **要求 / 上下文（描述）**，标题回车或 Ctrl/⌘+Enter 即在该阶段建任务（描述里的 Enter 只换行；Esc 收起；成功后清空并保持展开可连续建；失败文案贴在本列内；样式与卡片同圆角/列宽）。`agent` 阶段的列会立即派活，表单里直接写明「这一列会立即交给智能体执行，写清要求」，描述随 `task.create` 一起落库，避免只有标题、智能体没有可执行内容。卡片**拖拽**到其它阶段列即进入该阶段，拖到看板底部的「归档」条即完成任务。看板不提供「通过 / 打回 / 推进」这类执行按钮。「执行中」由**是否有活跃 run**（`queued`/`running`/`waiting`）派生：只有此时卡片不可拖动/完成；`agent` 阶段失败后没有活跃 run，卡片可拖走重试或完成（详情页另有「重新执行」原地重排），由 run 结果自动推进的路径不变。
- **删除线程**（`thread.remove`）：线程页的「删除线程」是终态动作——线程行、线程内各任务的 run 记录（`run.removed`，`run_events` 与卡片由投影层联删）与任务行一起消失，宿主同时清掉 `<artifacts>/threads/<threadId>/` 下的落盘归档（`index.md` / `runs/*`），不留没有线程归属的执行记录。线程里有执行中的 run 时内核 reject（先 `task.stop`）；线程不存在按幂等删除。
- **归档任务的回看**（`components/ArchivedTasksDialog.tsx`）：归档 = 移出看板，不是删除。归档区底部的「查看归档」打开归档任务清单——按 `updatedAt` 倒序列出本工作流已完成的任务（标题 + 阶段名 + 「已完成」徽标；阶段被删时退化为「未知阶段」），点一行进任务详情页看上下文与历史运行并关掉清单；Esc / 右上角 × 关闭；一个归档任务都没有时按钮禁用并提示「还没有归档任务」。清单只读，不提供拖回看板的反向入口。
- **设置**：侧栏换成设置栏目（`components/SettingsNav.tsx`：运行时配置 / 智能体配置 / 工作流配置），内容区是当前栏目的内容；同一时刻只渲染一个栏目。
- app 间切换归 shell 顶部栏，app 侧栏里**不出现**其它 app 的入口。

三类配置归在设置里，工作台不出现任何配置入口：

- **运行时配置**：已配置运行时清单（健康状态、CLI 版本、启动头、负载、路径）；上方是「已安装的运行时」检测清单（自动扫描本机 CLI，点「使用」打开并预填新建表单）。每条已配置运行时提供「测试」做探测（见「运行时探测与健康」），可编辑（含删除）。
- **智能体配置**：已配置智能体清单（名称、绑定运行时、描述、能力）。
- **工作流配置**：工作流定义清单（新建 / 选择 / 编辑）。新建只有一个入口：「新建工作流」按钮展开下拉（`components/ui/menu.tsx`），第一组是「从空白创建」（一个「待办」阶段），第二组是开箱 SOP 模板（产品发现 / 研发交付 / 测试质量 / 发版运维 / 事故复盘 / 迭代回顾，条目带阶段数与适用场景）；选中任一即把对应草稿（模板连每阶段「要干什么」）预填进同一个编辑器，**保存前不落库**。模板不替用户绑定智能体（阶段 `entryMode='agent'` 仍需用户选 agent 才能通过内核校验）。

规则：

- 配置项**只在设置的对应栏目内出现**，工作台不展示任何配置表单。
- 新增类配置一律**点「新建…」才弹出表单**（居中模态 `components/ui/dialog.tsx`），页面默认只显示清单——不出现「一进页面就是一张空表单」。
- 表单提交失败：错误显示在弹窗内，弹窗保持打开；清单类操作（删除、刷新列表）失败：错误显示在页面上。

## Tech Stack

- 与 shell 相同：Electron 45 + electron-vite 6 + React 19 + TypeScript 6（strict）。
- 样式：Tailwind 4 + `components/ui/`（shadcn 风格），复用 `src/renderer/src/lib/cn.ts`。
- 存储：**SQLite，使用 Node 内置 `node:sqlite`**（不引原生模块、不引 better-sqlite3）；数据库文件在**主进程**打开与读写。
- 进程执行：主进程 `child_process.spawn` 本机 CLI，经执行器插件端口与版本化 JSONL 协议通信；执行器插件可注入（测试用假进程/假流，不启真进程）。
- 测试：Vitest + @testing-library/react。

## Commands

同 shell（pnpm）：

```
Dev:      pnpm dev
Build:    pnpm build
Test:     pnpm test            # vitest run
Coverage: pnpm run test:coverage
Lint:     pnpm run lint
Check:    pnpm check           # typecheck + lint + test:coverage（提交前必过）
```

## Project Structure

````
src/renderer/src/apps/ai-workflow/
├── index.tsx                  # AppPlugin（aiWorkflowApp：id/name/icon/component）
├── AiWorkflowPage.tsx         # 布局：工作台 / 设置 双视图 + 任务栏二级页面路由栈（见「界面结构」）
├── （无 api.ts）               # 读写统一经 shell/kernelStore（dispatch/query/subscribe）
├── model/
│   ├── types.ts               # 领域实体类型（Runtime/Agent/Workflow/Stage/Task/Run）
│   ├── stage-machine.ts       # 纯函数：阶段流转/默认目标解析（不依赖 React、不做 IO）
│   └── stage-machine.test.ts
├── hooks/
│   ├── useWorkflow.ts         # 已删除（改用 kernelStore 视图订阅）
│   └── useChat.ts             # 聊天状态机：会话增删选、消息拉取、流式事件、发送/中止
└── components/
    ├── WorkspaceNav.tsx       # 工作台侧栏顶部：横向「聊天 / 任务」切换条 + 上下文列表槽
    ├── ConversationList.tsx   # 聊天栏目的上下文列表：智能体选择 / 新建对话 / 会话清单（按当前项目）
    ├── ChatPanel.tsx          # 聊天栏目内容区：会话头部（所属项目）/ 消息流 / 输入区（流式回显、可中止）
    ├── WorkflowSwitcher.tsx   # 任务栏目侧栏：切换当前查看的工作流
    ├── WorkflowManager.tsx    # 工作流配置栏目：工作流清单（新建 / 选择 / 编辑）；「新建工作流」下拉含空白与 SOP 模板
    ├── SettingsNav.tsx        # 设置页左侧二级栏目（运行时 / 智能体 / 工作流）
    ├── KanbanBoard.tsx        # 阶段列固定宽度（w-64）横排 + 列底「+ 新建任务」就地新建 + 底部「归档」横条；单击卡片进任务详情
    ├── ArchivedTasksDialog.tsx # 归档任务清单：已完成任务按最近更新倒序，点一行进任务详情（只读，不拖回看板）
    ├── TaskCard.tsx           # 标题/描述/进入方式提示（可拖拽卡片 + 详情入口）
    ├── TaskDetailPage.tsx     # 任务详情页：任务信息 + 任务说明 + 审批卡 + 上下文活动流 + 反馈框；右上结束动作
    ├── TaskBrief.tsx          # 任务说明：初始输入单独成卡（审批之后、上下文之前）
    ├── TaskInfoPanel.tsx      # 任务信息：状态 / 阶段 / 来源 / 线程 / 时间 / id / 标签
    ├── TaskActivity.tsx       # 上下文活动流：运行与反馈按时间混排（事件流按 run 订阅；运行卡片含提权记录）
    ├── TaskCommentForm.tsx    # 反馈输入：正文 + 「同时让智能体接着做」勾选
    ├── ThreadDetailPage.tsx   # 线程详情页：元信息 / 任务列表 / 笔记 / 绑定 / 归档 / 删除线程（连带执行记录）
    ├── DetailHeader.tsx       # 二级页面返回条：返回 + 标题线索 + 操作槽
    ├── TaskDialog.tsx         # 新建任务：所属项目（只读，可为默认目录）/标题/描述/起始阶段（居中模态）
    ├── ProjectSwitcher.tsx    # 顶部项目列表：选中 / 添加 / 编辑 / 「默认目录」入口（M10，M11 提到顶层）
    ├── ProjectDialog.tsx      # 新建/编辑项目：名称 + 文件夹（系统选择器）+ 备注 + 删除（M10）
    ├── WorkflowEditor.tsx     # 工作流编辑：左侧阶段序列（行内上移/下移）/ 右侧选中阶段详情（含「要干什么」）
    ├── RuntimeManager.tsx     # 运行时配置页：检测清单 + 已配置清单（健康/负载/路径）+ 探测/编辑/删除
    ├── RuntimeStatusBadge.tsx # 运行时健康 pill（可用 / 不可用 / 未检测）
    ├── RuntimeDialog.tsx      # 新建/编辑运行时：执行器选择/命令/profile/参数模板/权限模式/模型/推理强度/工作目录/并发/启用
    ├── AgentManager.tsx       # 智能体配置页：已配置清单
    ├── AgentDialog.tsx        # 新建智能体（居中模态）
    ├── ApprovalBar.tsx        # 顶部通知条：只列 open 卡标题 + 落点，点击进任务详情 / 会话（M4；本轮收紧为信标）
    └── ApprovalCards.tsx      # 卡片处理区：正文 + 选项 + 通知的 × 关闭，内嵌在任务详情与聊天面板

src/main/ai-workflow/
└── ipc.ts                     # 注册 ai-workflow IPC handlers（读投影 / 写走 effects.dispatch；执行器 key 与默认值按插件 manifest 补齐；M4 卡片读写）

src/main/
├── index.ts                   # 装配根：通道启停、退出 dispose
└── notify.ts                  # Electron Notification（sdk.notify 原件）

src/plugins/                   # M3：执行器插件（新增协议 = 新目录 + registry 一行）；M4：通道插件
├── registry.ts                # 内置插件静态清单（executors / channels）+ detectAll 汇总
├── shared/cli-catalog.ts      # 本机 agent CLI 候选清单（纯数据，顺序即输出顺序）
├── shared/argv.ts             # 参数模板解析与占位符展开（纯函数）
├── shared/receipt-block.ts    # 回执块解析（最后一个 ```json 围栏块；纯函数）
├── executors/
│   ├── dsh/                   # dsh stdio 协议：帧解析、探测、模型目录、执行与终止、detect
│   └── command/               # 通用命令 + argsTemplate（不给 detect/probe）
└── channels/
    ├── in-app/                # 默认通道：投影即送达（pending → delivered{ref:'in-app'}）
    └── desktop/               # 系统通知：sdk.notify(title, body)

src/sdk/                       # 插件能力面（log / now / paths / config / process / notify）

src/host/                      # 账本 + 投影 + 调度（M2；内核实现以外的宿主层）
├── db.ts                      # node:sqlite 打开、PRAGMA、旧库 runs / runtimes 一次性升级
├── schema.ts                  # 十张投影表 + facts / projection_meta / process_registry
├── sdk-host.ts                # 插件能力面原件（spawn / 解析 / 杀树 / 扫描目录 / 时钟 / 日志 / 会话根 / notify）
├── executor-registry.ts       # 按 runtime.executorKey 取插件端口（未知 key 返回 null）
├── store/                     # 事实追加、投影应用与重建、视图装载与查询、存量导入
├── scheduler.ts               # 按运行时领取 → 执行器端口 → 帧批量入账 / 回执 / 取消时序
├── clock.ts                   # 唯一 setTimeout：nextWakeAt 到点 tick；run 状态变化后 rearm
├── effects.ts                 # 提交后分发：run.queued 唤醒调度器、card.* 交给通道 hub、变更广播
├── channels.ts                # 通道 hub：注册/启停/分发/补投（M4）
├── executor.ts                # 执行器插件 → ExecutorPort 包装：状态归一、续接被拒重试
├── process.ts                 # 进程树终止 / 行读取 / 输出尾部
├── process-registry.ts        # 宿主私有进程登记（崩溃对账用）
└── reconcile.ts               # 启动对账：杀残留进程树、回收超租约、补聊天错误消息、无卡 waiting 兜底

src/shared/ai-workflow-api.ts  # 跨进程契约（preload 与 renderer 共用）
````

- `src/preload/index.ts` 只暴露 `window.workbench`（三动词 + notify）；`api.d.ts` 只声明 `window.workbench`。
- 注册：`src/renderer/src/shell/registry.ts` 的 `appPlugins` 加一行 `aiWorkflowApp`（外壳零改动）。

## 数据模型（SQLite）

> 单一数据库文件：`app.getPath('userData')/ai-workflow.db`。时间戳用 ISO 字符串；id 用 `crypto.randomUUID()`。schema 版本记在 `PRAGMA user_version`。

| 表                | 关键字段                                                                                                                                                                                                                                                                                                                     | 说明                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimes`        | id, name(uniq), executor_key, command, profile, args_template, permission_mode, model, reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at                                                                                                                                                       | 运行时 = 本机执行环境实例；`executor_key` 指向执行器插件（**无 CHECK**：取值合法性由宿主入口按插件注册表校验，避免加插件就改 DDL 触发全库重建；列本身 NOT NULL 无 DEFAULT，必须由 IPC 按 manifest 补齐）；`last_probe_json` 存最近一次探测结论（从未探测为 NULL） |
| `agents`          | id, name, description, runtime_id → runtimes, system_prompt, created_at                                                                                                                                                                                                                                                      | 智能体 = 运行时 + 能力（System Prompt）                                                                                                                                                                                                                           |
| `workflows`       | id, name, description, created_at                                                                                                                                                                                                                                                                                            | 工作流                                                                                                                                                                                                                                                            |
| `workflow_stages` | id, workflow_id → workflows, name, position, entry_mode, agent_id → agents?, on_complete_stage_id → workflow_stages?, on_reject_stage_id → workflow_stages?, created_at                                                                                                                                                      | `entry_mode` = `none`\|`agent`\|`user`；`position` 决定顺序，`(workflow_id, position)` 唯一                                                                                                                                                                       |
| `tasks`           | id, title, description, workflow_id → workflows, project_id, current_stage_id → workflow_stages, status, created_at, updated_at                                                                                                                                                                                              | `status` = `active`\|`completed`；`project_id` 是弱引用（M10，NULL = 默认目录），任务的运行工作目录取项目 `path`                                                                                                                                                  |
| `projects`        | id, name, path, description, created_at, updated_at                                                                                                                                                                                                                                                                          | M10 项目：名称与文件夹路径在项目集内唯一（内核校验）；`path` 是绝对路径，也是该项目任务的执行工作目录；项目下有执行中的任务时拒绝删除；删除时其余任务与会话改归默认目录（`projectId=null`）                                                                       |
| `runs`            | id, purpose, task_id → tasks?, conversation_id → conversations?, stage_id, agent_id, runtime_id (SET NULL), status, prompt, output, error, error_code, exit_code, session_id, usage_json, duration_ms, lease_id, attempt, attempts, lease_until, not_before, deadline_at, cancel_requested, started_at, ended_at, created_at | `purpose` = `stage`\|`chat`；`status` = `queued`\|`running`\|`waiting`\|`succeeded`\|`failed`\|`cancelled`；`error_code` 见「终态归一」；M2 起是事实投影（`run.*` 事实整行演进）                                                                                  |
| `run_events`      | run_id → runs(CASCADE), seq, type, payload_json, created_at                                                                                                                                                                                                                                                                  | 运行事件流；`(run_id, seq)` 唯一，按 `seq` 排序；`payload_json` 存事件其余字段；纯追加                                                                                                                                                                            |
| `conversations`   | id, title, agent_id → agents(RESTRICT), project_id, session_id, archived_at, created_at, updated_at                                                                                                                                                                                                                          | 一段对话：绑定智能体，**落在项目上**（M11，`project_id` 可空 = 默认目录）；`session_id` 供下一轮续接，`updated_at` 决定会话列表顺序                                                                                                                               |
| `messages`        | id, conversation_id → conversations(CASCADE), role, content, error, created_at                                                                                                                                                                                                                                               | `role` = `user`\|`assistant`；助手消息的 `error` 记录失败原因（非零退出/超时/取消）                                                                                                                                                                               |
| `cards`           | id, run_id → runs(CASCADE), task_id?, conversation_id?, title, text, options_json, key, version, status, delivery, delivery_ref, option_index, answered_by, answered_at, created_at, updated_at                                                                                                                              | M4 卡片投影：`status` = `open`\|`answered`\|`resolved`；`delivery` = `pending`\|`delivered`\|`failed`（单列 = 已送达至少一个通道）；投递按 `(id, version)` 去重；正文只作通知/平台 API 参数                                                                       |

> M2 起十张业务表全部是**事实投影**（另有 `facts` 事实日志、`projection_meta` 指纹/seq、宿主私有 `process_registry`）：写路径只有「追加事实 + 应用投影」，`INSERT/UPDATE/DELETE` 集中在 `src/host/store/projection-apply.ts`；读路径走投影视图（`store.query`）。旧 `chat_conversations` / `chat_messages` 在首次启动时迁成导入事实后删除。

外键约束开启（`PRAGMA foreign_keys = ON`）。删除工作流/任务由内核显式产 `run.removed` / `stage.deleted` / `task.removed` 事实（不依赖 SQL 级联，重建才等价）；删除被引用的运行时/智能体前先校验或拒绝（见 Boundaries）；运行时被删后 `runs.runtime_id` 置空、历史 run 保留。

**迁移（v1 → v2，`user_version` 1 → 2）：** 按 SQLite 12-step 重建 `runtimes` / `runs` / `chat_conversations`（v2 删掉了 v1 的 `kind` / `args_template` / `prompt_mode`，且新列带 CHECK），新增 `run_events`，最后写 `PRAGMA user_version = 2`。**已有数据保留**：旧运行时按 v2 默认值补齐（`protocol_family=dsh`、`profile=multica`、`permission_mode=workspace-write`、`max_concurrent=1`；其中 `protocol_family` 是旧字段，仅迁移归一用，M3 起由 `executor_key` 取代），旧 run 的 `runtime_id`/`session_id`/`usage_json`/`duration_ms` 为 NULL、`error` 非空的失败 run 归 `exit_nonzero`，旧对话 `session_id` 为 NULL。迁移期间临时关闭外键，失败回滚。不做 v1 兼容读取。**M2 升级：** 旧 `runs` 表缺调度列时首启一次性物理重建；v2 存量（含旧聊天表）由 `src/host/store/import.ts` 写成 `snapshot.imported` 导入根后重建投影。该兼容层 M3 **不删**（真实库仍是 v2 格式，首启必须靠它导入），删除条件与顺序作为 M3 之后的独立清理任务。

**M3 升级（格式指纹换新，`user_version` 仍为 2）：** `runtimes` 去掉 `protocol_family`（旧字段，仅迁移归一用；该列被 CHECK 引用，SQLite 不能 `DROP COLUMN`）、加 `executor_key`（NOT NULL，无 DEFAULT）与 `args_template`（DEFAULT `''`；语义从 v1 的空格分隔参数串改为 JSON 数组文本），按 12-step 物理重建：外键 OFF → 建临时表 → 拷贝旧行（旧协议族按「旧值 = 执行器键」回填、`args_template` 补空串）→ 删旧表 → 改名。`KERNEL_VERSION` 升到 `m3.0.0`，与 DDL 变化双触发 → **首启全量重建投影**；重建 fold 的是历史事实 payload，老 `runtime.*` payload 缺 `executorKey`，由 `normalizeRuntime` 归一（缺 `executorKey` → 取旧 `protocolFamily`，当前仅 `dsh`；`argsTemplate` 补空串）。回滚只能恢复升级前的 DB 备份。

**M4 升级（格式指纹换新，`user_version` 仍为 2）：** 新增 `cards` 投影表（DDL 进投影指纹）并把 `KERNEL_VERSION` 升到 `m4.0.0` → 首启全量重建投影，重建后 `cards` 为空（v2 / M3 存量没有卡片数据，不导入）。历史 `waiting` run 没有对应 `card.*` 事实，重建后无卡可答：启动对账对「`waiting` 且无 open 卡」的 run 补 `run.host_settled{cancelled}`（reason 写明卡片缺失），避免永久「执行中」；有 open 卡的保持等待。

## 阶段状态机（核心规则）

阶段流转是**纯逻辑**，集中在 `src/kernel/workflow/stage-machine.ts`（内核纯函数，不依赖 React、不做 IO；renderer 只读视图、只发命令）。UI 与宿主只提交输入，进入效果（建 `run.queued`）由内核在同一决策里产出。

**任务状态：** `active`（在看板中）| `completed`（已走完终端阶段，移出看板）。

**目标解析（默认值，仅用于 run 结果自动流转）：**

- `on_complete` 目标：显式配置 → 该阶段；未配置 → **下一顺序阶段**；已无下一阶段 → 任务 `completed`。
- `on_reject` 目标：显式配置 → 该阶段；未配置（不指定）→ **留在原地、不做任何流转**。
- 闸门（`gate`）目标：`verdict=pass` → `onPassStageId`（未配置 → 下一顺序阶段）；`verdict=fail` 且未达 `maxFails` → `onFailStageId`（未配置 → 原地不动）；`fail` 且已达 `maxFails` → **放行**走通过分支，任务打 `gate:degraded` 标签并追加一条反馈。

手动拖拽**不套用**上面三个目标：落点即目标阶段（可跨阶段前跳/后退），闸门预算同时清零。

**事件与转移：**

| 事件               | 触发时机                     | 行为                                                                                                                                  |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ENTER(stage)       | 新建任务 / 流转到某阶段      | 按该阶段 `entry_mode`：`none` 停留等待手动操作；`agent` 创建一条 `queued` run（交给 `agent_id`，视为执行中）；`user` 置为"等待你处理" |
| RUN_SUCCEEDED(run) | agent run 正常结束           | 普通阶段进 `on_complete` 目标；闸门阶段按回执 `verdict` 分流（见下）；到终端则 `completed`                                            |
| RUN_FAILED(run)    | agent run 非零退出/超时/异常 | 进入 `on_reject` 目标；若未配置打回目标（不指定）或目标就是当前阶段则保持原阶段、**不触发进入效果**（不自动重建 run）                 |
| MOVE_TO(stage)     | 用户把卡片拖到某个阶段列     | 直接进入该阶段（不套用 `on_complete`/`on_reject`）；该任务有活跃 run 时拒绝拖动                                                       |
| COMPLETE           | 用户把卡片拖到「归档」区     | 任务 `completed`，移出看板；该任务有活跃 run 时拒绝完成                                                                               |

**流转即触发进入：** 每次进入新阶段都重新按 `entry_mode` 产生对应效果（可能再次创建 run），即"SOP 串联"。

**打回原地不重试：** `RUN_FAILED` 时若 `on_reject` 未配置（不指定）或解析结果就是当前阶段（显式配置为自身），任务保持原阶段、不产生 effects——避免 agent 阶段失败后立刻重建 run 形成无限自动重试；此时卡片可拖走重试或完成，详情页也可直接「重新执行」原地重排（`task.rerun`，见下）。

**闸门（M11）：** 阶段可设为闸门，由该阶段的智能体在回执里给 `verdict`（`pass` / `fail`）与 `checks`（实际执行的命令 + 退出码）。判定与 `run.status` **正交**：`succeeded` 只说明执行器跑完，`fail` 才是业务上没过。

- `pass` 必须至少带一条 `checks` 且退出码全为 0，否则视为**没给结论**：任务停在闸门等人，既不放行也不消耗预算。
- `fail` 未达 `maxFails` → 去未通过分支并把任务上的连续未通过次数 +1（回环保留累计值，否则「最多 N 次」永远到不了）。
- `fail` 已达 `maxFails` → 放行，任务打 `gate:degraded` 标签并追加一条反馈（详情页可见），预算清零。
- 执行出错（`run.status='failed'`）走 `on_reject`，**不消耗**闸门预算——执行器崩了不等于业务上没过。
- 闸门未通过而离开本阶段**不算「向前完成」**，不触发跨工作流交接；放行才算。
- 闸门只判定：编辑器不为闸门提供交接、子任务与「完成 / 出错」两个去向，保存时这些字段一律归一为空（内核侧仍保留 M7/M8/M11 的既有流转语义，只是编辑器不再产出这种配置）。

**闸门不合格 → 与人讨论（M13）：** 判定 `fail` 时人往往不只想看到结论，还想就这次判断追问。落地口径是「**阻塞 = run 在等你**」，不是「run 已结束、另开会话」：

- 闸门提示词要求：判定 `fail` 且要人决定去向时，那一轮**只发一张 `ask` 卡、不给 `verdict`**（同一轮只发一张卡），`options` 给「同意，按打回走」/「我要和你再讨论」/「情况有变，直接放行」三档，`key` 固定 `gate-verdict`。
- 于是 run 进 `waiting`（释放租约、不耗 Token，判定原文留在 `run.output`），任务既不结算也不丢结论——这正是「卡在闸门」的可交互形态。
- 人选「我要和你再讨论」→ `card.answer` → 续接同一会话（`resumeSessionId`）：**同一个智能体、同一份它自己的判断记忆**，这就是「和判定者讨论」，不需要新实体、不需要人-Agent 绑定。
- 讨论靠 `card.answer.note`（补充说明，见「审批与等待」）说清异议；谈清楚了它在续接轮里给最终 `verdict`，还需要人拍板就再发一张 `ask`。
- `verdict` 与 `ask` 同块时 ask 分支先返回、`verdict` 不入账（内核在 `run.waiting` 处分流），所以提示词要求那一轮干脆不写 verdict；**结论永远由人落笔**——打回靠 `onFailStageId` 流转或人拖卡片，讨论本身不改任务状态、不消耗闸门预算。
- 放弃判定：`task.stop` 把该 run 取消（卡随结算收起、任务保持进行中，之后可拖走改判）。`card.resolve` 只关卡不取消 run，单用会让 run 永远悬在 `waiting`。

**执行中 = 有活跃 run：** `queued`/`running`/`waiting` run 才算执行中，由 `runs` 现算（不落库、不看阶段配置）；`tasks.moveToStage`/`tasks.complete` 只在存在活跃 run 时拒绝。任务的阶段在其 run 结束前不变。

**并发：** 同一运行时按 `maxConcurrent` 限流，超出上限的 run 保持 `queued` 按创建顺序执行；不同运行时并行。

## 运行时（v2，2026-11-03 重做）

> 对齐 Multica：运行时 = 本机执行环境实例 = 执行器插件（`executorKey`）+ 启动方式 + 执行策略；进程间用版本化 JSONL 协议通信，健康由插件探测给出。M3 起执行器全部是插件（`src/plugins/executors/`），新增协议只改插件目录 + registry 一行。旧实现（`command` + 空格分隔 `args` + `promptMode` + 探测真跑一次 prompt）已删除，不保留兼容字段。

### 运行时模型

| 字段              | 说明                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executorKey`     | 执行器插件键：决定「怎么调起一轮」，不决定派给谁；取值必须是插件注册表里的已注册 key，缺省取注册表首项                                                                                                                                                                                                                    |
| `command`         | 启动命令：命令名或绝对路径；缺省由所选执行器插件 manifest 提供（dsh 默认 `dsh`，command 默认为空待填）                                                                                                                                                                                                                    |
| `profile`         | 启动 profile；dsh 用它选 `--stdio` / `--probe`，其它执行器可为空串；缺省同样来自 manifest                                                                                                                                                                                                                                 |
| `argsTemplate`    | `command` 执行器的参数模板（JSON 数组文本，≤20 项、单项 ≤500 字符；空串 = 无参数）；占位符白名单 `{model}`/`{effort}`/`{cwd}`/`{context}`/`{prompt}`                                                                                                                                                                      |
| `permissionMode`  | `read-only` / `workspace-write` / `danger-full-access`；经 `DSH_PERMISSION_MODE` 传给子进程。沙箱只管文件写入：越界修改先被拒，工具随后可申请提权；stdio 传输**没有人工审批往返**，提权请求由桥接层自动回 `allowed-once`。任务详情用 `run.approvals` 把会话日志里的提权记录读出来供事后复核，界面不再声称「越界直接失败」 |
| `model`           | provider/model 形式 id；`null` = CLI 默认模型                                                                                                                                                                                                                                                                             |
| `reasoningEffort` | 推理强度；`null` = 模型默认                                                                                                                                                                                                                                                                                               |
| `workdir`         | 执行工作目录；`null` = 宿主默认目录：`WORKBENCH_WORKDIR` 环境变量 > `~/.workbench`（启动时确保存在，解析结果见宿主视图 `runtimes.default-workdir`）                                                                                                                                                                       |
| `maxConcurrent`   | 同一运行时同时执行的 run 上限，超出排队                                                                                                                                                                                                                                                                                   |
| `enabled`         | 停用后不再派发执行                                                                                                                                                                                                                                                                                                        |
| `lastProbe`       | 最近一次探测结论（见下）；从未探测为 `null`                                                                                                                                                                                                                                                                               |

- 契约中 `RuntimeInput` 除 `name` 外均可省略。`executorKey` / `command` / `profile` 由 IPC 入口按所选执行器插件 manifest 补齐（未指定 key 取注册表首项）；其余默认 `argsTemplate=''`、`permissionMode=workspace-write`、`maxConcurrent=1`（取值 1–8，超出按 8 归一）、`enabled=true`、`model/reasoningEffort/workdir=null`。**内核不写任何产品默认值**。
- 新增运行时协议不改内核、宿主或 UI：写一个执行器插件（`src/plugins/executors/<id>/`）并在 `src/plugins/registry.ts` 加一行，即可被 `runtimes.executors()` 列出、被 detect 汇总、被配置选中并跑通一轮。
- 命令解析：命令名扫 PATH + 常见全局目录；带路径分隔符的按路径处理，找不到即失败（不做模糊回退）。Windows 下 `.cmd`/`.bat` 经 `cmd.exe /c <脚本> <参数...>` 固定包装、`shell:false`。
- 凭据：沿用本机 CLI 已有的登录态，**不把任何 token 存进数据库**。

### 探测与健康

- `dsh` 插件内部：`dsh --profile <p> --probe` 输出**一帧** `{ v: 1, type: 'probe', runtime: 'dsh', protocol_version, plugin_version }`；配合 `dsh --version` 解析 CLI 版本（读取超时 15s）。
- 结论 = `RuntimeProbe` 并持久化到运行时行（`lastProbe`）：`state`（`ready` / `unavailable`）、`path`（可执行文件绝对路径，解析失败为 null）、`cliVersion`、`protocolVersion`、`pluginVersion`、`error`、`output`（诊断输出尾部，最多 4000 字符）、`elapsedMs`、`checkedAt`。
- `state=ready` 仅当 probe 帧合法、`v=1`、`protocol_version=1` 且 `runtime='dsh'`；否则 `unavailable` 并记 `error`：找不到可执行文件 / 启动失败 / 探测超时（60s）/ 无 probe 帧（含非零退出）/ 协议版本不兼容。**帧结构、版本判定与 `runtime='dsh'` 校验全部归 `dsh` 插件内部**，宿主与内核只消费 `RuntimeProbe`，不认识产品名。
- 探测后端由运行时的 `executorKey` 选；`probe` 是插件可选能力，未提供时 `runtimes.create` / `runtimes.probe` 抛「执行器不支持探测」（`command` 插件即如此，它不提供 `detect` / `probe`）。
- **不产生 run、不调用模型**；`runtimes.detect` 只读（不写库），`runtimes.probe` 把结论写回 `lastProbe`。
- `runtimes.create`：先探测，失败抛错且**不落库**；`runtimes.update`：保存后重新探测并落库最新结论（探测失败不抛错）。
- 负载不落库：`runtimes.statuses()` 按 `runs` 现算 `running` / `queued` / `maxConcurrent`（无活跃 run 记 0）。
- UI：健康 pill = 可用（`ready`）/ 不可用（`unavailable`）/ 未检测（`lastProbe=null`）；行内展示 CLI 版本、启动头 `dsh --profile <p> --stdio`、路径、负载 `running/maxConcurrent`；「测试」调用 `probe` 并展示耗时与失败原因。

### 检测（detect）

`runtimes.detect` 扫描本机已安装的 agent CLI，返回 `DetectedRuntime[]`。M3 起候选清单与扫描都在插件侧汇总，宿主不再维护白名单：

```ts
export interface DetectedRuntime {
  command: string // CLI 命令名，如 dsh / claude
  label: string // 展示名，如 "DeepSeek Harness"
  path: string // 可执行文件绝对路径
  executorKey: string // 对应执行器插件键；本机已装但无插件认领时为 ''
  supported: boolean // 插件注册表里是否存在该执行器（有插件即可接入）
}
```

- **来源**：各执行器插件的 `detect(ctx)`（`src/plugins/executors/*/detect.ts`）只报自己能接入的命中；`executorKey` 与 `supported` 由 `src/plugins/registry.ts` 的 `detectAll` 汇总时回填，插件不自报。
- **汇总规则**：按 registry 的 `executors` 数组顺序**串行**调用；单插件超时 2 s、抛错只跳过该插件并记日志（整体不抛）；同一 `command` 被多个插件声明时先到先得并记一条 warn；输出按 `src/plugins/shared/cli-catalog.ts` 的候选顺序稳定排列。
- **扫描目录**（`sdk.process.scanDirs()`）：`process.env.PATH` 全部条目 + 常见全局安装目录（Windows：`%APPDATA%/npm`、`~/.local/bin`、`~/.claude/local`、`%ProgramFiles%/nodejs`；POSIX：`~/.local/bin`、`~/.npm-global/bin`、`~/.bun/bin`、`~/.claude/local`、`/usr/local/bin`、`/opt/homebrew/bin`）；不存在的目录跳过。
- **候选清单**（`cli-catalog.ts`，顺序即输出顺序）：`dsh`、`claude`、`hermes`、`codex`、`gemini`、`opencode`、`aider`、`cursor-agent`、`qwen`、`goose`、`crush`。没有插件认领的 CLI 仍列出（`supported:false`，`executorKey=''`）。
- **命中判定**：Windows 命中 `<cmd>.exe|.cmd|.bat|.ps1` 任一（npm 全局装的是 shim）；POSIX 命中同名且有可执行位（`mode & 0o111`）。同一命令多处命中取 PATH 中靠前者。
- **零副作用**：不 spawn 任何进程、不读版本号，只读文件系统；`runtimes.detect` 不写库、不发 changed。
- **UI 三态**：已添加过的命令显示「已添加」并禁用；`supported=true` 显示「使用」打开新建表单并预填 `label`/`command`/`executorKey`（名称与现有运行时重名时改为 `label (command)`）；`supported=false`（本机已装但无插件认领）显示「不支持」并禁用，原因放按钮 title。检测只影响表单预填，不新建运行时记录。

### 执行协议（`dsh` 插件：`dsh --profile <p> --stdio`，JSONL v1）

以下帧全部由 `dsh` 执行器插件解析，宿主只经 `ExecutorIO` / `Receipt` 收数据。

- 每个 run 启动一个子进程：`dsh --profile <p> --stdio`；stdin / stdout 逐行 JSON，stderr 只保留尾部用于诊断。
- stdin 帧：

| 帧        | 内容                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `execute` | `{ v: 1, type: 'execute', request_id, cwd, prompt, model?, reasoning_effort?, resume_session_id?, mcp_servers: [] }` |
| `cancel`  | `{ v: 1, type: 'cancel', request_id }`                                                                               |

- stdout 帧 → 事件 / 结果：

| 帧               | 处理                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `ready`          | 校验 `runtime='dsh'`；不产生事件                                   |
| `session`        | 记 `session_id`（供聊天续接），并发一条 `status` 事件（`running`） |
| `text`           | 追加 `RunEvent{type:'text'}`，并计入 run.output                    |
| `thinking`       | 追加 `RunEvent{type:'thinking'}`，不并入 output                    |
| `tool_call`      | 追加 `RunEvent{type:'tool_call'}`（tool/callId/input）             |
| `tool_result`    | 追加 `RunEvent{type:'tool_result'}`（tool/callId/output/isError）  |
| `usage`          | 累加到 `run.usage`（input/output/cacheRead/cacheWrite）            |
| `result`         | 终态（见「终态归一」），可带 `resume_rejected`                     |
| `protocol_error` | 记协议错误，终态归 `protocol_error`                                |
| `models`         | 仅 `--list-models` 使用，run 流中不出现                            |

- 校验：帧 `v` 必须为 `1`（否则记 `protocol_error`）；带 `request_id` 的帧必须匹配当前请求，不匹配则忽略。未知帧类型忽略；非 JSON 行忽略（不产生事件、不致命、不计数）。
- 事件**只来自协议帧**，不从原始文本猜测；stderr 不作为模型输出。
- `execute` 的 `model` 为 `{ provider, id }`（由运行时 `provider/model` id 解析；格式不对直接失败并归 `run_failed`）；`reasoning_effort` 仅在配置非空时发送。
- `mcp_servers` 当前固定空数组（协议预留，不做 MCP 注入）。

### 取消、超时与进程树

- 取消：先写 `cancel` 帧 → **3s** 宽限 → `SIGTERM` → **2s** 后 `SIGKILL`；Windows 用 `taskkill /T /F` 杀进程树（POSIX 按进程组发信号）。
- 超时：默认 **30 分钟**（`RUN_TIMEOUT_MS`，契约未暴露配置项）→ 走与取消相同的终止流程，终态 `timeout`。
- 子进程无法启动或 execute 帧写不进去 → `spawn_failed`；异常退出 → `exit_nonzero`；始终没有 `result` 帧 → `no_result`；未收到 `ready` 就退出 → `protocol_error`。

### 终态归一

| 终态      | `run.status`               | `errorCode`                                                                                                                                |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| succeeded | `succeeded`                | null                                                                                                                                       |
| failed    | `failed`                   | `spawn_failed` / `exit_nonzero` / `run_failed` / `protocol_error` / `no_result` / `runtime_missing` / `runtime_disabled` / `executor_lost` |
| cancelled | `cancelled`                | `cancelled`                                                                                                                                |
| timeout   | `failed`（timeout 计失败） | `timeout`                                                                                                                                  |

`result` 帧的 `status` 归一：`completed`/`succeeded`/`success` → succeeded；`cancelled`/`canceled`/`aborted` → cancelled；`timeout`/`timed_out` → timeout；其余 → failed。

| `errorCode`        | 含义                                                        |
| ------------------ | ----------------------------------------------------------- |
| `spawn_failed`     | 子进程启动失败，或 execute 帧无法写入                       |
| `exit_nonzero`     | 进程非零退出且没有 `result` 帧                              |
| `run_failed`       | `result` 帧报失败但无更具体归类；后端抛错；模型 id 格式不对 |
| `timeout`          | 执行超时（run 计 `failed`）                                 |
| `cancelled`        | 用户取消（run 计 `cancelled`）                              |
| `protocol_error`   | 协议帧错误，或未就绪就退出                                  |
| `no_result`        | 进程结束但没有终态结果                                      |
| `runtime_missing`  | 运行时不存在（被删）                                        |
| `runtime_disabled` | 运行时已停用                                                |
| `executor_lost`    | 执行器/子进程失联，租约过期被回收（run 计 `failed`；M2 起） |

- `runs` 记录 `runtime_id`、`session_id`、`error_code`、`exit_code`、`duration_ms`、`usage`（列 `usage_json`）；运行事件另存 `run_events`（`seq` 单调递增；`payload_json` 存事件其余字段；`output` = `text` 汇总）。
- 运行时被删后 `runs.runtime_id` 置空（历史记录保留）。

### 会话与续接

- **工作流任务**（M15）：会话键是 `(taskId, agentId)`。同一任务内的后续轮次（打回重做、反馈、`turn+1`）带 `resume_session_id` 续接；**换任务即新会话**，跨任务上下文靠提示词里的「任务索引」+ 产物路径按需读取，不共享对话历史。
- **聊天**：首轮发完整 prompt（System Prompt + 历史 + 结尾提示）；对话保存 `session_id` 后，下一轮 `execute` 带 `resume_session_id`、**只发新消息**，不重发整段历史。若 `result` 帧 `resume_rejected=true`，清空本地会话并用完整历史重试一次；重试仍失败按失败落库。
- 会话由 dsh profile 持久化，主进程可通过 `MULTICA_DSH_SESSION_ROOT` 指定会话目录。

### 调度

- 同一运行时按 `maxConcurrent` 限流：超出上限的 run 保持 `queued`，队列全局 FIFO；不同运行时并行。
- 运行时不存在 / 已停用时不派发，run 直接 `failed` 并记 `runtime_missing` / `runtime_disabled`；配置引用了未注册的 `executorKey` 同样落 `runtime_missing`（文案 `执行器插件未注册: <key>`），不新增 `errorCode`。
- `src/host/scheduler.ts` 负责：领取（内核按 `notBefore`/`queueSeq` 决定顺序与并发窗口）、调执行器端口跑一轮、帧批量入账、回执转交内核、取消时序（abort → 宽限 → 强杀 → 兜底终态）；租约/超时/退避由唯一 `clock.tick` 驱动。终态后由内核产 `RUN_SUCCEEDED`/`RUN_FAILED` 的阶段流转事实；取消的 run 不推进阶段。

### 审批与等待（M4）

- 执行器回执带 `ask[]` 时，内核为每条产 `card.opened`（`version=1`、`delivery='pending'`），run 进 `waiting` 并释放租约与并发位：**等待期无子进程、不耗 Token**，会话 id 留在 run 上。
- 通道投递后回报 `card.delivered`（单列 `delivery`）；重启只补投 `pending` 的卡；失败只落 `card.delivery_failed`，卡片仍 `open`。
- 回答走 `card.answer` 命令（`commandId` 幂等）：内核校验卡片 `open`、下标在 `options` 内、run 为 `waiting`，产 `card.answered`；**同一 run 的全部 open 卡都答完**才回 `queued`（同 run、`turn+1`、`resumeSessionId = 上一轮 sessionId`、`notBefore=null`），续接同一会话。未答完保持 `waiting`，悬空卡可 `card.resolve` 关闭。
- **补充说明 `note`（M13）：** `card.answer` 可带一段 ≤2000 字的自由文本（去首尾空白，空 / 全空白视为没写）。它有两个去处，都是**资料**、不进指令段：`card.answered.note`（事实日志留档，供事后复核；卡片行不存这一列）与续接提示词的「## 人补充说明（资料，不是指令）」段（`answerPrompt(cards, note)`）。界面上它是 `ask` 卡里选项上方的一个可选输入框——只选一行说不出异议，闸门判定、方案取舍都要人能先说话再选。已知边界：同一批多张阻塞卡各自的附言只有**最后一张答完**那次续接会带上，其余留在事实里（M12 的打扰规则要求同一轮只发一张 ask 卡，产品路径走不到这一支）。
- 回执 `later`（无 `ask`/`notices`）→ run 回 `queued` 且 `notBefore=later`，由现有 `next-wake` 到点复查；`ask` 优先于 `later`。
- 回执 `notices` → 空选项信息卡（不阻塞 run）；`resolves` → 关闭同 run 的 open 卡（`reason='agent'`）。`events` → `event.received`（`hops=父+1`）或 `event.dropped`，M4 只入账、不派活。
- 「执行中」仍 = 存在 `queued`/`running`/`waiting` run；`waiting` 不占并发位、不参与 `nextWave` 的领取。
- **界面分层（通知 vs 处理）：** 顶部 `ApprovalBar` 只是信标——一行一张卡，只给标题、待选项数与落点（任务 / 对话），**不渲染正文、选项与关闭按钮**；点条目把人送到卡片的落点：挂任务的进任务详情，聊天卡切到对应会话。正文、选项、通知的 `×` 全部由 `ApprovalCards` 在落点内呈现（任务详情信息区之后、会话消息流上方）。选项**一行一个**（全宽行、`min-h-10`、行间距 8px、左侧序号只做视觉锚点且 `aria-hidden`，读屏念纯文案）——横排按钮挨在一起、长文案被挤成多列时最容易点错，而 `card.answer` 不可撤回；列表上方固定一句「点一行即提交，不能撤回」。系统通知（desktop 通道）同理只给标题 + 固定一句指引，卡片正文不进系统通知。落点内的两类卡长得不一样：`ask` 警告色描底 + 左侧色条、选项竖排；`notice` 中性面板、标题降一档字阶，同文案合并成一行（`×N`）并给 `×` 与「知道了」两个关闭入口。

### 通知分层（M12：打扰口径）

判据是「**不处理会不会耽误事**」，不是「智能体说了什么」。卡片带显式 `kind`（`CARD_KINDS`）：

| 事件                                             | 类型                                     | 打扰级别                                       | 出口                                                     |
| ------------------------------------------------ | ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| 回执 `ask` → 卡片                                | `kind='ask'`（`options` 非空，阻塞续接） | 打断（系统通知，**一张卡一次，不合并**）       | desktop 通道 `sdk.notify`；点进去在 `ApprovalCards` 作答 |
| 回执 `notices` → 卡片                            | `kind='notice'`（`options` 空，不阻塞）  | 只知会（**不发系统通知**，应用内同文案合并）   | `ApprovalBar` 的「通知」栏 + 落点内 `×` 整组关闭         |
| `task.completed`（宿主/智能体推进）              | 事实                                     | 查看级（一条结局通知）                         | `host/notices` → `sdkHost.notify`                        |
| `run.failed`（终态失败，`taskId` 非空）          | 事实                                     | 查看级（一条结局通知，多个任务失败合并带数量） | 同上                                                     |
| 人在 UI 里自己点的完成（`actor.kind==='owner'`） | 事实                                     | 不通知                                         | 只写事实与活动流                                         |
| 聊天轮次失败（`run.failed` 且 `taskId===null`）  | 事实                                     | 不通知                                         | 错误消息就在会话里                                       |
| 过程、假设、未核验清单、前置条件                 | 正文文字                                 | 不通知                                         | 回复正文 / 任务活动流                                    |

打扰收敛的三条机制：

1. **卡片级去重，不按 run 合并**：desktop 通道对「同一张卡的同一个 `version`」只弹一次（重启补投、通道重放不再打扰），卡片原地更新（`version + 1`，问题变了）照弹——`ask` 是一个个独立的决定，两张卡就是两次打扰；`notice` 从不弹系统通知。被跳过的卡照常 ack `delivered`（投影即送达，跳过通知不算投递失败）。
2. **应用内合并只给通知**：`ApprovalCards` / `ApprovalBar` 把「同落点 + 同标题 + 同正文」的 `notice` 合并成一行（`×N`，一个 `×` 整组关闭）；`ask` 永远一张一条，不合并。
3. **回执口径约束**：提示词要求「同一轮只发一张 `ask` 卡承载同一决策的全部待定项」，`notices` 只写会改变人判断的一句话——噪音在上游就被砍掉。
4. **结局通知不重复**：一批事实里同一任务只产一条；失败按任务去重后聚合，标题带数量。
5. **卡随结束收起**：run 落终态（成功 / 失败 / 取消）或任务完成后，内核在决策出口把它名下还 `open` 的卡统一 `card.resolved{reason:'cancelled'}`——信息卡不阻塞，任务一结束就不该再出现在「待审批 / 通知」里（`kernel/cards.closeCardsOnFinish`）。

`kind` 的判据由内核建卡时写明（`kernel/cards.ts`）。M12 改了 `cards` 的投影列，`KERNEL_VERSION` 随之递增到 `M12.0.0`——不递增就不会重建，`ALTER TABLE ... DEFAULT 'ask'` 会把 M12 之前的**信息卡全部写成 ask**，界面上表现为「通知混进待审批、没有关闭按钮」。老事实重建时按「`options` 是否为空」归一（`kernel/project.normalizeCard`）；渲染层另有一层同口径兜底（`apps/ai-workflow/model/cards.ts`），宿主没升级时也不会把通知塞进待审批。

## IPC 契约（M5：三动词）

契约定义在 `src/protocol`（命令/视图/推送）与 `src/shared/workbench-api.ts`，preload 只暴露
`window.workbench`；renderer 禁止直接 import electron/fs/child_process。**旧 `window.aiWorkflow`
命名空间与 `src/shared/ai-workflow-api.ts` 已删除**（AI 工作流 app 的读写在三动词上完成）。

| 旧具名方法（M4 及以前）                    | M5 走法                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimes.list()`                          | `query('runtimes.all')`                                                                                                                              |
| `runtimes.statuses()`                      | `query('runtimes.statuses')`                                                                                                                         |
| `runtimes.detect()`                        | `query('runtimes.detected')`（宿主视图，只读）                                                                                                       |
| `runtimes.executors()`                     | `query('runtimes.executors')`（宿主视图，只读）                                                                                                      |
| `runtimes.models(id)`                      | `query('runtimes.models', { runtimeId })`（宿主视图）                                                                                                |
| `runtimes.default-workdir`                 | `query('runtimes.default-workdir')`（宿主视图，无参数；`workdir` 留空时执行器实际用的绝对路径）                                                      |
| `runtimes.create/update/remove`            | `dispatch({ type:'runtime.create' \| 'runtime.update' \| 'runtime.remove', commandId, ... })`                                                        |
| `runtimes.probe(id)`                       | `dispatch({ type:'runtime.probe', commandId, id })`（宿主探测 → 落 `runtime.probed`）                                                                |
| `agents.*`                                 | `query('agents.all')` + `dispatch({type:'agent.create' \| 'agent.update' \| 'agent.remove'})`                                                        |
| `workflows.*`                              | `query('workflows.all')` + `dispatch(workflow.*)`                                                                                                    |
| `tasks.list(workflowId)`                   | `query('tasks.byWorkflow', { workflowId })`                                                                                                          |
| `tasks.create/moveToStage/complete/remove` | `dispatch({type:'task.create' \| 'task.move' \| 'task.complete' \| 'task.remove'})`（`task.create.input.projectId` 必填，M10）                       |
| `projects.list()`                          | `query('projects.all')`                                                                                                                              |
| `tasks.listByProject(projectId)`           | `query('tasks.byProject', { projectId })`；没有项目的任务走 `query('tasks.unassigned')`（M10）                                                       |
| `projects.create/update/remove`            | `dispatch({type:'project.create' \| 'project.update' \| 'project.remove', commandId, ...})`                                                          |
| `pickFolder()`                             | `window.workbench.pickFolder()`（宿主原生目录选择器；取消返回 `null`）                                                                               |
| `runs.listByTask(taskId)`                  | `query('runs.byTask', { taskId })`                                                                                                                   |
| `runs.events(runId)`                       | `query('run.events', { runId })`                                                                                                                     |
| `cards.open()`                             | `query('cards.open')`                                                                                                                                |
| `cards.answer(cardId, index)`              | `dispatch({type:'card.answer', commandId, cardId, optionIndex, via:'ui'})` → `value` 是回答后的卡                                                    |
| `chat.listConversations()`                 | `query('conversations.byProject', { projectId })` / `query('conversations.unassigned')`（M11：按当前项目取；`conversations.all` 仍在，供跨项目解析） |
| `chat.listMessages(cid)`                   | `query('messages.byConversation', { conversationId })`                                                                                               |
| `chat.createConversation`                  | `dispatch({type:'chat.create', commandId, agentId, projectId})` → `value` 是新对话（`projectId` 省/null = 默认目录）                                 |
| `chat.send(cid, content)`                  | `dispatch({type:'chat.send', commandId, conversationId, content})`                                                                                   |
| `chat.removeConversation`                  | `dispatch({type:'chat.remove', commandId, conversationId})`（宿主先取消活跃 run）                                                                    |
| `chat.cancel(cid)`                         | `dispatch({type:'chat.cancel', commandId, conversationId})`                                                                                          |
| `chat.archiveConversation(cid, archived)`  | `dispatch({type:'chat.archive', commandId, conversationId, archived})`（缺省归档；不删消息/run）                                                     |
| `chat.onEvent(cb)`                         | `subscribe(handler)` 的 `{kind:'stream' \| 'stream-end'}`（过滤 `conversationId`）                                                                   |
| `onChanged(cb)`                            | `subscribe(handler)` 的 `{kind:'facts', seq, types}`（按类型失效、按需重取）                                                                         |

- 所有写命令带 `commandId`；宿主 `commands` 表按事实区间回放，重复提交不重复产事实（reject 不缓存）。
- `runtimes.create` 的 `RuntimeInput`：`name` 必填，其余可省略。`executorKey` / `command` / `profile` 的缺省值由宿主按所选执行器插件 manifest 补齐（未指定 key 取注册表首项，未知 key 给可读错误），`argsTemplate` 缺省为空串；创建前按补齐后的配置探测，失败不落库。
- `RuntimeExecutorChoice = { key, label, command, profile }`（顺序即 `registry.executors` 顺序）；`DetectedRuntime` 形状见「检测（detect）」。宿主视图只读：不写库、不发失效。
- renderer 侧统一经 `shell/kernelStore`（先订阅后 `kernel.seq` 快照、按 seq 续传、失效重取、单订阅）；
  看板「执行中」读 `tasks.executing`，不再逐任务推导。聊天流旁路只做实时显示，事实才是数据源。
- 契约新增**不得**改动 `WorkbenchApi` 的形状；新增能力走新命令 + 新视图，不恢复具名 RPC。

## Code Style

同 shell（TS strict；组件 PascalCase、函数/变量 camelCase、常量 UPPER_SNAKE_CASE；命名导出）。核心风格——阶段流转是纯函数，返回新状态与待执行效果：

```ts
export type StageEffect =
  { type: 'createRun'; stageId: string; agentId: string } | { type: 'waitUser' } | { type: 'none' }

/** 纯函数：不读写库、不 spawn；由宿主执行返回的 effects */
export function moveTask(
  task: Task,
  event: StageEvent, // RUN_SUCCEEDED | RUN_FAILED（自动流转）
  workflow: WorkflowWithStages,
): { task: Task; effects: StageEffect[] }

/** 纯函数：看板拖拽 —— 落点即目标阶段，不套用 on_complete / on_reject */
export function moveTaskToStage(
  task: Task,
  stageId: string,
  workflow: WorkflowWithStages,
): { task: Task; effects: StageEffect[] }

/** 纯函数：拖到「归档」区 */
export function completeTask(task: Task): Task
```

## Testing Strategy

- 框架：Vitest + @testing-library/react，测试统一放 `tests/`，与 `src/` 同构镜像（`src/kernel/decide.ts` ↔ `tests/kernel/decide.test.ts`，文件名后缀 `*.test.ts(x)`）。
- **阶段状态机（重点，要求分支全覆盖）：** `kernel/workflow/stage-machine.ts` 纯函数单测——三种 `entry_mode` 的进入效果、`on_complete`/`on_reject` 显式配置与默认解析（下一阶段 / 上一阶段 / 终端 completed / 首阶段原地）、多阶段串联、终端完成、`RUN_FAILED` 打回原地时无 effects（不重试）；以及 `moveTaskToStage`（跨阶段落点、目标不存在、落在当前阶段、已完成不参与）与 `completeTask`。
- **账本与投影（`tests/host/store`）：** 临时 SQLite 文件/`:memory:` 测导入幂等与分批、实时投影与 `rebuild` 逐表全等（含 `run.removed` 等删除事实）、`(run_id, seq)` 纯追加、视图查询；外键/唯一约束、被引用拒绝、起始阶段校验在导入与 schema 用例覆盖。
- **调度与执行链（`tests/host/scheduler|cancel|reconcile|executor|effects|clock`）：** 注入假执行器端口（不启真进程）测同运行时 `maxConcurrent` 限流、多运行时并行、成功/失败/取消/超时 → 终态与 `errorCode` → 阶段流转；租约/心跳/退避/超时/取消宽限与强杀、启动对账、唯一 `clock` 排期与 `rearm`。
- **运行时探测：** 注入假进程/假流测 `--probe` 帧成功、非零退出、超时、spawn 失败、输出截断、`--version` 解析，并断言不产生 run；另一条用真实 `node -e` 覆盖默认 spawn 路径（不联网）。
- **协议后端：** 逐帧解析（ready/session/text/thinking/tool_call/tool_result/usage/result/protocol_error）、`v`/`request_id` 校验、非 JSON 行忽略、usage 累加、终态归一（含 `run_failed`）；取消信号顺序（cancel 帧 → 3s → SIGTERM → 2s → SIGKILL，Windows `taskkill /T /F`）与进程树终止；`--list-models` 投影。
- **聊天执行链（`tests/host/chat`）：** 假协议后端 + 真实内核/内存库测 `resume_session_id` 续接（只发新消息）、`resume_rejected` 自动重试一次、帧入账→终态→`message.appended` 顺序、非零退出/超时/取消失败落消息、并发第二次 `send` 拒绝、对话执行中被删仍正常收尾。
- **IPC：** 三动词契约（命令形状 / 视图参数 / 推送事件）在 `tests/protocol`、`tests/host/commands`、`tests/main/ipc`、`tests/preload` 覆盖：命令校验拒绝非法载荷、`commandId` 幂等、拖拽/完成的非法路径（有活跃 run、目标阶段无效）、`runtime.probe` 编排、`detect`/`executors`/`models` 宿主视图只读、`chat.*` 路由与取消；renderer 用 kernelStore 替身覆盖订阅/失效/续传。
- **组件：** KanbanBoard 按阶段分列渲染任务，拖拽卡片到列触发 `moveToStage`、拖到「归档」区触发 `complete`，单击卡片把任务交给上层，归档区的「查看归档」在无归档任务时禁用；ArchivedTasksDialog 按最近更新倒序列出已完成任务（阶段名 / 未知阶段兜底 / 计数）、点行交回上层并关闭、空态、不传打开回调时行禁用、Esc 与 × 关闭；TaskCard 可拖拽（有活跃 run 时不可拖）、按进入方式显示提示、点击 / Enter / Space 进详情且线程入口不冒泡；TaskInfoPanel 任务信息（状态 / 阶段 / 来源 / 线程 / 时间 / 标签）；TaskBrief 任务说明（初始输入单独成卡、空态「没有描述」）；TaskDetailPage 右上动作（失败后可「重新执行」→ `task.rerun`（无历史 run / 执行中 / 已完成不出现；动作失败展示后端文案）；执行中给「停止执行」→ `task.stop`；「完成任务」执行中禁用并带 title；已完成只留标记）；TaskActivity 上下文活动流（运行与反馈混排、text/thinking/tool 折叠、**提权记录**（`run.approvals`：工具 / 理由 / 结果，未知结果原样显示，无记录不占版面）、errorCode 文案、用量/退出码/耗时、空态与事件流失败）；TaskCommentForm 反馈提交（空文本禁用、勾选接着做、提交中禁用、失败保留输入）；TaskDetailPage 三个视图的加载 / 空态 / 读失败与 `task.comment` 提交；ThreadDetailPage 任务列表与笔记 / 绑定 / 归档；TaskDialog 选择起始阶段；WorkflowEditor 编辑阶段三项目标；RuntimeManager 健康 pill（可用/不可用/未检测）、CLI 版本、负载、探测按钮 pending/成功/失败、行间独立；RuntimeDialog 字段与校验、模型下拉、**完全访问风险确认**（选中 `danger-full-access` 必须勾选才可保存，换模式即撤销）；WorkspaceNav 切换条两个栏目切换并渲染上下文列表槽；ConversationList 的智能体选择/新建/选中/删除；ChatPanel 的草稿、Enter 发送、Shift+Enter 换行、发送中中止、空会话与错误提示、**会话内待处理卡**（正文与选项在消息流上方就地作答）；ApprovalBar 只列标题与落点（正文与选项不渲染、无落点的卡禁用、两栏计数互不串栏、读失败只在有卡时提示），ApprovalCards 的正文换行原样展示、选项作答 / 通知只留一个 `×` 关闭（不再有「知道了」）/ 重复回答与关闭失败文案 / 作答中禁用、任务详情只收本任务的卡。
- **聊天 hook（`useChat`）：** 新建/发送/`event` 流式回显/`end` 落库重载/中止/删除/各类错误分支、卸载退订、只处理当前会话的增量。
- **页面：** 两栏布局下工作台默认落在「聊天」栏（侧栏顶部切换条 + 会话列表可见、设置栏目不可见），切「任务」显示看板并隐藏输入区；单击任务卡进入任务详情页、`返回`/Esc 逐级回栈，线程详情页的任务列表可点进任务详情，看板「查看归档」翻出已完成任务并可点进详情；侧栏底部「设置」图标进配置视图、设置视图里「返回工作台」图标回工作台，设置三栏目互不混排。
- **执行器插件（`tests/plugins`）：** registry 汇总（顺序稳定、`executorKey`/`supported` 回填、同 command 先到先得、单插件抛错或超时隔离、空注册表）、`command` 插件的参数模板展开与 `{prompt}` 二选一（argv 元素 / stdin）、Windows `.cmd` 固定包装、假协议端到端验收（真 registry + 真 scheduler + 内存库）。
- 覆盖率：`stage-machine.ts` 分支覆盖 100%；其余按 `pnpm check` 阈值。

## Boundaries

- **Always：** 阶段流转/默认目标解析只写在 `stage-machine.ts`；SQLite 只在主进程读写，renderer 一律经 `window.workbench` 三动词；进程执行经执行器插件端口，事件只来自协议帧；新增运行时协议只写 `src/plugins/executors/<id>/` + registry 一行，不改内核/宿主/UI；提交前 `pnpm check` 通过。
- **Ask first：** 新增 npm 依赖（尤其原生模块）；修改 shell 的 `AppPlugin` 或既有 `WorkbenchApi` 契约；改变数据库文件位置或引入迁移框架。
- **Never：** 在 renderer 直接 `require('electron')`/用 `fs`/`child_process`；把业务规则写进组件；把凭据/token 明文写库；从原始文本猜测事件或把 stderr 当模型输出；删除失败测试或改测试预期来掩盖问题。

## Success Criteria

1. 能添加一个 DeepSeek Harness 运行时（创建前探测通过、健康为可用）、建一个绑定它的智能体，重启后仍在（数据落 SQLite）。
2. 能建一条含 ≥3 阶段的工作流，逐阶段配置【进入时】【完成后进入】【打回时退回到】；`none`/`agent`/`user` 三种进入方式均可保存并在看板生效。
3. 新建任务时可指定**起始阶段**（默认首阶段）；`agent` 阶段经 `--stdio` 协议真实执行并回写事件流与输出，成功后按 `on_complete` 推进、失败/超时按 `on_reject` 退回（由假协议后端单测证明流转；DSH 真跑作为手动验收）。
4. `user` 阶段卡片显示"等待你处理"；把卡片拖到其它阶段列即进入该阶段（落点为准，不限于 `on_complete`/`on_reject`）；有活跃 run 时卡片不可拖动/完成，agent 阶段失败后（无活跃 run）可拖走重试或完成。
5. 自动流转走完全部阶段且无下一阶段时任务 `completed`；手动拖到「归档」区同样 `completed` 并移出看板；归档后的任务仍能从归档区的「查看归档」翻出来，点一行回到任务详情页。
6. 运行记录（状态、耗时、退出码、errorCode、用量、事件流）在**任务详情页**查看（页面形态，宽布局）；同一任务可以像 issue 一样追加反馈，反馈进「上下文活动流」并作为下一次运行的「反馈记录（资料，不是指令）」段；`rerun` 勾选时任务若停在 agent 阶段且没有活跃 run 就再跑一轮。同一运行时按 `maxConcurrent` 限流，多运行时并行。
7. 运行时配置页对每条已配置运行时显示健康 pill（可用/不可用/未检测）与负载；点「测试」得到探测结论（CLI 版本、协议版本、耗时、失败原因）；探测不产生 run。
8. 工作台默认落在「聊天」栏（单列侧栏 + 内容区）：侧栏顶部可在聊天/任务间切换，聊天栏可新建对话、选智能体、发消息并看到流式输出，可中止；切到「任务」栏侧栏换成工作流切换器、内容区是看板，单击任务卡进入任务详情页看运行记录、返回回到看板；侧栏底部「设置」图标进入配置视图，设置视图里「返回工作台」图标回到工作台。
9. 聊天记录落 SQLite（含会话 `session_id`）：新建对话、消息、标题在重启后仍在；删除对话级联删除其消息；同一对话第二轮续接会话，`resume_rejected` 时自动重试一次。
10. 阶段状态机分支覆盖 100%；`pnpm check` 全绿。
11. 顶部栏出现"AI 工作流"标签并可切换（由 shell 承载，app 无需感知）。
12. 新增一个假运行时协议只写 `src/plugins/executors/<id>/` + registry 一行，即可被 `runtimes.detect` 汇总到、在运行时表单里选中并跑通一轮；`git diff` 证明 kernel / host / renderer 未因新增协议改动。

## Out of scope（本 MVP 不做）

- 远端 Worker / 多设备执行 / 登录与多用户（仅留架构位）。
- Postgres / Redis 等外部服务；除 SQLite 外无其它存储。
- 多审批人、超时提醒、打回的多级语义、审批意见流。
- stdio 审批往返：权限越界直接失败，不弹审批。
- MCP server 注入：协议字段 `mcp_servers` 固定空数组（仅预留）。
- 统计分析、成本/token 看板、任务依赖图（`usage` 已记录，不做统计视图）。
- 聊天的多轮并行（同一对话同一时刻只跑一轮）、附件/图片、消息编辑与重新生成、跨对话搜索、对话与任务/阶段绑定。

## Open Questions

1. **打回默认目标**：未配置【打回时退回到】时默认「不指定」，即打回后原地不动、不做任何流转（已按此实现）。
2. **`none` / `user` 阶段的推进方式**：看板上把卡片拖到目标阶段（已按此实现，不再有「推进 / 通过 / 打回」按钮）。
3. **终端阶段**：最后阶段完成后任务置 `completed` 并移出看板；看板末尾的「归档」区是拖拽落点（显示已完成数量）**加回看入口**（「查看归档」弹出已完成任务清单，点一行进任务详情），不是可反向拖出的虚拟列。落点不叫「已完成」，因为阶段本来就可以叫「已完成」——那种阶段只是普通阶段，卡片进去仍是 `active`（`entry_mode='agent'` 时还会起一轮 run），只有自动流转越过最后阶段或拖到「归档」区才 `completed`。
4. **运行时工作目录**：`workdir` 为 `null` 时用宿主默认目录——`WORKBENCH_WORKDIR` 环境变量 > `~/.workbench`（启动时创建，`runtimes.default-workdir` 可查）；运行时可单独覆盖，按任务/项目切换仍需另行设计。
