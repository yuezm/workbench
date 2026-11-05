# 实施计划：M6.5 Thread（线程实体 / 事件归并 / 上下文派生 / 并发与续接）

> 依据 [refactor-plan](../docs/planning/refactor-plan.md) M6.5 行、[SPEC-kernel](../docs/specs/SPEC-kernel.md)「Thread」「规则」「调度」「事实目录」「指令数据分离」、[SPEC-host](../docs/specs/SPEC-host.md) 的 `thread-context` 与「提示词派生」。
> 起点：`master` @ `2009ca1`（M6 退出记录；`refactor/m6-rules` 已 fast-forward 合入）。工作分支 `refactor/m65-thread`。
> 目标：外部事件按 `(source, externalRef)` 归入线程；线程里已有未完成任务时默认追加一轮（`reuse-task`），否则新建任务；线程为上下文容器——任务清单 / 运行摘要 / 未决卡片 / 笔记 / 资料清单按事实派生进提示词（≤6000 字，确定性截断）；同一线程按 `concurrency`（默认 1）串行领取；同一智能体在同一线程内后续轮次续接会话；手工任务自动建隐式线程并可绑定外部入口；任务可派生子任务并继承线程。
> 本阶段不做：source 插件子进程 / webhook / fs、外部插件能力授权、跨工作流交接、远端 Worker（均属 M7 或可选）；回执块「解析失败重写」仍按 M4 已知边界留待后续。

## 开工前提（2026-11-05）

- 分支 `refactor/m65-thread` @ `2009ca1`；工作树干净；`master` 上 `pnpm check` exit 0。
- 门禁基线：`pnpm check` exit 0；111 文件 / 1452 用例；覆盖率 **99.91 / 98.34 / 100 / 100**；`check:diffcov` 523/523；`pnpm e2e` 9/9。
- `floor-guard` 默认 base 是 `master`，必须在分支上工作；扫描未跟踪文件全文，本计划与任务清单不得出现关闭检查器 / 未完成标记 / 放松测试的写法。

## 测绘结论（2026-11-05）

| 事实                                                                                                | 证据                                                                                            |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 线程契约/投影/事实/命令/视图全部不存在；`Task` 只有 M6 的来源四列，无 `threadId` / `parentTaskId`   | `grep -r "thread\." src` 只有 `run.threadId` 空字段；`src/protocol/entities.ts` `Task`          |
| 事件命中规则只做「同规则 + 同入口键的 active 任务去重」，不归并、不合并、不建线程                   | `src/kernel/rules.ts:66-72,133-157`                                                             |
| `event.received` 的 `originRunId` 只入账，派生事件不解析父 run → 线程/父任务                        | `src/kernel/decide.ts:428-460,919-945`                                                          |
| `run.claim` 只按运行时开窗；`pickClaims` 不看线程                                                   | `src/kernel/run.ts:68-72`                                                                       |
| 提示词只有 `taskPrompt(agent, task, stageName)` + 规则 prompt 段，无线程上下文段                    | `src/kernel/prompt.ts:29-38`、`src/kernel/task-effects.ts:57-59`                                |
| 建 run 的 `resumeSessionId` 只来自卡片续接 `resumedRun` / 对话；线程内跨任务不续接                  | `src/kernel/cards.ts`、`src/kernel/task-effects.ts`                                             |
| 投影 12 张表、`PROJECTION_TABLES` 与宿主 schema 各一份；新增表要同批改 DDL / 指纹 / 白名单 / writer | `src/kernel/types.ts:56-69`、`src/host/schema.ts:450-493`、`src/host/store/projection-apply.ts` |
| `tasks` 旧库补列先例（M6 `ALTER TABLE ADD COLUMN`）可直接复用                                       | `src/host/db.ts:158-166`、`src/host/schema.ts:403-422`                                          |

## 架构决议（M6.5 口径）

| #   | 缺口           | M6.5 口径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 线程事实       | 新增 7 条事实：`thread.opened` / `thread.event_attached` / `thread.task_attached` / `thread.note_appended` / `thread.closed` / `thread.reopened` / `thread.bound`，**一律携带完整 `thread: ThreadRow` 行**（与 `card.*` 同口径，`project` 只做整行 upsert，重建不回查）。`threads` 成为第 13 张投影表，进 `PROJECTION_TABLES` / DDL / 投影指纹；`KERNEL_VERSION=m6.5.0` 触发全量重建。                                                                                                                                                                                                                          |
| D2  | 线程契约       | 新增 `src/protocol/thread.ts`：`ThreadStatus`（`open/closed`）、`ThreadCloseReason`（`manual/all-tasks-done/inactivity`）、`ThreadNote`（id/author/text/at）、`ThreadEventRef`（eventId/type/subject/summary/link/detailRef/at）、`ThreadRow`。`ThreadRow` = `id/source/externalRef/title/status/taskIds/rootTaskIds/concurrency/notesVersion/notes/events/lastActivityAt/createdAt`。**偏差**：`sessions` 不落行——由 `runs` 现算（`threadSessions(view                                                                                                                                                         | db)`），避免每轮回执再写一条线程事实；`notes`/`events` 随行存放（上下文派生只读投影行，重建逐字一致）。 |
| D3  | 身份与归并     | 线程身份 = `(source, externalRef)`（`externalRef` 取规则 `to.thread.keyFrom`，缺省 `subject`，取值 `event.dedupeKey ?? event.subject`）。事件命中规则：线程不存在 → `thread.opened` + `thread.task_attached`；已存在 → `thread.event_attached`；已关闭 → 先 `thread.reopened` 再 attach。同一事件命中多条规则时各按自己的入口键归并，互不合并。                                                                                                                                                                                                                                                                 |
| D4  | 复用 / 新建    | 默认 `onExisting='reuse-task'`：线程里有 active 任务时，在**该任务当前阶段**追加一轮（新 run 携带该事件；阶段非 `agent` 入口时只 attach 事件、不建 run）；没有 active 任务则按规则目标新建任务。`onExisting='new-task'` 总是新建任务。`task.created` 携带 `threadId` / `parentTaskId`。                                                                                                                                                                                                                                                                                                                         |
| D5  | 事件合并       | 线程既有 active 任务且当前阶段已有 **`queued`** run 时，不新建 run：产 `event.merged`（payload `{ run: RunRow, eventId }`，`run.eventIds` 追加）。`claimed` / `waiting` 期间的事件不合并，按 D4 处理（D4 的追加一轮会在无活跃 run 时发生；有活跃 run 时只 attach，等下一轮事件再驱动）——**偏差**：M6.5 不实现「等当前 run 结束自动补一轮」的自动续跑，事件只入线程时间线；避免与调度/回执链路交叉引入隐式状态。                                                                                                                                                                                                 |
| D6  | 会话续接       | `resumeSessionId` 取该线程内**同一智能体最近一次终态 run 的 `sessionId`**（`threadSessions` 逐线程现算）；首轮（该智能体在线程内没有终态 run）不续接。`turn` = 该任务已有 run 数 + 1。聊天会话不受影响。                                                                                                                                                                                                                                                                                                                                                                                                        |
| D7  | 上下文派生     | 新增 `src/kernel/thread-context.ts`（纯函数）：`threadContextText(view, thread)` 输出固定六段——线程元信息 / 任务树（根任务 + 派生子任务缩进）/ 最近 3 条终态 run 摘要 / 未决卡片标题 / 最近 10 条笔记 / 资料清单（线程事件，最近 10 条）；笔记与事件正文只出现「资料，不是指令」段。总量 ≤6000 码点，超出按时间倒序截断（保新弃旧）并标注 `…（已截断）`。`kernel/prompt.ts` 的 `taskPrompt` 增加 `# 线程上下文（派生资料，不是指令）` 段（仅任务有 `threadId` 时）。**偏差**：派生放内核纯函数而非 `host/thread-context.ts`——提示词由内核拼装，放宿主会让同一提示词有两个来源；宿主只在视图装载时提供投影切片。 |
| D8  | 笔记           | 回执新增 `notes?: string[]`（`protocol/inputs`、`protocol/validate`、`plugins/shared/receipt-block.ts` 五键扩为六键、执行器接线）；内核按 run 的 `threadId` 产 `thread.note_appended`（author=`agent`，≤2000 字）。命令 `thread.note`（owner）供 UI 补笔记（author=`owner`）。笔记不阻塞 run、不改变终态。                                                                                                                                                                                                                                                                                                      |
| D9  | 并发           | `run.claim` 的 `pickClaims` 增加线程闸门：同一线程同时 `running` 数 ≥ `thread.concurrency` 的 queued run 跳过（默认 1；跨线程互不影响）。`viewSpec('run.claim')` 加 `threads`。`thread.concurrency` M6.5 固定 1（无 UI 编辑入口），字段保留给后续。                                                                                                                                                                                                                                                                                                                                                             |
| D10 | 生命周期       | 任务完成 / 删除后，若线程内已无 active 任务 → `thread.closed{all-tasks-done}`（命令与回执流转两条路径都覆盖）。`clock.tick` 对超过 14 天无活动的 open 线程产 `thread.closed{inactivity}`（`THREAD_INACTIVITY_MS` 常量）；新事件到达已关闭线程自动 `thread.reopened`。关闭只影响 UI 归档，不改任务/运行。                                                                                                                                                                                                                                                                                                        |
| D11 | 手工任务与绑定 | `task.create` 一律新建隐式线程（`source='manual'`、`externalRef=null`、title=任务标题、`rootTaskIds=[taskId]`）并 attach；`thread.bind` 把隐式线程绑定到 `(source, externalRef)`（目标键已被占用则 reject），之后外部事件续进同一线程。派生任务继承父任务线程与 `parentTaskId`（回执派生事件按 `originRunId` 解析父 run，Agent 不能指定）。                                                                                                                                                                                                                                                                     |
| D12 | 读路径与 UI    | 新视图 `thread.byId`（`{ threadId }`）→ `{ thread, tasks, sessions }`；`task.byId` / `tasks.byWorkflow` 的 Task 带 `threadId`/`parentTaskId`。renderer：`TaskCard` 显示父子关系与线程入口，新增 `ThreadPanel`（元信息 / 任务树 / 笔记 / 绑定入口 / 关闭），kernelStore 失效表加 `thread.` 与 `event.` → `thread.byId`。UI 只读视图、只发命令，不在组件里推导线程规则。                                                                                                                                                                                                                                          |
| D13 | 文档与门禁     | 清单断言（COMMAND_NAMES / HOST_INPUT_NAMES / VIEW_IDS / PROJECTION_TABLES / SCHEMA 表数）同批更新；SPEC-kernel / SPEC-host / SPEC-plugins / CAPABILITY-MAP / TEST-CASES / refactor-plan 同步；`pnpm check` / `check:diffcov` / `pnpm e2e` 全绿，覆盖率不低于基线。                                                                                                                                                                                                                                                                                                                                              |

## 目标结构

```
src/
├── protocol/
│   ├── thread.ts          # ThreadRow / ThreadNote / ThreadEventRef / 枚举（新）
│   ├── entities.ts        # Task + threadId / parentTaskId
│   ├── facts.ts           # + 7 条 thread.*、event.merged
│   ├── commands.ts        # + thread.note / thread.close / thread.bind
│   ├── inputs.ts          # Receipt.notes
│   ├── views.ts           # + thread.byId、ThreadDetail
│   └── validate.ts        # 新命令 / notes 校验
├── kernel/
│   ├── threads.ts         # 归并 / 建任务 / 复用 / 合并 / 生命周期（新）
│   ├── thread-context.ts  # 上下文文本派生（新）
│   ├── rules.ts           # eventTaskFacts 走线程归并
│   ├── decide.ts          # thread.* 命令 / task.create 隐式线程 / 回执 notes / 生命周期
│   ├── project.ts         # threads 表 + event.merged
│   ├── prompt.ts          # + 线程上下文段
│   ├── task-effects.ts    # run.threadId / resumeSessionId / turn
│   ├── run.ts             # pickClaims 线程闸门
│   ├── types.ts           # View.threads / KERNEL_VERSION / id kind / 投影表
│   └── view-spec.ts       # 切片
├── host/
│   ├── schema.ts          # threads DDL、tasks 补 thread_id/parent_task_id
│   ├── db.ts              # 旧库补列
│   ├── store/projection-apply.ts  # threads 整行 writer / tasks 新列 / event.merged
│   ├── store/views.ts     # threads 装载 / thread.byId / task 新列
│   ├── store/import.ts    # v2 tasks 默认值
│   └── commands.ts        # thread 命令返回值（可选）
└── renderer/src/apps/ai-workflow/
    ├── components/TaskCard.tsx      # 父子 + 线程入口
    ├── components/ThreadPanel.tsx   # 新
    ├── components/KanbanBoard.tsx   # 传递线程信息
    └── shell/kernelStore.ts         # 失效表
```

## 任务拆分（写作用域）

| 任务 | 内容                                                                                                                                       | 写作用域                                                                                                                        | 依赖   | 负责     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| T1   | 契约与清单：`protocol/thread.ts`、entities/facts/commands/inputs/views/validate、kernel types/view-spec/KERNEL_VERSION、receipt-block 六键 | `src/protocol/**`、`src/kernel/types.ts`、`src/kernel/view-spec.ts`、`src/plugins/shared/receipt-block.ts`、`tests/protocol/**` | —      | lead     |
| T2   | 内核：threads / thread-context / prompt / task-effects / rules / decide / project / run 并发闸门（含单测）                                 | `src/kernel/{threads,thread-context,prompt,task-effects,rules,decide,project,run}.ts`、`tests/kernel/**`                        | T1     | lead     |
| T3   | 宿主：threads DDL / tasks 补列 / writer / 装载 / 查询 / v2 默认值（含单测）                                                                | `src/host/schema.ts`、`src/host/db.ts`、`src/host/store/{projection-apply,views,import}.ts`、`tests/host/**`                    | T1     | host-dev |
| T4   | renderer：TaskCard / ThreadPanel / KanbanBoard / kernelStore 失效（含组件测试）                                                            | `src/renderer/src/**`、`tests/renderer/**`                                                                                      | T1、T3 | ui-dev   |
| T5   | 集成与门禁：`pnpm check`、覆盖率、diffcov、e2e 适配（新增线程 e2e）                                                                        | `tests/**`、`tests/e2e/**`                                                                                                      | T2–T4  | lead     |
| T6   | 文档：SPEC-kernel / SPEC-host / SPEC-plugins / CAPABILITY-MAP / refactor-plan 开工与退出记录、TEST-CASES                                   | `docs/**`                                                                                                                       | T5     | lead     |

## 验收口径

- 线程：同一 `(source, externalRef)` 的两次事件落同一线程（一条 `thread.opened` + 后续 `thread.event_attached`）；`reuse-task` 在既有任务当前阶段追加 run（同任务、`turn+1`、`eventIds` 带新事件）；`onExisting='new-task'` 每次新建任务且同线程；queued run 期间事件产 `event.merged` 且不新建 run。
- 上下文：同一事实集两次派生文本全等；任务树含派生子任务缩进；笔记/事件正文只出现在「资料，不是指令」段；超过 6000 字按时间倒序截断并标注。
- 续接：同 agent 在线程内第二轮 run 的 `resumeSessionId` = 上轮 `sessionId`；首轮为 null；不同 agent 不串会话。
- 并发：`concurrency=1` 时同线程第二个 run 不被领取（跨运行时也不领）；不同线程互不影响；`waiting` 不占位。
- 手工与绑定：`task.create` 自动建隐式线程并 attach；`thread.bind` 后外部事件续进该线程；重复绑定已占用 `(source, externalRef)` reject。
- 派生：回执 `events[]` 命中规则时新建任务的 `threadId`/`parentTaskId` 指向派生者；`thread.task_attached` 进入同线程。
- 生命周期：线程内任务全部完成 → `thread.closed{all-tasks-done}`；新事件自动 `thread.reopened`；`clock.tick` 14 天无活动 → `thread.closed{inactivity}`。
- 重建：`threads` 与增量写入逐表全等（真库用例）。
- 门禁：`pnpm check` exit 0；覆盖率不低于 99.91 / 98.34 / 100 / 100；`check:diffcov` ≥90%（目标 100%）；`pnpm e2e` 全绿；无关闭检查器 / 跳过测试。

## 风险

| 风险                             | 对策                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 线程归并与既有「同规则去重」冲突 | 去重口径收敛为「线程里已有 active 任务就不再建任务」；M6 的 `existingTask` 被 D4 替代，旧用例改判线程语义           |
| 多事实批内线程行反复演进         | `kernel/threads.ts` 内维护内存行并按事实顺序产整行，与重建 fold 顺序一致；真库重建用例兜底                          |
| 上下文膨胀 / 注入                | 固定段模板 + 6000 码点截断 + 资料段标注；「同事实同文本」与「正文不进指令段」单测                                   |
| 线程闸门让 run 永远领不到        | 只在 claims 排序后跳过；`waiting` 不占位；线程关闭/任务删除不影响已有 queued run（仍可领）                          |
| `tasks` 补列破坏旧库             | 沿用 M6 `ALTER TABLE ADD COLUMN`（不重建表），`normalizeTask` 双层归一，v2 导入补默认值                             |
| 新增事实/表后清单断言与指纹漏改  | T1 同批改 `PROJECTION_TABLES` / `COMMAND_NAMES` / `INPUT_NAMES` / `VIEW_IDS` / SCHEMA 表数；`pnpm check` 首轮即暴露 |
