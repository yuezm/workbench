# 重构计划：内核 + 插件

> 依据 [ARCHITECTURE.md](../ARCHITECTURE.md) 与三份新 Spec。目标：**行为不回退、真相源唯一、扩展只改插件**。
> 起点：现有 ai-workflow 功能可用、`pnpm check` 全绿（覆盖率 99.60/96.68/99.39/99.79）。

## 总原则

1. **一次只换一层。** 先立边界，再搬纯逻辑，再换账本，最后拆插件。
2. **过渡期不允许双真相源。** 表变投影的那一刻，旧写路径同时删除；禁止「先双写、以后再删」。
3. **行为规格不重写。** `SPEC-ai-workflow.md` 的阶段语义、终态归一、取消时序、迁移规则全部保留；测试跟着搬家。允许随 API 删除而删除的测试，但必须先有等价覆盖；禁止为过关删断言或改预期。
4. **回滚分两层。** 代码与分支可丢弃；但 M1 之后数据层不可回退（事实日志只追加、投影已重写），回滚要恢复数据库备份。M1 前先做一次全量备份并验证可读。

## 里程碑

| 阶段                      | 内容                                                                                                                                                                                                                                     | 主要文件                                                                                       | 验收                                                                                                                                                         | 估时   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **M0 边界**               | 建 `src/kernel`、`src/protocol`、`src/sdk` 骨架；落纯度测试与 ESLint 禁入规则；把 `shared/stage-machine.ts` 与 repository 里的阶段规则搬进 kernel（旧路径 re-export）；单实例锁、WAL/`integrity_check`、事实导出脚本、Electron 打包冒烟  | `kernel/workflow/stage-machine.ts`、`kernel/purity.test.ts`、`host/db.ts`、`eslint.config.mjs` | 行为零变化；`pnpm check` 全绿；kernel 里写 `Date.now()` 或 `import fs` 会让测试失败；打包后 `node:sqlite` 可读写；双开被单实例锁挡住                         | 1–2 天 |
| **M1 账本**               | `facts` 表 + `project` + 事务提交 + `projection_meta` 指纹 + 重建 + `timeline` + `viewSpec` 切片；`tasks/workflows/stages/agents/runtimes` 改为投影；v2 存量按表分批写成 `snapshot.imported`（导入根无 `why`）                           | `kernel/{types,decide,project}.ts`、`host/store/*`、`host/db.ts`                               | 现有任务/阶段/工作流测试全绿；强杀后重启投影一致；1 万事实重建 < 1 s；旧 `repository` 的任务写方法删除；重建后 `run_events` 与 `rules` 可查                  | 3–4 天 |
| **M2 运行生命周期**       | `run.queued/claimed/heartbeat/frames/waiting/abandoned/终态` 全部入账；`runner` 拆成 host 调度 + 执行器接口；租约、退避、启动对账；聊天并入 `purpose='chat'` 的统一执行路径                                                              | `kernel/decide.ts`、`host/{clock,effects,reconcile}.ts`、`host/scheduler.ts`                   | 崩溃恢复：强杀后 `claimed` 被回收、残留子进程被终止、任务可拖动；同运行时并发上限与 FIFO 不变；聊天与阶段执行共用一套测试                                    | 3–4 天 |
| **M3 运行时与执行器插件** | `dsh` 整文件搬为执行器插件；新增 `command` 插件；`plugins/registry.ts`；运行时配置的 `executorKey` 选择插件；`detect` 归插件；新增运行时协议只改插件目录 + registry 一行                                                                 | `plugins/executors/**`、`protocol/runtime.ts`、`host/scheduler.ts`                             | 现有协议帧/终态/取消测试全绿；`detect` 零副作用；新增一个假运行时协议只写插件即跑通；派活始终经智能体                                                        | 2–3 天 |
| **M4 审批与通道**         | `card.*` 事实、`run.waiting`、回答续接、回执解析（`ask/notice/resolve/later/events`）；`in-app` 通道 + `desktop` 通道；挂起期间零进程                                                                                                    | `kernel/cards.ts`、`plugins/channels/**`、`host/notify.ts`                                     | 问答闭环 E2E：等待期间无子进程、无 Token；回答后按会话续接；重复回答拒绝；桌面通知文字只作参数                                                               | 2–3 天 |
| **M5 客户端插件**         | `AppPlugin` 契约；`kernelStore` + `subscribe`；看板/聊天/设置改读内核视图；删除 UI 派生规则与轮询；pomodoro 可发事件                                                                                                                     | `renderer/src/shell/{kernelStore,types}.ts`、`apps/**`、`preload/index.ts`                     | 现有组件测试全绿；看板「执行中」来自内核；同一页面只订阅一次；断线重连按 `seq` 续传                                                                          | 2–3 天 |
| **M6 自动化规则**         | 规则事实 + 设置页规则编辑；规则命中**建任务**到指定工作流/阶段；`manual`/`app` 事件源 + cron 规则（内核 tick）；「Issue 进研发」「每日早报」模板                                                                                         | `kernel/rules.ts`、`plugins/sources/**`、`apps/ai-workflow/components/RulesManager.tsx`        | UI 建一条 cron 规则 → 准时建任务并执行；UI 建 Issue 规则 → 外部事件变成看板任务；非法规则整批拒绝且旧版继续生效；同一 `externalRef` 不重复建卡               | 2–3 天 |
| **M6.5 Thread**           | 线程实体（`threads` 投影 + `thread.*` 事实）；按 `(source, externalRef)` 归并；`reuse-task`/`new-task`；派生式线程上下文；按 `(thread, agent)` 续接；线程并发上限；手工任务隐式线程 + `thread.bind`；任务派生（`parentTaskId` 继承线程） | `kernel/threads.ts`、`host/thread-context.ts`、`protocol/thread.ts`                            | 同一 Issue 多次事件落同一线程；手工任务有隐式线程并可绑定入口；任务派生子任务后线程时间线呈树、并发按 `concurrency` 生效；上下文同事实同文本、超 6000 字截断 | 2–3 天 |
| **M7 可选**               | 外部插件子进程 + 能力授权；`webhook` 通道/来源；跨工作流交接（阶段完成在目标工作流建关联任务）；远端 Worker 执行器（架构位落地）                                                                                                         | `host/plugins/**`、`plugins/channels/webhook/**`、`kernel/workflow/handoff.ts`                 | 只在明确要做时启动；不阻塞主线                                                                                                                               | —      |

累计 ≈ 18–23 人日。M0/M1/M2 是地基，串行；M3 可与 M4 并行；M5 依赖 M2；M6 依赖 M5；M6.5 依赖 M6。

## 文件去向

| 现状                                      | 行数                  | 去向                                                                                             |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `shared/stage-machine.ts`                 | 116                   | `kernel/workflow/stage-machine.ts`（原样）                                                       |
| `main/ai-workflow/engine.ts`              | 118                   | 效果意图 → `kernel/workflow/decide.ts`；写库/入队 → `host/effects.ts`                            |
| `main/ai-workflow/runner.ts`              | 300                   | 调度/租约/退避 → kernel + `host/scheduler.ts`；spawn → 执行器插件                                |
| `main/ai-workflow/chat.ts`                | 234                   | 轮次策略 → kernel（`purpose='chat'`）；执行 → 执行器插件                                         |
| `main/ai-workflow/repository.ts`          | 763                   | SQL 适配 → `host/store/**`；`:418-435,474-492` 的规则外迁 kernel                                 |
| `main/ai-workflow/{schema,migrate,db}.ts` | 298                   | `host/db.ts` + `host/store/schema.ts`；迁移脚本删除，改为格式指纹 + `snapshot.imported`          |
| `main/ai-workflow/ipc.ts` + `preload`     | 241                   | `host/ipc.ts`（三动词）；契约类型进 `src/protocol`                                               |
| `main/ai-workflow/runtime/dsh.ts`         | 890                   | `plugins/executors/dsh/index.ts`（整文件）                                                       |
| `runtime/{process,executable}.ts`         | 240                   | `host/process.ts` + `host/executable.ts`（宿主能力，插件经 sdk 使用）                            |
| `runtime/{registry,detect}.ts`            | 102                   | 删除；由运行时配置的 `executorKey` + `plugins/registry.ts` 与各插件 `detect()` 取代              |
| `shared/ai-workflow-api.ts`               | 366                   | 拆成 `protocol/{commands,views,entities}.ts`                                                     |
| `main/{index,ipc,tray}.ts`                | 162                   | `host/{boot,ipc,tray}.ts`                                                                        |
| `renderer/shell/{types,registry}.ts`      | 28                    | `AppPlugin` 契约 + 插件清单                                                                      |
| `apps/ai-workflow/**`                     | 7188                  | 保留 UI；删派生逻辑（`KanbanBoard.tsx:30,76-106`、`AiWorkflowPage.tsx:82-119`、`RunLog.tsx:13`） |
| `apps/pomodoro/**`                        | 1414                  | 原样保留，补 `events: ['pomodoro.*']`                                                            |
| 全部 `*.test.ts(x)`、`e2e/`               | 约 9k 行（55 个文件） | 跟随改名迁移；随 API 删除的测试可删，但必须有等价覆盖；禁止删断言或改预期                        |

## 必须保住的行为（迁移清单）

来自 `SPEC-ai-workflow.md` 与 `TEST-CASES.md`，逐条验收：

1. 阶段规则只在纯模块；主进程/UI 只提交事件、执行效果。
2. `RUN_FAILED` 打回目标等于当前阶段时零效果、不重建 run、不自动重试。
3. 「执行中」= 存在 queued/claimed/waiting，现算不落库；有活跃 run 时拒绝拖动与完成。
4. 手动拖拽落点即目标，不套用 `on_complete`/`on_reject`。
5. 每次进入阶段重新触发进入效果（SOP 串联）。
6. 同运行时按 `maxConcurrent` 限流、全局 FIFO、多运行时并行。
7. 终态归一表与 9 个 `errorCode` 语义不变。
8. 取消时序：cancel 帧 → 3 s → SIGTERM → 2 s → SIGKILL；Windows `taskkill /T /F`；超时 30 分钟同流程。
9. 探测：`ready` 需 `v=1`/`protocol_version=1`/`runtime=dsh`；`create` 先探测失败不落库；`update` 保存后重探；`detect` 只读。
10. 聊天：续接只发新消息、`resume_rejected` 用完整历史重试一次、同一对话只跑一轮。
11. `run_events` 的 `(run_id,seq)` 唯一、按 seq 排序、`output` = text 汇总。
12. v2 迁移保留数据：运行时补默认值、失败 run 归 `exit_nonzero`、`user_version` 语义等价。
13. 契约只许新增；写操作触发变更通知；聊天输出走独立通道。
14. UI 硬性行为：配置只在设置、新建才弹表单、看板无执行按钮、失败弹窗保持打开。
15. 质量门禁不放松：覆盖率阈值、`stage-machine` 分支 100%、改动行 ≥ 90%。
16. renderer 禁 import electron/Node；main 禁 import renderer。

## 风险

| 风险                                                               | 影响 | 对策                                                                          |
| ------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------- |
| 过渡期双写导致数据分叉                                             | 高   | 表变投影时同步删除旧写路径；禁止 `INSERT INTO tasks` 绕过事实                 |
| 约 9k 行测试与 mock 面重写（组件测试直接赋值 `window.aiWorkflow`） | 高   | 先改契约再改组件；`kernelStore` 提供测试替身；逐文件迁移，不批量删除          |
| 重建性能超出预期                                                   | 中   | `viewSpec` 按需切片；投影裁剪 180 天前已完成 run；重建进 CI 预算              |
| `node:sqlite` 在 Electron 45 打包行为未验证                        | 中   | M0 就做打包冒烟，不通过则暂停 M1                                              |
| 插件边界被逐步侵蚀                                                 | 中   | 纯度测试 + 禁止 import 扫描 + 每次 review 对照「边界守则」                    |
| 个人数据丢失                                                       | 高   | M1 前备份 `ai-workflow.db`；`snapshot.imported` 幂等；提供「从事实导出 JSON」 |
| 迟到回执 / 僵尸进程覆盖终态                                        | 高   | `leaseId + turn` 校验丢弃旧 attempt；宿主兜底写终态；对账先杀子进程再记账     |
| 线程上下文膨胀或藏注入                                             | 中   | 派生 + 6000 字截断；笔记/事件只进资料段；「同事实同文本」单测                 |
| M2 期间崩溃恢复语义变化                                            | 中   | 保留旧 runner 一版做对照测试；恢复用例逐条跑                                  |

## 每阶段退出条件

`pnpm check` 全绿 + 覆盖率不低于基线 + 该阶段新增测试通过 + 迁移清单对应项有测试证据 + 一次手动验收（真 CLI 跑一轮）。

## 不做什么

多窗口、云同步/多用户、外部插件开放执行、MCP 注入、远端 Worker 实现、成本看板、任务依赖图、审批意见流。
