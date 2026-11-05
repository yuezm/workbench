# 重构计划：内核 + 插件

> 依据 [ARCHITECTURE.md](../ARCHITECTURE.md) 与三份新 Spec。目标：**行为不回退、真相源唯一、扩展只改插件**。
> 起点：现有 ai-workflow 功能可用、`pnpm check` 全绿（覆盖率 99.60/96.68/99.39/99.79）。

## 总原则

1. **一次只换一层。** 先立边界，再搬纯逻辑，再换账本，最后拆插件。
2. **过渡期不允许双真相源。** 表变投影的那一刻，旧写路径同时删除；禁止「先双写、以后再删」。
3. **行为规格不重写。** `SPEC-ai-workflow.md` 的阶段语义、终态归一、取消时序、迁移规则全部保留；测试跟着搬家。允许随 API 删除而删除的测试，但必须先有等价覆盖；禁止为过关删断言或改预期。
4. **回滚分两层。** 代码与分支可丢弃；但 M1 之后数据层不可回退（事实日志只追加、投影已重写），回滚要恢复数据库备份。M1 前先做一次全量备份并验证可读。

## 里程碑

| 阶段                              | 内容                                                                                                                                                                                                                                     | 主要文件                                                                                       | 验收                                                                                                                                                         | 估时   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **M0 边界** ✅ 2026-11-04         | 建 `src/kernel`、`src/protocol`、`src/sdk` 骨架；落纯度测试与 ESLint 禁入规则；把 `shared/stage-machine.ts` 与 repository 里的阶段规则搬进 kernel（旧路径 re-export）；单实例锁、WAL/`integrity_check`、事实导出脚本、Electron 打包冒烟  | `kernel/workflow/stage-machine.ts`、`kernel/purity.test.ts`、`host/db.ts`、`eslint.config.mjs` | 行为零变化；`pnpm check` 全绿；kernel 里写 `Date.now()` 或 `import fs` 会让测试失败；打包后 `node:sqlite` 可读写；双开被单实例锁挡住                         | 1–2 天 |
| **M1 账本** ✅ 2026-11-04         | `facts` 表 + `project` + 事务提交 + `projection_meta` 指纹 + 重建 + `timeline` + `viewSpec` 切片；`tasks/workflows/stages/agents/runtimes` 改为投影；v2 存量按表分批写成 `snapshot.imported`（导入根无 `why`）                           | `kernel/{types,decide,project}.ts`、`host/store/*`、`host/db.ts`                               | 现有任务/阶段/工作流测试全绿；强杀后重启投影一致；1 万事实重建 < 1 s；旧 `repository` 的任务写方法删除；重建后 `run_events` 与 `rules` 可查                  | 3–4 天 |
| **M2 运行生命周期** ✅ 2026-11-05 | `run.queued/claimed/heartbeat/frames/waiting/abandoned/终态` 全部入账；`runner` 拆成 host 调度 + 执行器接口；租约、退避、启动对账；聊天并入 `purpose='chat'` 的统一执行路径                                                              | `kernel/decide.ts`、`host/{clock,effects,reconcile}.ts`、`host/scheduler.ts`                   | 崩溃恢复：强杀后 `claimed` 被回收、残留子进程被终止、任务可拖动；同运行时并发上限与 FIFO 不变；聊天与阶段执行共用一套测试                                    | 3–4 天 |
| **M3 运行时与执行器插件**         | `dsh` 整文件搬为执行器插件；新增 `command` 插件；`plugins/registry.ts`；运行时配置的 `executorKey` 选择插件；`detect` 归插件；新增运行时协议只改插件目录 + registry 一行                                                                 | `plugins/executors/**`、`protocol/runtime.ts`、`host/scheduler.ts`                             | 现有协议帧/终态/取消测试全绿；`detect` 零副作用；新增一个假运行时协议只写插件即跑通；派活始终经智能体                                                        | 2–3 天 |
| **M4 审批与通道**                 | `card.*` 事实、`run.waiting`、回答续接、回执解析（`ask/notice/resolve/later/events`）；`in-app` 通道 + `desktop` 通道；挂起期间零进程                                                                                                    | `kernel/cards.ts`、`plugins/channels/**`、`src/main/notify.ts`                                 | 问答闭环 E2E：等待期间无子进程、无 Token；回答后按会话续接；重复回答拒绝；桌面通知文字只作参数                                                               | 2–3 天 |
| **M5 客户端插件**                 | `AppPlugin` 契约；`kernelStore` + `subscribe`；看板/聊天/设置改读内核视图；删除 UI 派生规则与轮询；pomodoro 可发事件                                                                                                                     | `renderer/src/shell/{kernelStore,types}.ts`、`apps/**`、`preload/index.ts`                     | 现有组件测试全绿；看板「执行中」来自内核；同一页面只订阅一次；断线重连按 `seq` 续传                                                                          | 2–3 天 |
| **M6 自动化规则**                 | 规则事实 + 设置页规则编辑；规则命中**建任务**到指定工作流/阶段；`manual`/`app` 事件源 + cron 规则（内核 tick）；「Issue 进研发」「每日早报」模板                                                                                         | `kernel/rules.ts`、`plugins/sources/**`、`apps/ai-workflow/components/RulesManager.tsx`        | UI 建一条 cron 规则 → 准时建任务并执行；UI 建 Issue 规则 → 外部事件变成看板任务；非法规则整批拒绝且旧版继续生效；同一 `externalRef` 不重复建卡               | 2–3 天 |
| **M6.5 Thread**                   | 线程实体（`threads` 投影 + `thread.*` 事实）；按 `(source, externalRef)` 归并；`reuse-task`/`new-task`；派生式线程上下文；按 `(thread, agent)` 续接；线程并发上限；手工任务隐式线程 + `thread.bind`；任务派生（`parentTaskId` 继承线程） | `kernel/threads.ts`、`host/thread-context.ts`、`protocol/thread.ts`                            | 同一 Issue 多次事件落同一线程；手工任务有隐式线程并可绑定入口；任务派生子任务后线程时间线呈树、并发按 `concurrency` 生效；上下文同事实同文本、超 6000 字截断 | 2–3 天 |
| **M7 可选**                       | 外部插件子进程 + 能力授权；`webhook` 通道/来源；跨工作流交接（阶段完成在目标工作流建关联任务）；远端 Worker 执行器（架构位落地）                                                                                                         | `host/plugins/**`、`plugins/channels/webhook/**`、`kernel/workflow/handoff.ts`                 | 只在明确要做时启动；不阻塞主线                                                                                                                               | —      |

累计 ≈ 18–23 人日。M0/M1/M2 是地基，串行；M3 可与 M4 并行；M5 依赖 M2；M6 依赖 M5；M6.5 依赖 M6。

## M0 退出记录（2026-11-04）

- 分支：`refactor/m0-boundary`（T1/T2，已合并进 `master`，tip `33e22e8`）+ `refactor/m0-exit`（T3–T9 收尾）。
- 证据：`pnpm check` 全绿（58 文件 / 569 用例；覆盖率 99.60/96.71/99.39/99.79 不低于基线，改动行 100%）；`pnpm e2e` 5/5（每条用例独立临时 userData）；`pnpm e2e:packaged` 1/1（打包进程内 node:sqlite 建表/写入/读回）；打包产物双开实测第二次 129ms 退出、首实例存活。
- 数据：备份 `%APPDATA%\workbench\backups\ai-workflow-2026-11-04T1940-pre-m1.db`（与源库 sha256 相同、`integrity_check=ok`、9 表 125 行）+ 同目录 JSON 导出，作为 M1 回滚点。
- 已知口径：打包进程内置 Node 为 24.22.1（Electron 45.1.0）；`src/sdk` 仍未创建，推迟到 M1 首个消费者。
- 任务级证据与偏差记录见 [tasks/todo.md](../../tasks/todo.md) 与 [tasks/plan.md](../../tasks/plan.md)。

## M1 开工记录（2026-11-04）

- 分支 `refactor/m1-ledger`，起点 `master` @ `2212a59`；实施计划与任务清单见 [tasks/m1-plan.md](../../tasks/m1-plan.md)、[tasks/m1-todo.md](../../tasks/m1-todo.md)。
- 范围口径：M1 投影集 = `tasks` / `workflows` / `workflow_stages` / `agents` / `runtimes`；`runs` / `run_events` / 聊天表保持直接写（M2 再入账）；`rules` 事实归属 M6，本阶段不适用「重建后 `rules` 可查」。
- 回滚点：`%APPDATA%\workbench\backups\ai-workflow-2026-11-04T1940-pre-m1.db`（+ 同目录 JSON 导出）。

## M1 退出记录（2026-11-04）

- 提交：`af85c38`（host 基础设施）→ `7f12784`（protocol）→ `ca56322`（kernel decide/project）→ `ab449a3`（store）→ `075edfc`（存量导入，删 `migrate.ts`）→ `7865ba6`（写路径切换）→ `5a23f60`（覆盖率收口）→ `f01240b`（账本专项测试）→ `6d043ed`（启动顺序）。
- 证据：`pnpm check` 全绿（78 文件 / 772 用例；覆盖率 99.71/97.59/99.52/99.85，改动行 948/948 = 100%）；`pnpm e2e` 5/5；`src/host/store/rebuild.perf.test.ts` 1 万事实重建实测 82.5–152.2 ms。
- 真实库验收：M0 备份库启动 M1 应用 → 5 条 `snapshot.imported`（seq 1–5）、投影与运行/聊天表行数与备份一致（tasks 1 / runs 15 / workflows 1 / stages 3 / agents 1 / runtimes 1 / chat 1+4 / run_events 98）。
- 写路径：生产代码五表 `INSERT` 只在 `src/host/store/projection-apply.ts`；`repository` 旧写方法与 `engine.ts` 已删除；`main` 不再直写业务表。
- 已知边界：重建后 `runs` 可能残留（不在投影集，M2 消除）；`agents.remove` 被对话引用时错误文案退化为 SQLite FK 原文；`decide.ts` 三处公共入口不可达的防御分支不计覆盖率。

## 测试目录重组（2026-11-04）

- 范围：`src/**` 下的 87 个 `*.test.ts(x)` 与 3 个测试夹具（`host/store/{test-support,fake-kernel}.ts`、`main/ai-workflow/test-support.ts`）搬到 `tests/`，与 `src/` **同构镜像**；`e2e/`、`e2e-packaged/` 搬到 `tests/e2e`、`tests/e2e-packaged`。`src/` 只剩产品代码。
- 门禁同步：vitest `include` 指向 `tests/**`；tsconfig node/web 双工程按层收编 `tests/`；ESLint 架构边界规则（renderer 禁 Electron/Node、main 禁 import renderer）同样覆盖 `tests/` 对应层，强度不因搬家下降；Playwright 两个 `testDir` 指向 `tests/e2e*`；`floor-guard` 增加「src→tests 迁移识别」，避免一次性提交把搬家误判成删测试。
- 证据：`pnpm check` 全绿（78 文件 / 772 用例；覆盖率 99.71/97.59/99.52/99.85，与基线逐项相同；改动行无变更故跳过）；`pnpm e2e` 5/5。行为零变化，只改位置与导入路径。

## M2 开工记录（2026-11-04）

- 分支 `refactor/m2-lifecycle`，起点 `master` @ `20c84b6`（M1 退出 + 测试目录重组后）；实施计划与任务清单见 [tasks/m2-plan.md](../../tasks/m2-plan.md)、[tasks/m2-todo.md](../../tasks/m2-todo.md)。
- 范围口径：`runs` / `run_events` / 聊天表改为事实投影（`run.*`、`conversation.*`、`message.appended`）；存量按 `snapshot.imported` 分批迁移；`runner` 拆 `host/scheduler` + 注入执行器接口；租约/退避/启动对账；聊天并入 `purpose='chat'`。`card.*` 投递与回答留 M4，卡片闭环前执行适配层不产 `ask`；`src/plugins`/`src/sdk` 留 M3，IPC 三动词与 `commandId` 幂等留 M5。
- 待评审口径（m2-plan「架构决议 D1–D15」）：投影新增 `waiting` 并顺带改 2 处 UI 状态映射；`executor_lost` 作为第 10 个 errorCode；超时走 `clock.tick`；`run_events` 用 `<runId>:<seq>` 全局 seq；帧超限分包；聊天补齐 conversations/messages 投影；新增 `run.receipt_rejected`/`run.removed`/`run.host_settled` 事实与宿主私有 `process_registry` 表。D4/D7/D10/D13/D14 需先修订 SPEC 再实现。
- 回滚点：开工前 `pnpm db:export` 备份；M2 改写投影格式（`KERNEL_VERSION→m2.0.0`），回滚到 M1 需恢复数据库备份并重建。

## M2 退出记录（2026-11-05）

- 提交链：`de59c01`（契约/投影/存量迁移/View）→ `c7a25f5`（回执终态/退避超时/执行器端口/进程层搬迁）→ `9292137`（clock）→ `961f404`（进入效果入内核 + scheduler/effects 接线）→ `3fe037b`（启动对账/进程登记）→ `f8d3721`（帧批量/聊天内核化/取消链路）→ `7bf0707`（聊天并入 run + 旧表清理）→ `e690a8f`（覆盖率）→ `00e7115`（读路径收口/仓库层删除/测试搬家）。
- 证据：`pnpm test` 84 文件 / 984 用例；`pnpm check` exit 0（覆盖率 99.73/97.78/100/100，改动行 1024/1031 = 99.32%）；`pnpm e2e` 6/6（含新增崩溃恢复用例）；M1 真实库副本升级后 `runs` 15 / `run_events` 98 逐行保留，7 张导入根 + 重建后逐表全等。
- 真 CLI 验收（M1 真实库副本，未写真实数据）：阶段执行 `succeeded` / 输出 `PONG` / 3.4 s；聊天一轮 `PONG` / 4.5 s。
- 写路径：生产代码 `INSERT/UPDATE/DELETE runs|run_events` 只在 `src/host/store/projection-apply.ts`；`repository.ts`、`runner.ts`、`ChatService`、`shared/stage-machine.ts` 已删除；聊天与阶段共用 scheduler/执行器端口。
- 已知边界：`run.waiting` 只落事实与投影，卡片投递/回答闭环在 M4；`commandId` 幂等留 M5；`resume_rejected` 重试在 M2 执行器适配层（M3 搬 dsh 插件）；旧库一次性升级/聊天迁移为兼容层，M3 首启后再删；`scheduler` 少量防御性早退分支未覆盖（公共路径不可达）。
- 评审修复（2026-11-05，合并前）：补 `task.remove` / `workflow.remove` 的 `runs` 视图切片——此前 `run.removed` 只写契约、生产路径永不产出，删除任务后 `rebuild` 会复活 orphan run（违背 D13）；调度器在领取 / 收尾 / 取消后 `clock.rearm()`——此前定时器只在启动时排一次，启动后才出现的租约与超时永不触发回收；`run.cancelRequested` 的运行在租约过期时直接落 `run.cancelled`，不再重排执行；打包冒烟断言改为 M2 schema（旧断言要求已被删除的 `chat_*` 表）；`SPEC-ai-workflow` / `SPEC-kernel` 同步聊天执行路径、数据模型与提示词拼装口径。修复后 `pnpm check` exit 0、`pnpm e2e` 6/6、覆盖率 99.74/97.78/100/100（改动行 1035/1042 = 99.33%）。
- 打包门禁复核（2026-11-05）：`tests/e2e-packaged` 的仓库根路径少一级、表清单仍断言旧 `chat_*` 表，两处已修；但 electron-builder 产出的 `Workbench.exe` 在本机启动即崩（`--version` 同样 0x80000003，dev Electron 45.1.0 正常），与 M2 代码无关，待工具链（electron-builder / asar 完整性）排查后再恢复该门禁。
- 任务级证据与偏差见 [tasks/m2-todo.md](../../tasks/m2-todo.md) 与 [tasks/m2-plan.md](../../tasks/m2-plan.md)。

## M3 开工记录（2026-11-05）

- 分支 `refactor/m3-executors`，起点 `master` @ `831f2dd`；实施计划与任务清单见 [tasks/m3-plan.md](../../tasks/m3-plan.md)、[tasks/m3-todo.md](../../tasks/m3-todo.md)，测绘证据见 `tasks/recon/m3-{dsh,runtime-config,gates}.md`。
- 范围口径：`executorKey` 取代 `protocolFamily`（`runtimes` 表 12-step 升级 + `normalizeRuntime` + `KERNEL_VERSION=m3.0.0` 首启重建）；新增 `src/sdk` 最小能力面（log/now/paths/config/process.spawn+resolve+killTree+scanDirs）；新增 `src/plugins/{manifest,registry,shared,executors/dsh,executors/command}`；`detect` 归插件；`ExecutorBackend` 适配层删除、`resume_rejected` 重试留宿主；未知执行器落 `runtime_missing` 终态，不新增 errorCode。`card.*`/通道留 M4，IPC 三动词与 `kernelStore` 留 M5，`command` 插件归 M3b 可后置。
- 回滚点：开工前已复制 `%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1055-pre-m3.db`（sha256 与源库一致、`integrity_check=ok`、9 表 125 行）并导出同目录 JSON。**该实库仍是 M1 之前的 v2 格式（无 `facts` 表）**，M3 首启会走 `host/store/import.ts` 兼容层，因此本阶段不删 M2 兼容层（删除条件写入 M3 退出记录）。
- 待评审口径：m3-plan「架构决议 D1–D14」与「开放问题」5 条（`executorKey` 取代方案、`supported` 语义、`command` 插件范围、兼容层去留、新 RPC 通道）。评审结论：方案 A、先做 M3a、`command` 插件归 M3b、兼容层本轮不删。

## M3 进展记录：M3a 完成（2026-11-05）

- 提交链：`d8ca5fe`（executorKey 取代 protocolFamily + runtimes 结构升级/归一）→ `8d135f3`（sdk 能力面与宿主注入）→ `8c75e6c`（插件注册表 + dsh 执行器插件搬迁）→ `1a1666f`（插件边界 ESLint/floor-guard/注册表测试）→ `97ecd6e`（调度器按 executorKey 取端口、删除旧执行链）→ `1859883`（包装用例补断言）→ `ca7644f`（假协议端到端验收）→ `68ce59c`（覆盖率收口）。
- 证据：`pnpm check:fast` 绿；`npx vitest run --coverage` 89 文件 / 1044 例全绿，覆盖率 **99.85 / 98.11 / 100 / 100**（基线 99.73/97.78/100/100）；`node scripts/floor-guard.mjs` clean；改动行覆盖率待 T13 用 `check:diffcov` 复核。
- 行为等价：dsh 59 例断言逐例保留（只换 import 与 fakeSdk 夹具），`timeout` 折成 `failed + errorCode='timeout'`；`resume_rejected` 重试与聊天失败文案留在 `host/executor.ts` 包装层；取消时序、probe 三判据、pid 上报、stderr 截尾不变。
- 结构：`src/main/ai-workflow/runtime/**` 与 `executor-port.ts` 删除，`src/main` 只剩 `ipc.ts`；新增 `src/sdk/{types,index}.ts`、`src/host/{sdk-host,executor-registry}.ts`、`src/plugins/{manifest,registry,shared,executors/dsh}`；`runtimes` 表 12-step 升级 + `normalizeRuntime`，`KERNEL_VERSION=m3.0.0`。
- 关键口径落地：未注册 `executorKey` → 调度器兜底 `runtime_missing`（不新增 errorCode）；`DetectedRuntime` 保留 `supported`（语义=registry 是否有该执行器）；dsh manifest capabilities 由 SPEC 草案的 `['spawn','fs.read']` 收窄为 `['spawn']`（sdk 无 fs 面，boundary 门禁要求声明↔用法一致）；假协议验收用例放 `tests/host/acceptance.test.ts`（避免给 `tests/plugins` 放宽 ESLint 豁免）。
- 交接：M3b/M3c（detect 归插件、运行时表单执行器选择与 `runtimes.executors`、`command` 插件与 `argsTemplate`、`check:diffcov`/真 CLI/SPEC 修订）已完成，见下节 M3 退出记录。M2 兼容层按评审结论保留，删除条件写入退出记录。

## M3 退出记录（2026-11-05）

- 提交链：M3a 见上节；M3b/M3c `c45b3ff`（detect 归插件 + 只读执行器清单 + IPC/preload/shared 接线 + detect 测试搬家）→ `be0bba6`（`command` 插件与 `argsTemplate` 展开；同批带入 `SPEC-plugins.md` 的部分在途文档改动）→ `1da37c4`（运行时表单执行器选择 + 参数模板 + 角标 label）→ `8413248`（detect 汇总分支用例收口）→ `e84bb5b`（SPEC / ARCHITECTURE / CAPABILITY-MAP 修订）→ 本记录提交。
- 门禁证据：`pnpm check` exit 0；`pnpm test` 91 文件 / 1097 用例；覆盖率 **99.81 / 97.92 / 100 / 100**（基线 99.73 / 97.78 / 100 / 100）；`check:diffcov` **693/695 = 99.71%**（门槛 90%）；`pnpm e2e` **6/6**；`check:floor` / `check:secrets` clean；`pnpm audit` 生产依赖 0 漏洞。
- 真 CLI 验收（dsh 0.2.1-rc.5 / profile `multica`，v2 真库副本、未写真实数据）：阶段执行 `succeeded` / `PONG` / 4.0 s（复跑 7.0 s）；聊天一轮 `succeeded` / `PONG` / 5.5 s（复跑 4.0 s）；执行中取消 → `cancelled` / `errorCode=cancelled` / 取消到终态 2.0 s（cancel 帧后进程自行退出，未触发 SIGKILL 兜底）。
- 老库两份副本：① v2 真库副本升级后 `facts=9`、`runs=15`、`run_events=98`、旧聊天 1 对话 + 4 消息逐行保留、`runtimes.executor_key='dsh'`、`last_probe_json` 原样、`integrity_check=ok`；② M2 格式副本（M2 代码把同一 v2 副本导入/重建生成）由 M3 打开：`import=false`、`rebuild=true`、`executor_key='dsh'`、`lastProbe` 保留、facts / runs / run_events 不变、旧聊天表 0 张。
- 新增能力：`detect` 归插件（`src/plugins/shared/cli-catalog.ts` + 各插件 `detect()`；`registry.detectAll` 串行、单插件 2 s 超时、失败隔离、同 command 先到先得、未注册插件 CLI 以 `supported:false` 列出）；只读 IPC `runtimes.executors()`；运行时表单执行器下拉 + `argsTemplate` 文本域；`command` 插件（`{prompt}` 只作独立 argv 元素或走 stdin、Windows `.cmd/.bat` 固定 `cmd.exe /c` 包装、`shell:false`）。
- 边界与写作用域：执行器协议新增仍只改 `src/plugins/executors/<id>/` + registry 一行（`tests/host/acceptance.test.ts` 假协议端到端为证）；`src/main/ai-workflow/runtime/**` 删除。
- 兼容层（D9）：M3 不删 `host/store/import.ts`（实库仍是 v2）。删除条件：真实库首启一次、`facts` 非空、删后复测重建等价；列为 M3 之后独立清理任务。
- 已知边界与偏差：`card.*` / 通道在 M4；IPC 三动词与 `commandId` 幂等留 M5；`command` 插件只有单测、真 CLI 只覆盖 dsh；`supported:false` 提示文案未改（三态行为不变）；打包冒烟沿用 M2 已知问题（electron-builder 产物启动崩溃）；`SPEC-plugins.md` 部分改动随 `be0bba6` 提交而非独立文档提交；M2 格式库由 M2 代码生成（历史备份只有 v2 格式）；`command` 的 Windows 判定不读 `process.platform`（按 resolve 路径形态 + 后缀，插件无 Node 全局）。
- 回滚点：`%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1055-pre-m3.db`（+ JSON）；回滚需恢复该库并重建投影。
- 下一步：M4 卡片投递与回答闭环（`card.*` + 通道）；之后 M5 IPC 三动词与 `kernelStore`。

## M4 开工记录（2026-11-05）

- 分支 `refactor/m4-cards`，起点 `master` @ `3d0c40d`；实施计划与任务清单见 [tasks/m4-plan.md](../../tasks/m4-plan.md)、[tasks/m4-todo.md](../../tasks/m4-todo.md)，测绘证据见 `tasks/recon/m4-{kernel,host,gates}.md`。
- 范围口径：`cards` 成为第 10 张投影表；6 条 `card.*` 事实（整行 `card: Card` payload）；`card.answer` / `card.resolve` 命令与 `card.delivered` / `card.delivery_failed` 两条宿主输入；`cards.open` / `cards.byRun` / `runs.waiting` 视图；`event.received` / `event.dropped` 只入账（规则建任务留 M6）；`in-app` / `desktop` 通道与 `sdk.notify`；无卡 waiting 的启动对账兜底；`KERNEL_VERSION=m4.0.0`。
- 评审结论（5 条）：回执块 = 输出里最后一个 ```json 围栏块（含 `ask/notices/resolves/later/events` 任一键）；多项 `ask` **全部答完才续接**；`cards.delivery` 单列 = 已送达至少一个通道；最小 UI = 顶部待审批条；E2E 用夹具执行器 + 真 CLI 手工一轮。
- 回滚点：`%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1720-pre-m4.db`（sha256 `8791DDDA…9AA48F8D` 与源库一致、`integrity_check=ok`、`user_version=2`、9 表 125 行；未另生成 JSON 导出）。**实库仍是 M1 之前的 v2 格式**，首启走 `host/store/import.ts` 兼容层；兼容层本轮仍不删（删除条件沿用 M3 记录）。

## M4 退出记录（2026-11-05）

- 提交链：`8945e92`（计划/测绘/SPEC）→ `9463282`（卡片契约与投影骨架）→ `c0ae5e6`（内核卡片闭环）→ `54d37d9`（cards 读写与无卡 waiting 对账）→ `4561567`（回执块解析）→ `b1a465e`（sdk notify）→ `a3253af`（通道宿主 + in-app/desktop 插件）→ `fda7b91`（IPC + 待审批条）→ `cf8affe`（通道契约测试）→ `36855ea`（审批 E2E）→ `e68340d`（覆盖率）→ 本记录提交。
- 门禁：`pnpm check` exit 0；101 文件 / 1283 用例；覆盖率 **99.85 / 98.12 / 100 / 100**（基线 99.81/97.92/100/100）；`check:diffcov` **496/496 = 100%**；`pnpm e2e` **8/8**；`check:floor` / `check:secrets` clean；`pnpm audit` 生产依赖 0 漏洞。
- 卡片闭环 E2E（`tests/e2e/approval.spec.ts`）：种子 waiting run + open card，启动后 `lease_id` / `lease_until` / `deadline_at` / `usage_json` 全空、`process_registry` 0 行、`run_events` 0；`cards.open` 可读；回答后 `turn=2`、同 `session_id`、`status='queued'`；重复回答被拒且事实不增；投递 `pending → delivered(ref='in-app')` 不改等待态。
- 真 CLI 验收（dsh 0.2.1-rc.5 / profile `multica`，实库副本 + 临时 workdir）：阶段执行 `running` → `waiting`（回执块 `ask` 建卡并 delivered）→ 经桥回答 → `running` → `succeeded`；两轮同一 `sessionId`（续接）、`turn=2`、usage 232/180，等待期无子进程。
- 老库副本冒烟：实库副本首启导入 9 条 `snapshot.imported`；`facts=9`、`runs=15`、`run_events=98`、1 对话 + 4 消息、1 任务逐项保留；`runtimes.executor_key='dsh'`、`lastProbe` 保留；`cards=0`、`integrity_check=ok`、`projection_meta` 写入 m4 指纹。
- 写路径：`cards` 的 INSERT/UPDATE/DELETE 只在 `host/store/projection-apply.ts`；投递与回答只经事实（`card.delivered` / `card.delivery_failed` 是宿主输入）；run 删除时显式联删 cards（重建事务 FK OFF 下增量与重建逐表等价）。
- 已知边界与偏差：回执块「解析失败只重写最后一条回复、上限 2 次」留 M6（需要额外 execute 帧与模型调用；M4 只保证非法块不生效）；`cards.delivery` 是单列语义（首个成功通道写 `deliveryRef`，in-app 通常先 ack）；`Sdk.notify` 返回 void，平台层失败只日志、desktop 通道以抛错表达失败；`event.received` / `event.dropped` 无投影，规则建任务留 M6；`answerPrompt` 取该 run 全部已答卡（Card 无批次字段，单 waiting 批次等价）；`notices` 信息卡不阻塞续接；`src/main/notify.ts` 取代原计划的 `host/notify.ts`（host 不 import electron）；M2 兼容层不删（实库仍 v2）；electron-builder 打包冒烟仍未恢复（M2 已知问题）；`scheduler` 5 处竞态防御分支与 `RuntimeDialog` / `select` 两处 UI 不可达分支未覆盖。
- 回滚点：`%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1720-pre-m4.db`；回滚需恢复该库并重建投影（`cards` 表为空，兼容层可再次导入）。
- 下一步：M5 客户端插件（`AppPlugin` 契约、`kernelStore` + `subscribe`、IPC 三动词与 `commandId` 幂等）。

## M5 开工记录（2026-11-05）

- 分支 `refactor/m5-client`，起点 `master` @ `337667f`（M4 已 fast-forward 合入 `master`）；实施计划与任务清单见 [tasks/m5-plan.md](../../tasks/m5-plan.md)、[tasks/m5-todo.md](../../tasks/m5-todo.md)。
- 范围口径：IPC 收敛为 `dispatch / query / subscribe` 三动词（`window.aiWorkflow` 与 `src/main/ai-workflow/ipc.ts` 删除）；`commands` 非投影表做 `commandId` 幂等（同事务按事实区间回放，reject 不缓存，编排命令由命令路由二次校验）；聊天动作从宿主输入升为 `chat.*` 命令并新增 `chat.cancel`；`app.event` 命令 + `src/shared/apps.ts` 白名单；`runtime.probe` 编排命令；新增视图 `tasks.executing` / `runtimes.statuses` / `kernel.seq` 与宿主视图 `runtimes.executors` / `runtimes.detected` / `runtimes.models`；`host/feed` 事实批次（≤500 条或 16 ms）与聊天流旁路；renderer `kernelStore`（先订阅后快照、按 seq 续传、失效重取、单订阅）+ `useKernelView` / `useKernelViewState`；`AppDefinition` 更名 `AppPlugin` 并支持 `events`；pomodoro 发 `pomodoro.completed`。
- 评审口径（开工即定，见 m5-plan「评审口径」）：聊天命令命名 `chat.*`；宿主仅编排 `runtime.create/update/probe` 与删除前置取消；app 事件只入账不派活；`KERNEL_VERSION` 不递增（投影语义未变）；测试用假 transport / 假执行器。
- 回滚点：沿用 M4 备份 `%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1720-pre-m4.db`；M5 不改投影表与 `KERNEL_VERSION`，回滚只需切回 `master` 代码（`commands` 表可留，旧代码不读它）。

## M5 退出记录（2026-11-05）

- 提交链：`3ae3635`（计划/任务清单）→ `eeefced`（三动词契约、聊天命令化、app 事件与内核分支）→ `6fad6a4`（kernelStore 快照续传、AppPlugin 契约、shell 测试替身）→ `f19da18`（命令路由/幂等/宿主视图、事实批次 feed、main/preload 接线、宿主测试迁移）→ `5ef7936`（看板/聊天/设置/番茄迁移、e2e 适配）→ 本记录提交。
- 门禁：`pnpm check` exit 0；105 文件 / 1330 用例；覆盖率 **99.89 / 98.18 / 100 / 100**（基线 99.85 / 98.12 / 100 / 100）；`check:diffcov` **565/565 = 100%**；`pnpm e2e` **8/8**；`check:floor` / `check:secrets` clean；`pnpm audit` 生产依赖 0 漏洞。
- IPC 表面：`window.workbench` 只剩 `dispatch / query / subscribe / notify`；`window.aiWorkflow`、`AI_WORKFLOW_*`、`src/shared/ai-workflow-api.ts`、`src/main/ai-workflow/ipc.ts`、`apps/ai-workflow/api.ts` 全部删除。应答走 `{ok,value|error}` 信封，preload 解包失败抛可读 Error。
- 幂等：`commands` 非投影表（`command_id / first_seq / fact_count / at`）在 `store.dispatch` 同一事务内记录；命中按事实区间回放、零新事实；reject 不缓存；零事实命令也记录；重建不清表。编排命令（`runtime.create/update/probe`）由 `host/commands` 先探测再落事实，同 `commandId` 命中不重复探测。
- 读路径：DB 视图新增 `tasks.executing`（看板「执行中」只读它）、`runtimes.statuses`、`kernel.seq`；宿主视图 `runtimes.executors / runtimes.detected / runtimes.models` 走同一 `query` 动词（装配根注入，只读、不写库、不发失效）。
- 推送与客户端：`host/feed` 按 ≤500 条或 16 ms 合并事实批次（`{kind:'facts',seq,types}`），聊天流 `stream / stream-end` 即时旁路；`kernelStore` 启动先 subscribe 缓冲 → `kernel.seq` 快照 → 回放 `seq >` 快照；按事实类型失效、视图按需重取、整窗单订阅；`useKernelView` / `useKernelViewState`（`params=null` 表示暂不订阅）；`AppPlugin` 带 `events`，pomodoro 完成发 `pomodoro.completed`（宿主按 `APP_EVENTS` 白名单校验，产 `event.received`）。
- 性能/行为：看板不再逐任务拉 `runs.listByTask` 现算执行中；RunLog 删除 1 s 轮询（`run.events` 视图随失效刷新）；聊天流按 `conversationId` 过滤，`end` 后由消息视图失效收尾。
- 已知边界与偏差：编排命令回放只回放「首次落库的内核事实」（探测事实不回放，`value` 仍取当前投影行，避免重复探测）；`chat.cancel` 对未知对话由内核 `reject not_found`（旧 RPC 入口静默，renderer 只对现存会话调用）；宿主视图不发失效推送（只按需 query，不进 kernelStore 缓存）；`select` 定位与 `WorkflowManager` 关闭弹窗两处防御分支改为「调用方保证」；`scheduler` 5 处竞态防御分支仍未覆盖（公共路径不可达）；`api.d.ts` 只声明 `window.workbench`；M2 兼容层不删（实库仍 v2）；electron-builder 打包冒烟仍未恢复（M2 已知问题）。
- 回滚点：无投影表/`KERNEL_VERSION` 变化，回滚 = 切回 `master` 代码；`commands` 表可保留（旧代码不读），需要彻底回退时删表即可。
- 下一步：M6 自动化规则（规则事实 + 设置页编辑、`app`/`manual` 事件源 + cron、Issue 进研发与每日早报模板）。

## M6 开工记录（2026-11-05）

- 分支 `refactor/m6-rules`，起点 `master` @ `2f06970`（M5 已 fast-forward 合入）；实施计划与任务清单见 [tasks/m6-plan.md](../../tasks/m6-plan.md)、[tasks/m6-todo.md](../../tasks/m6-todo.md)。
- 范围口径：`rule_sets` / `rule_fires` 两张新投影表（单行规则集 + 触发记录），`rules.replaced` / `rule.fired` 两条事实；`rules.replace` 整批替换（版本 +1，非法整批拒绝）与 `rule.trigger` 手动运行命令；宿主输入 `event.received` 作为 source 插件的统一入口，`app.event` 与回执派生事件走同一匹配路径；`tasks` 加 `origin/ruleId/externalRef/labels`（旧库补列、老事实归一）；`kernel/cron.ts` 纯函数 + `clock.tick` 到点建任务、`nextWakeAt` 纳入 cron；设置页新增「规则」栏与两个模板；`KERNEL_VERSION=m6.0.0`。
- 评审口径（开工即定）：规则只建任务、不直接派活；同 `(ruleId, externalRef)` 不重复建任务（事件合并与线程上下文留 M6.5）；`to.thread` / `parallel` / `merge` 字段 M6 只校验与存储、不改变执行（M6.5 线程落地时生效）；M6 不落 source 插件进程（manual 源 = `rule.trigger`，app 源 = `app.event`，`plugins/sources/**` 留 M7 webhook 首个消费者）。
- 回滚点：M6 改投影表与 `KERNEL_VERSION`，回滚 = 切回 `master` 代码 + 恢复 M4 备份 `%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1720-pre-m4.db` 并重建（M5/M6 的可重建投影会从事实回放）。

## 文件去向

| 现状                                      | 行数                  | 去向                                                                                                               |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `shared/stage-machine.ts`                 | 116                   | `kernel/workflow/stage-machine.ts`（原样）                                                                         |
| `main/ai-workflow/engine.ts`              | 118                   | 效果意图 → `kernel/workflow/decide.ts`；写库/入队 → `host/effects.ts`                                              |
| `main/ai-workflow/runner.ts`              | 300                   | 调度/租约/退避 → kernel + `host/scheduler.ts`；spawn → 执行器插件                                                  |
| `main/ai-workflow/chat.ts`                | 234                   | 轮次策略 → kernel（`purpose='chat'`）；执行 → 执行器插件                                                           |
| `main/ai-workflow/repository.ts`          | 763                   | SQL 适配 → `host/store/**`；`:418-435,474-492` 的规则外迁 kernel                                                   |
| `main/ai-workflow/{schema,migrate,db}.ts` | 298                   | `host/db.ts` + `host/store/schema.ts`；迁移脚本删除，改为格式指纹 + `snapshot.imported`                            |
| `main/ai-workflow/ipc.ts` + `preload`     | 241                   | `host/ipc.ts`（三动词）；契约类型进 `src/protocol`                                                                 |
| `main/ai-workflow/runtime/dsh.ts`         | 890                   | `plugins/executors/dsh/index.ts`（整文件）                                                                         |
| `runtime/{process,executable}.ts`         | 240                   | `host/process.ts` + `host/executable.ts`（宿主能力，插件经 sdk 使用）                                              |
| `runtime/{registry,detect}.ts`            | 102                   | 删除；由运行时配置的 `executorKey` + `plugins/registry.ts` 与各插件 `detect()` 取代                                |
| `shared/ai-workflow-api.ts`               | 366                   | 拆成 `protocol/{commands,views,entities}.ts`                                                                       |
| `main/{index,ipc,tray}.ts`                | 162                   | `host/{boot,ipc,tray}.ts`                                                                                          |
| `renderer/shell/{types,registry}.ts`      | 28                    | `AppPlugin` 契约 + 插件清单                                                                                        |
| `apps/ai-workflow/**`                     | 7188                  | 保留 UI；删派生逻辑（`KanbanBoard.tsx:30,76-106`、`AiWorkflowPage.tsx:82-119`、`RunLog.tsx:13`）                   |
| `apps/pomodoro/**`                        | 1414                  | 原样保留，补 `events: ['pomodoro.*']`                                                                              |
| 全部 `*.test.ts(x)`、`e2e/`               | 约 9k 行（55 个文件） | 跟随改名迁移（现统一在 `tests/`，与 `src/` 同构镜像）；随 API 删除的测试可删，但必须有等价覆盖；禁止删断言或改预期 |

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

| 风险                                                               | 影响 | 对策                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 过渡期双写导致数据分叉                                             | 高   | 表变投影时同步删除旧写路径；禁止 `INSERT INTO tasks` 绕过事实                                                                                                                               |
| 约 9k 行测试与 mock 面重写（组件测试直接赋值 `window.aiWorkflow`） | 高   | 先改契约再改组件；`kernelStore` 提供测试替身；逐文件迁移，不批量删除                                                                                                                        |
| 重建性能超出预期                                                   | 中   | `viewSpec` 按需切片；投影裁剪 180 天前已完成 run；重建进 CI 预算                                                                                                                            |
| `node:sqlite` 在 Electron 45 打包行为未验证                        | 中   | **已验证通过（2026-11-04）**：Electron 45.1.0 / 内置 Node 24.22.1，`e2e-packaged/packaged-sqlite.spec.ts` 在打包进程内建表→写入→读回成功，`user_version=2`、`integrity_check=ok`；M1 可开工 |
| 插件边界被逐步侵蚀                                                 | 中   | 纯度测试 + 禁止 import 扫描 + 每次 review 对照「边界守则」                                                                                                                                  |
| 个人数据丢失                                                       | 高   | M1 前备份 `ai-workflow.db`；`snapshot.imported` 幂等；提供「从事实导出 JSON」                                                                                                               |
| 迟到回执 / 僵尸进程覆盖终态                                        | 高   | `leaseId + turn` 校验丢弃旧 attempt；宿主兜底写终态；对账先杀子进程再记账                                                                                                                   |
| 线程上下文膨胀或藏注入                                             | 中   | 派生 + 6000 字截断；笔记/事件只进资料段；「同事实同文本」单测                                                                                                                               |
| M2 期间崩溃恢复语义变化                                            | 中   | 保留旧 runner 一版做对照测试；恢复用例逐条跑                                                                                                                                                |

## 每阶段退出条件

`pnpm check` 全绿 + 覆盖率不低于基线 + 该阶段新增测试通过 + 迁移清单对应项有测试证据 + 一次手动验收（真 CLI 跑一轮）。

## 不做什么

多窗口、云同步/多用户、外部插件开放执行、MCP 注入、远端 Worker 实现、成本看板、任务依赖图、审批意见流。
