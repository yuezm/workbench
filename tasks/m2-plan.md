# 实施计划：M2 运行生命周期（run.* 入账 + 租约 + 启动对账 + chat 统一）

> 依据 [refactor-plan](../docs/planning/refactor-plan.md) M2 行、[SPEC-kernel.md](../docs/specs/SPEC-kernel.md)（§事实目录/§调度/§输入目录）、[SPEC-host.md](../docs/specs/SPEC-host.md)、[SPEC-plugins.md](../docs/specs/SPEC-plugins.md)（executor）、[ARCHITECTURE.md](../docs/ARCHITECTURE.md)（冻结契约 2026-11-04）。
> 起点：`master` @ `20c84b6`（M1 退出 + 测试目录重组后）。工作分支 `refactor/m2-lifecycle`。
> 目标：`run.queued / claimed / lease_extended / frames / waiting / abandoned / 终态` 全部入账，`runs`、`run_events` 变为可重建投影；`runner` 拆成 **host 调度 + 注入执行器接口**；补齐租约、退避、启动对账；聊天并入 `purpose='chat'` 统一执行路径。本阶段不新建 `src/plugins`/`src/sdk`（M3）、不做 `card.*` 投递与回答（M4）、不动 IPC 三动词（M5）。
> 任务明细与验收见 [m2-todo.md](./m2-todo.md)。M0 的 `tasks/plan.md`、`tasks/todo.md` 保持未动，沿用 M1 惯例另开 `m2-*` 文件。

## 现状（测绘结论，2026-11-04）

| 事实                                                                                                                                   | 证据                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `runs` / `run_events` / 聊天表完全绕过事实日志：写入口只有 `repository.runCreate/runUpdate/runEventsAppend` 与 chat 方法               | `src/main/ai-workflow/repository.ts:218/243/289`；调用方 `runner.ts:169/215`、`task-effects.ts:93`、`chat.ts:109/150` |
| 状态写与事件写无事务；`run_events` seq 每次 attempt 从 1 计 + `INSERT OR REPLACE` → 重跑覆盖历史                                       | `dsh.ts:703`、`repository.ts:292`                                                                                     |
| 只有 `queued/running/succeeded/failed/cancelled`，无 `claimed/waiting`；「领取」= 写 `running`；`runs.task_id NOT NULL` 装不下聊天 run | `src/shared/ai-workflow-api.ts:86`、`src/host/schema.ts:78/82`                                                        |
| 租约/心跳零实现；`running` 重启永不回收（`resumeQueued` 只捞 queued）；残留子进程无人清理                                              | `runner.ts:59-61`、`src/main/index.ts:119`                                                                            |
| `Runner.cancel` 生产不可达（无 `runs.cancel` IPC）                                                                                     | `runner.ts:71`、`ipc.ts:239`                                                                                          |
| 并发上限、FIFO 只在内存；不同运行时并行、同运行时 `maxConcurrent`                                                                      | `runner.ts:43-45,88-126`                                                                                              |
| 「执行中」三处各算：内核 `activeTaskIds`（却依赖非投影的 runs 表）、store 装载、UI 轮询                                                | `src/kernel/types.ts:61`、`src/host/store/views.ts:199-204`、`KanbanBoard.tsx:29-32`                                  |
| chat 与 runner 是两套执行路径，聊天轮次不落任何 run 记录                                                                               | `chat.ts:97-165`                                                                                                      |
| 存量 `runs`/`run_events`/聊天数据没有事实可重建：首启 bump `KERNEL_VERSION` 重建会清空并丢历史                                         | `src/host/store/{projection.ts:65,import.ts:293}`                                                                     |
| `floor-guard` 只识别 `src→tests` 平移；`tests/main/...` → `tests/host/...` 会被判删测试/删断言                                         | `scripts/floor-guard.mjs:104-120`                                                                                     |

## 架构决议（Spec 缺口口径，待评审拍板）

Spec 在若干处只给方向未给口径，M2 按下列口径实现；涉及**改写 Spec 文档**的条目（D4/D7/D13/D14）需评审同意后先改 Spec 再写代码。

| #   | 缺口                                                        | M2 口径                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `run.heartbeat` 是输入还是事实                              | 输入；事实名是 `run.lease_extended`（SPEC-kernel L134/L158）                                                                                                                                                                                                                                                |
| D2  | `claimed` 与 `runs.status` 的映射                           | 投影 `status` 沿用五值并**新增 `waiting`**（CHECK 同步）；`run.claimed` 投影为 `status='running'` + `leaseId/attempt/leaseUntil`。加 `waiting` 会触发 `RunLog.tsx` 的 `Record<RunStatus,_>` 与看板活跃判定编译错误 → T4 顺带补 2 处 UI 状态映射（不动交互，M5 再统一词汇）                                  |
| D3  | `run.abandoned` 之后回什么状态                              | 回 `queued`，写 `notBefore=backoffUntil`、`attempts+1`；`attempts ≥ maxAttempts(3)` → 追加 `run.failed`，`errorCode='executor_lost'`（卡片留 M4）。口径：`attempt` = 当前第几次领取（1 基，来自 claim）；`attempts` = 累计失败次数（来自 abandoned）                                                        |
| D4  | `executor_lost` 不在 9 个 errorCode 内                      | 作为第 10 个 `errorCode` 只增不改；取消兜底落 `run.cancelled`+`errorCode='cancelled'`。**先修订 SPEC-ai-workflow 的 errorCode 表与 SPEC-host L53 措辞**，退出记录留痕                                                                                                                                       |
| D5  | 30 分钟超时归属                                             | `run.claimed` 同时写 `deadlineAt = now + runTimeoutMs`；`nextWakeAt` 纳入 deadline；`clock.tick` 产 `run.failed{errorCode:'timeout'}`，actor 用 `{kind:'host',via:'timeout'}`。全仓 run 级只有 `host/clock.ts` 一个定时器；执行器内部进程超时由适配层自管（不产生 run 事实）                                |
| D6  | `run_events` 的键与 seq                                     | `Change.key = '<runId>:<seq>'`，行内含 `runId/seq`；`run.frames` payload 带 `{ runId, turn, frames[] }`，帧 seq 由宿主按 run **全局单调**分配（跨 turn 递增），执行器本地 seq 丢弃；禁止 `INSERT OR REPLACE` 覆盖                                                                                           |
| D7  | `maxFramesPerBatch` 超限的「dropped」事实未定义             | 改为**分包**：超过 500 帧拆成多条 `run.frames` 事实，语义不丢；同步修订 SPEC-kernel L83 注释                                                                                                                                                                                                                |
| D8  | `purpose='chat'` 的差异规则空白                             | 扩展 `run.queued` 带 `conversationId?`；`conversations`/`messages` 纳入投影与事实（`conversation.created/updated/removed`、`message.appended`），标题与 `sessionId` 用 `conversation.updated` 持久化；`runs.task_id` 改可空；`runs.byTask` 只返回 `purpose='stage'`；`conversation.send` 拒绝时不落用户消息 |
| D9  | `commandId` 幂等无载体                                      | **M2 不做**：现状 IPC 每次生成随机 `commandId`（`ipc.ts:53`），幂等要等 M5 三动词统一入口，避免为单个问题新增 `command_log` 表。M2 只保证回执幂等：`(runId, turn, payload 哈希)` 同哈希返回上次结果、异哈希 `conflict`                                                                                      |
| D10 | 迟到/重复终态的审计事实无名字                               | 新增 `run.receipt_rejected { runId, leaseId, turn, reason }`，只记账不覆盖终态；同步补 SPEC-kernel 事实表                                                                                                                                                                                                   |
| D11 | 残留子进程怎么在重启后找到                                  | 宿主私有表 `process_registry(run_id PK, pid, started_at)`：spawn 前先占位（pid 空）、spawn 后回填 pid、退出删；`reconcile` 启动先按 pid 杀树再记账。私有表不进投影白名单/指纹；spawn 后回填前崩溃的孤儿进程由「同可执行名 + 启动时间」兜底扫描（在 T13 记录限制）                                           |
| D12 | M2 是否要卡片回答闭环                                       | M2 实现 `run.waiting` 事实/投影/「回答→`run.queued` 续接」的内核判定，但**执行适配层在 M4 前不产 `ask`**，生产不会进入 `waiting`，只由单测覆盖；M4 接卡片与通道。避免 waiting run 无人可答而永久卡死                                                                                                        |
| D13 | 任务删除与 run 投影的重建等价                               | 新增 `run.removed { runId }` 事实：`task.removed` 决策同时为该任务的 run 产 `run.removed`（替代 SQL 级联的静默删除），保证「事实只追加 + 重建逐表全等」。**先修订 SPEC-kernel 事实表**                                                                                                                      |
| D14 | 宿主兜底终态的输入载体缺失                                  | 新增宿主内部输入 `run.host_settled { runId, leaseId?, turn?, status, errorCode?, error?, output?, sessionId?, usage?, exitCode?, durationMs? }`，actor `{kind:'host',via:'scheduler'                                                                                                                        | 'reconcile' | 'cancel'}`；仅宿主可发。**先修订 SPEC-kernel 输入目录** |
| D15 | `Receipt` 缺 `leaseId/turn` 字段，与 SPEC-plugins L189 冲突 | 契约补 `leaseId: string; turn: number`；`later/events/notices/resolves` 留 M4/M6，M2 适配层不产出、内核校验时接受但忽略                                                                                                                                                                                     |

## 目标结构

```
src/
├── kernel/
│   ├── types.ts          # View 增 runs/conversations/messages；ProjectionTable 增 runs/run_events/conversations/messages；Limits 合并 Spec 版；KERNEL_VERSION→m2.0.0
│   ├── run.ts            # 领取排序/租约/心跳/回执校验/终态归一/退避/放弃/取消（纯函数）
│   ├── next-wake.ts      # nextWakeAt(view, now, env)
│   ├── decide.ts         # 增 task 进入效果→run.queued、run.claim/heartbeat/receipt/host_settled/cancel、clock.tick、conversation.*
│   └── project.ts        # runs/conversations/messages upsert + run_events 追加 + run 删除
├── protocol/
│   ├── entities.ts       # RunRow/RunEventRow/RunStatus(+waiting)/RunPurpose/RunUsage/Conversation/Message（shared 再导出）
│   ├── facts.ts          # run.* / conversation.* / message.appended 事实名与 payload；snapshot.imported 扩表
│   ├── inputs.ts         # Input = Command | 宿主内部输入
│   └── validate.ts       # 输入校验扩展
├── host/
│   ├── clock.ts          # 唯一定时器，按 nextWakeAt 发 clock.tick
│   ├── effects.ts        # afterCommit：run.queued→scheduler.wake；事实→变更广播；帧→聊天流旁路
│   ├── scheduler.ts      # claim→executor.run→frames 批量入账→receipt；心跳/取消时序
│   ├── reconcile.ts      # 启动对账：杀残留进程 → 过期租约/孤儿 run 记账
│   ├── prompt.ts         # 任务/聊天提示词拼装（从 task-effects/chat 迁入）
│   ├── process.ts        # 从 main/runtime/process.ts 迁入（+ executable.ts）
│   └── store/            # 投影白名单、runs/run_events/conversations/messages 写入、View 装载、导入
└── main/ai-workflow/     # 过渡期：dsh 适配器 + ipc + 装配；runner.ts 本阶段删除，chat.ts 删除
```

依赖红线：`host/**` 只能注入执行器接口，**禁止 import `main/**`**（M2 补 ESLint 规则）；`kernel/**` 仍禁 IO/时钟/随机。

## 任务拆分

| 编号 | 任务                                                                                                               | 依赖       | 规模 |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---------- | ---- |
| T1   | 契约面：run/chat 类型、事实（含 `run.*`/`conversation.*`/`message.appended`）、宿主内部输入、Limits/KERNEL_VERSION | 无         | M    |
| T2   | 存量迁移：`snapshot.imported` 扩 `runs/run_events/conversations/messages`，幂等导入                                | T1         | M    |
| T3   | `runs`/`run_events`/conversations/messages 投影（project + apply + schema 白名单/CHECK + 指纹）                    | T1         | L    |
| T4   | View 扩展与视图装载：runs/conversations/messages 切片、`activeTaskIds` 改读投影、UI 状态映射                       | T3         | M    |
| T5   | 内核领取：`run.claim` + 租约 + `run.heartbeat`→`run.lease_extended`                                                | T1,T3      | M    |
| T6   | 内核回执：`run.receipt` 校验/终态/`run.waiting`/阶段流转/**进入效果→`run.queued`**/chat 消息                       | T5         | L    |
| T7   | 内核时间与兜底：`run.abandoned`/退避/`clock.tick`/`run.cancel_requested`/`run.host_settled`/`nextWakeAt`           | T5,T6      | M    |
| T8   | `host/clock.ts`：唯一定时器与可注入时钟                                                                            | T1,T7      | S    |
| T9   | 执行器接口 + `host/process.ts` 搬迁（spawn/行读取/杀树）                                                           | T1         | M    |
| T10  | `host/scheduler.ts`：claim→执行→回执；心跳/超时/取消时序                                                           | T3–T9      | L    |
| T11  | `host/effects.ts` + 装配根接线（启动顺序按 SPEC-host）                                                             | T10        | M    |
| T12  | `run.frames` 批量入账与 `run_events` 重建等价                                                                      | T3,T10     | M    |
| T13  | `host/reconcile.ts` + `process_registry`：崩溃恢复                                                                 | T9,T10,T12 | M    |
| T14  | 聊天并入 `purpose='chat'`（命令/事实/执行路径统一）                                                                | T10,T11    | L    |
| T15  | 取消链路：`run.cancel` → cancel 帧→3s→SIGTERM→2s→SIGKILL（Win `taskkill /T /F`）                                   | T10        | M    |
| T16  | 删旧写路径与重复执行路径；`floor-guard` 映射；全部测试搬家/重写                                                    | T2–T15     | L    |
| T17  | 验收与退出记录：`pnpm check`/`pnpm e2e`/覆盖率/真 CLI/SPEC 与文档更新                                              | T16        | M    |

T1 串行；T2/T3 与 T5 可并行（写作用域 `host/store/**` vs `kernel/run.ts`）；T9 不依赖内核收口可先做；T10 起串行收口。旧 `runner.ts` 在 T16 前保留做对照测试（refactor-plan 风险表要求）。

## 检查点

- **检查点 A（T1–T4）**：`pnpm typecheck && pnpm lint` 通过；`tests/protocol`、`tests/host/store` 全绿；存量导入后 `runs`/`run_events`/聊天数据与导入前逐行一致；投影可重建。
- **检查点 B（T5–T7）**：`tests/kernel` 全绿，run 黄金用例覆盖 容量/FIFO/租约过期/迟到回执/退避/超限终态/打回零效果/进入效果/等待释放并发位；纯度测试通过。
- **检查点 C（T8–T12）**：阶段 run 端到端走事实：任务建/拖→`run.queued`→领取→执行→帧入账→终态→阶段流转；旧 runner 与新 scheduler 对同一假后端做**差分断言**（同一脚本跑两套，事实/终态/阶段一致）；`pnpm test tests/host` 全绿。
- **检查点 D（T13–T15）**：强杀重启后 `claimed` 回收、残留子进程被终止、任务可拖动；聊天与阶段共用同一 scheduler 测试；取消时序常量可注入缩短后全绿。
- **检查点 E（T16–T17）**：生产代码 `INSERT/UPDATE runs`、`run_events` 只出现在 `host/store/projection-apply.ts`；`pnpm check` 全绿、覆盖率不低于基线、改动行 ≥90%；`pnpm e2e` 全绿；真 CLI 手动跑一轮阶段 + 一轮聊天。

## 文件去向

| 现状                                                    | 行数   | 去向                                                                                                                     |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `main/ai-workflow/runner.ts`                            | 309    | 调度/租约/退避 → `kernel/run.ts` + `host/scheduler.ts`；spawn/帧翻译 → 执行器适配层；文件删除                            |
| `main/ai-workflow/chat.ts`                              | 234    | 轮次策略 → `kernel`（`purpose='chat'`）；执行 → 同一 scheduler；`titleFromContent`/`buildChatPrompt` 迁 `host/prompt.ts` |
| `main/ai-workflow/repository.ts`                        | 12449B | 删 `runCreate/runUpdate/runEventsAppend/activeRunForTask` 与 chat 写方法；run/chat 读走投影表                            |
| `host/task-effects.ts`                                  | 183    | 进入效果改由 `decide` 产 `run.queued`；`advanceTask` 并入 `run.receipt` 决策；文件删除                                   |
| `main/ai-workflow/runtime/process.ts`、`executable.ts`  | 240    | `host/process.ts` + `host/executable.ts`                                                                                 |
| `main/ai-workflow/runtime/{registry,dsh}.ts`            | 28k    | M2 保留并适配 `ExecutorPort`；M3 整文件搬插件                                                                            |
| `src/shared/stage-machine.ts`                           | 441B   | 最后一个消费者删除后移除；旧测试先并入 kernel 版                                                                         |
| `src/shared/ai-workflow-api.ts` 的 Run/RunEvent/Chat 段 | —      | 搬 `protocol/entities.ts`，shared 再导出保持 IPC 形状                                                                    |

## 必须保住的行为（M2 相关，逐条验收）

1. 同运行时按 `maxConcurrent` 限流、全局 FIFO（`notBefore` 升序、同序按 seq）、多运行时并行。
2. 取消时序：cancel 帧 → 3 s → SIGTERM → 2 s → SIGKILL；Windows `taskkill /T /F`；超时 30 分钟同流程。
3. 终态归一表与 errorCode 语义（+ D4 的 `executor_lost`）；`RUN_FAILED` 打回当前阶段零效果、不重建 run、不自动重试。
4. 「执行中」= 存在 `queued/claimed/waiting`，现算不落库；有活跃 run 时拒绝拖动与完成。
5. 每次进入阶段重新触发进入效果；人工拖拽落点即目标，不套用 `on_complete`/`on_reject`。
6. 聊天：续接只发新消息、`resume_rejected` 用完整历史重试一次、同一对话只跑一轮；被拒绝不落消息。
7. `run_events` 的 `(run_id,seq)` 唯一、按 seq 排序、`output` = text 汇总、重建后仍在。
8. 删除任务/工作流时其 run 与 `run_events` 的可见结果与旧级联一致（经 `run.removed` 事实）。
9. 质量门禁不放松：覆盖率阈值、`stage-machine` 分支 100%、改动行 ≥90%。
10. renderer 禁 import electron/Node；main 禁 import renderer；**新增 host 禁 import main/renderer**。

## 验收（退出条件）

- `pnpm check` 全绿；覆盖率 ≥ 99.71/97.59/99.52/99.85；改动行 ≥90%。
- `pnpm e2e` 全绿；新增 `tests/e2e/crash-recovery.spec.ts`（临时 userData 强杀→同目录重启）。
- 崩溃恢复三件事实测：`claimed` 回收、残留子进程终止、任务可拖动。
- 同运行时并发上限与 FIFO 有测试证据；聊天与阶段共用一套 scheduler 测试；旧/新执行链差分一致。
- 真 CLI（dsh）跑一轮阶段执行 + 一轮聊天，手工验收通过。
- 旧写路径消失：生产代码 `INSERT/UPDATE runs`、`run_events` 只出现在 `host/store/projection-apply.ts`。
- SPEC 文档已按 D4/D7/D10/D13/D14 修订，`TEST-CASES.md`/`TESTING.md` 同步。

## 风险与对策

| 风险                                        | 影响 | 对策                                                                               |
| ------------------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| 首启重建清空存量 runs/run_events/聊天       | 高   | T2 幂等 `snapshot.imported` 迁移；开工前 `pnpm db:export` 备份；迁移后逐行比对     |
| 过渡期双写（旧 runner 直写 + 新事实）       | 高   | T10 前新路径不接线；T16 删旧写与 `runner.ts` 同一提交；`grep` 门禁                 |
| 测试跨目录搬家触发 `floor-guard` 误判       | 高   | T16 先扩 `migratedCounterpart` 映射并跑 `pnpm check:floor`；逐文件迁移，禁止删断言 |
| 168 例测试重写导致断言被削弱                | 高   | 先改契约再改测试；`floor-guard` 双保险；评审 diff                                  |
| 帧 seq 复用覆盖历史                         | 高   | D6 全局 seq；`run_events` 纯追加；重建等价测试                                     |
| 崩溃后重复执行（租约回收但旧进程仍在跑）    | 高   | D11 先占位再 spawn；`leaseId+turn` 拒绝旧回执；reconcile 先杀树                    |
| chat 行为回退（消息顺序/标题/续接）         | 中   | chat 测试随 scheduler 重写保留原断言；标题/session 走事实可重建；真 CLI 验收       |
| `KERNEL_VERSION` 递增触发全量重建，启动变慢 | 中   | 重建预算进测试（10 万事实 < 5 s）；退出记录实测                                    |
| M2 期 `waiting` 无卡片                      | 中   | D12 执行适配层不产 ask，生产不进 waiting；规则由单测覆盖；M4 补闭环                |

## 开放问题（需人评审拍板）

1. **SPEC 修订授权**：是否同意按 D4/D7/D10/D13/D14 先修订 `SPEC-kernel`/`SPEC-host`/`SPEC-ai-workflow`（新增 `run.receipt_rejected`/`run.removed`/`run.host_settled`、`executor_lost`、waiting 语义、frames 分包、Receipt 补 `leaseId/turn`）？推荐同意，否则 D4/D7/D13/D14 属违约。
2. D2：接受「投影 `status` 新增 `waiting`，`run.claimed` 映射 `running`」，并顺带改 2 处 UI 状态映射？
3. D9：接受 `commandId` 幂等推迟到 M5（M2 不建 `command_log`）？
4. D11：接受新增宿主私有 `process_registry` 表（不进投影/指纹）用于重启杀残留进程？
5. D7：帧超限用「分包」替代 Spec 的「丢弃 + dropped」，是否接受？
6. **是否拆里程碑**：M2 含运行生命周期 + 聊天统一 + 存量迁移，共 17 个任务；是否拆成 M2a（T1–T13、T16 部分）与 M2b（T14、T15、T17 验收）两批合并，降低一次性改造风险？推荐按本计划分 5 阶段推进、一次合并，除非工期更紧。
