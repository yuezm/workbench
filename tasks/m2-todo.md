# M2 任务清单（运行生命周期）

> 计划说明见 [m2-plan.md](./m2-plan.md)。规则：每个任务结束跑 `pnpm check:fast`；检查点跑完整 `pnpm check` 与 `pnpm e2e`。
> 本阶段把 `runs`/`run_events`/聊天表从直写改为事实投影，并把 runner 拆成 host 调度 + 执行器接口。契约口径以 m2-plan「架构决议 D1–D15」为准。

## 阶段 1：契约、存量迁移与投影地基

### T1 契约面：run/chat 类型 / 事实 / 宿主内部输入 / Limits

**描述：** 落 run 与 chat 契约：`RunRow/RunEventRow/RunStatus(+waiting)/RunPurpose/RunUsage/Conversation/Message`（`shared/ai-workflow-api.ts` 改再导出，IPC 形状不变）；`facts.ts` 增 `run.queued/claimed/lease_extended/waiting/frames/abandoned/succeeded/failed/cancelled/usage/cancel_requested/receipt_rejected/removed`、`conversation.created/updated/removed`、`message.appended`，`snapshot.imported` 扩 `runs/run_events/conversations/messages`；新增 `protocol/inputs.ts` 定义 `Input = Command | 宿主内部输入`（`run.claim/heartbeat/receipt/host_settled/cancel/clock.tick/conversation.*`）；`Receipt` 补 `leaseId/turn`（D15）；`kernel/types.ts` 合并 Spec 版 `Limits`（保留 `maxStagesPerWorkflow`、`maxArrayLength`，新增 leaseMs/heartbeatMs/maxAttempts/backoff/runTimeout/cancelGrace/killAfter/maxFramesPerBatch），`KERNEL_VERSION→m2.0.0`。

**验收标准：**

- [ ] `RunStatus` 含 `waiting`、`RunErrorCode` 含 `executor_lost`；shared 字段与旧定义逐一对应、无废弃字段
- [ ] `FACT_TYPES` 与 `FactPayloads` 覆盖全部新事实；`snapshot.imported` 表联合含四张新表
- [ ] `Input` 判别联合可校验，非法载荷返回 `invalid_input`；`decide/viewSpec` 入参放宽为 `Input`，14 条命令零改动
- [ ] `DEFAULT_LIMITS`（`host/store/index.ts`）合并新字段，现有 store 测试不变

**验证：**

- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm test tests/protocol tests/kernel/purity.test.ts tests/host/store` 全绿

**依赖：** 无　**涉及文件：** `src/protocol/{entities,facts,inputs,validate}.ts`、`src/shared/ai-workflow-api.ts`、`src/kernel/{types,view-spec}.ts`、`src/host/store/index.ts`、`tests/protocol/*`　**规模：** M

### T2 存量迁移（runs / run_events / 聊天）

**描述：** 开工前 `pnpm db:export` 备份。扩展 `host/store/import.ts`：事实已非空但投影表为空/新格式时，按表分批（≤500 行）把存量 `runs`、`run_events`、`chat_conversations`、`chat_messages` 写为 `snapshot.imported` 导入根（`importedFrom:'v2'`），幂等 marker 记在导入事实里；`runs` 存量状态映射到新列（`attempt=1`、`attempts=0`），`run_events.seq` 保持原值。重命名为 `conversations/messages` 投影表。

**验收标准：**

- [ ] 用一个含 run/event/chat 的真实库快照升级：导入后行数、字段、`(run_id,seq)` 与导入前逐行一致
- [ ] 重复启动不重复导入（幂等）；`facts` 非空时也只补缺失表，不覆盖已有事实
- [ ] 导入后 `timeline` 对导入根标注「迁移导入」，不伪造因果

**验证：**

- [ ] `pnpm test tests/host/store/import.test.ts`（扩展）全绿；手工用 M1 备份库启动一次并比对

**依赖：** T1　**涉及文件：** `src/host/store/{import,projection}.ts`、`src/protocol/facts.ts`、`tests/host/store/import.test.ts`　**规模：** M

### T3 `runs`/`run_events`/conversations/messages 投影

**描述：** `kernel/project.ts` 增 run/chat 事实 → `Change[]`（`runs` upsert、`run_events` 逐帧追加 `key='<runId>:<seq>'`、`run.removed` 删除 run 与其 events、conversations/messages upsert）；`ProjectionTable` 增四表；`host/schema.ts`：`runs` 补 `purpose/lease_id/attempt/attempts/lease_until/not_before/deadline_at/cancel_requested`，`status` CHECK 加 `waiting`，`task_id` 改可空，`run_events` 保留 `(run_id,seq)` PK；投影白名单/清表顺序/空表计数/指纹纳入四表；conversations/messages DDL 从旧 chat 表迁移命名。

**验收标准：**

- [ ] 终态/usage/frames/removed 都能投影出完整行；`(run_id,seq)` 冲突报错而非覆盖
- [ ] 重建清空白名单含四表，`foreign_keys=OFF` 下顺序正确；`schema.test`/`projection.test` 同步
- [ ] 指纹随 DDL + `KERNEL_VERSION` 变化触发一次重建

**验证：**

- [ ] `pnpm test tests/host/store` 全绿；新增 runs/chat 投影等价用例（随机事实序列 → 实时 vs 重建逐表全等）

**依赖：** T1　**涉及文件：** `src/kernel/{project,types}.ts`、`src/host/schema.ts`、`src/host/store/{projection-apply,projection}.ts`、`tests/host/{schema,store}/*`　**规模：** L

### T4 View 扩展与视图装载

**描述：** `View` 增 `runs/conversations/messages`（`run_events` 不进 View）；`host/store/views.ts` 按 `viewSpec` 装载切片，`activeTaskIds` 改为从 `runs` 投影算 `status IN ('queued','running','waiting')`；`ActiveRun.status` 加 `waiting`；`RunLog.tsx` 与 `KanbanBoard.tsx` 补 `waiting` 的状态映射与活跃判定（不改交互）；preload 类型随 shared 再导出自动同步。

**验收标准：**

- [ ] `viewSpec` 为 run/chat 输入声明所需表；「执行中」不再读非投影表
- [ ] `waiting` 纳入活跃集且 UI 类型编译通过
- [ ] 现有任务/看板视图查询结果不变

**验证：**

- [ ] `pnpm test tests/host/store/views.test.ts tests/kernel/view-spec.test.ts tests/renderer/src/apps/ai-workflow/components/RunLog.test.tsx` 全绿；`pnpm typecheck` 通过

**依赖：** T3　**涉及文件：** `src/kernel/{types,view-spec}.ts`、`src/host/store/views.ts`、`src/protocol/views.ts`、`renderer/.../{RunLog,KanbanBoard}.tsx`、`tests/host/store/views.test.ts`　**规模：** M

### 检查点 A（T1–T4）

- [ ] `pnpm check:fast` 全绿
- [ ] 存量库升级后数据逐行一致；`runs`/`run_events`/聊天投影可重建
- [ ] 应用行为零变化（旧 runner 仍生效）
- [ ] 人工复核契约面与投影口径（D2/D6/D10/D13）

## 阶段 2：内核调度语义（纯函数）

### T5 内核领取与租约

**描述：** 新增 `kernel/run.ts`：领取候选 = `queued` 且 `notBefore ≤ now`，按 `notBefore` 升序、同序按 `seq`；按运行时分桶，窗口 = `maxConcurrent − 在跑数`（`waiting` 不占位）；产 `run.claimed { leaseId='runId:attempt', attempt, leaseUntil, deadlineAt }`。`decide` 增 `run.claim`；`run.heartbeat` 只在 `leaseId` 匹配当前租约时产 `run.lease_extended`。

**验收标准：**

- [ ] 黄金测试：超并发不领取、FIFO 顺序、`waiting` 不占位、`notBefore` 未到不领取、多运行时互不影响
- [ ] `leaseId/attempt/leaseUntil/deadlineAt` 计算与 Spec 一致；心跳不匹配不改投影
- [ ] `decide` 仍纯函数（无时钟/随机）

**验证：**

- [ ] `pnpm test tests/kernel/decide.run.test.ts`（新增）、`tests/kernel/purity.test.ts` 全绿

**依赖：** T1,T3　**涉及文件：** `src/kernel/{run,decide,types}.ts`、`tests/kernel/decide.run.test.ts`　**规模：** M

### T6 内核回执、终态、阶段流转与进入效果

**描述：** `decide` 增 `run.receipt`：校验 run 属于该运行时、`leaseId`+`turn` 匹配，否则产 `run.receipt_rejected` 且不改终态；按 `Receipt.status` 归一终态、写 `usage/errorCode/exitCode/durationMs/sessionId`；`ask[]` → `run.waiting { cardIds:[], turn }`（释放租约与并发位，D12）；`purpose='stage'` 终态经 `stage-machine` 产阶段流转事实（打回原地零效果）；`purpose='chat'` 终态产 `message.appended`。**同时**把 `task.create/task.move` 的进入效果搬进内核：`decide` 直接产 `run.queued`（含 `taskId/stageId/agentId/runtimeId/turn`），替代 `host/task-effects.applyStageEffects`。

**验收标准：**

- [ ] 迟到回执/旧 attempt/重复终态被丢弃且留 `run.receipt_rejected`
- [ ] `RUN_FAILED` 打回当前阶段零效果、不重建 run、不自动重试
- [ ] `task.create/move` 进入 agent 阶段产 `run.queued`（每次进入都触发），`waitUser/none` 不产 run
- [ ] `waiting` 后该任务仍算「执行中」；回答前不会被拖动
- [ ] chat 终态消息顺序与 `runId` 关联正确

**验证：**

- [ ] `pnpm test tests/kernel/decide.run.test.ts tests/kernel/decide.test.ts` 全绿；新增迟到/重复/waiting/进入效果用例

**依赖：** T5　**涉及文件：** `src/kernel/{run,decide}.ts`、`src/protocol/facts.ts`、`tests/kernel/decide.run.test.ts`　**规模：** L

### T7 内核时间与宿主兜底

**描述：** `decide` 增 `clock.tick`、`run.cancel`、`run.host_settled`：租约过期 → `run.abandoned { attempts+1, backoffUntil=now+backoffBase×2^(attempts-1)（封顶 1h） }` → 投影回 `queued`+`notBefore`；`attempts ≥ 3` → `run.failed{executor_lost}`；`deadlineAt` 到期 → `run.failed{timeout}`（actor host/via timeout）；`run.cancel` 仅对 `queued/running/waiting` 产 `run.cancel_requested`；`run.host_settled` 供宿主写取消/不可达终态。新增 `kernel/next-wake.ts`：取租约到期、`notBefore`、`deadlineAt` 最早值。

**验收标准：**

- [ ] 退避数值与 Spec L268 一致；三次失败落终态；超时落 `failed/timeout`
- [ ] 取消对非法状态 reject；`nextWakeAt` 无到期返回 null；`host_settled` 仅接受宿主 actor
- [ ] 黄金测试覆盖租约过期、退避到期重新可领取、超时兜底

**验证：**

- [ ] `pnpm test tests/kernel/decide.run.test.ts tests/kernel/next-wake.test.ts` 全绿

**依赖：** T5,T6　**涉及文件：** `src/kernel/{run,decide,next-wake}.ts`、`src/protocol/inputs.ts`、`tests/kernel/next-wake.test.ts`　**规模：** M

### 检查点 B（T5–T7）

- [ ] `pnpm test tests/kernel` 全绿；纯度测试通过
- [ ] run 黄金用例覆盖 容量/FIFO/租约/迟到回执/退避/超限终态/打回零效果/进入效果
- [ ] 人工复核决策面（D1/D3/D4/D5/D10/D14）

## 阶段 3：宿主执行链

### T8 `host/clock.ts`

**描述：** 唯一 `setTimeout`：按 `nextWakeAt` 到点 `store.dispatch({type:'clock.tick'})` 并重挂；定时器可注入（测试假时钟）；窗口不可见不降频；`wake()` 供 effects 提前唤醒。

**验收标准：**

- [ ] 全仓 run 级生产代码只有 `host/clock.ts` 持有定时器
- [ ] 假时钟推进精确触发一次 tick；无到期不空转
- [ ] 可观测下一次唤醒时刻（诊断）

**验证：**

- [ ] `pnpm test tests/host/clock.test.ts`（新增）全绿

**依赖：** T1,T7　**涉及文件：** `src/host/clock.ts`、`tests/host/{clock.test.ts,fixtures/fake-clock.ts}`　**规模：** S

### T9 执行器接口与进程层搬迁

**描述：** 新增 `host/executor.ts` 窄接口 `ExecutorPort.run(turn: Turn, io: ExecutorIO): Promise<Receipt>`、`probe/models`（类型取 protocol，M3 升级插件）；`main/ai-workflow/runtime/{registry,dsh}.ts` 实现该接口（适配层，`resume_rejected` 重试一次留适配层）；`runtime/{process,executable}.ts` 搬 `host/{process,executable}.ts`；ESLint 增 `src/host/**` 禁 import `main`/`renderer`。

**验收标准：**

- [ ] `Turn/Receipt` 字段与 SPEC-plugins L151-186 一致（含 `leaseId/turn/purpose/resumeSessionId`）
- [ ] `host/**` 无 `main/**` import（新 ESLint 规则生效）
- [ ] 进程层测试随文件搬家后全绿

**验证：**

- [ ] `pnpm test tests/host/process.test.ts tests/main/ai-workflow/runtime/dsh.test.ts` 全绿；`pnpm lint` 通过

**依赖：** T1　**涉及文件：** `src/host/{executor,process,executable}.ts`、`src/main/ai-workflow/runtime/{registry,dsh}.ts`、`eslint.config.mjs`、`tests/host/process.test.ts`　**规模：** M

### T10 `host/scheduler.ts`

**描述：** 事实驱动调度器：`wake()` → `dispatch run.claim(capacity)`；对每个 `run.claimed` 建 `Turn` 调 `ExecutorPort.run`，帧缓冲按 T12 入账；心跳定时续租；`receipt` 转 `run.receipt`；超时/不可达/取消经 `run.host_settled`；所有并发/顺序判定只来自内核。保留旧 runner 一版，做同假后端差分测试。

**验收标准：**

- [ ] 同运行时并发上限、FIFO、多运行时并行与旧 runner 逐项一致（差分断言）
- [ ] 执行器抛错/不可达 → 宿主兜底终态，run 不悬空
- [ ] `waiting` 后释放名额；重复 wake 不重复派发

**验证：**

- [ ] `pnpm test tests/host/scheduler.test.ts`（由 `runner.test.ts` 21 例重写 + 差分）全绿

**依赖：** T3–T9　**涉及文件：** `src/host/scheduler.ts`、`tests/host/scheduler.test.ts`、`tests/main/ai-workflow/test-support.ts`　**规模：** L

### T11 `host/effects.ts` + 装配接线

**描述：** `afterCommit` 分发：新 `run.queued` → `scheduler.wake()`；事实增量 → 现有 `AI_WORKFLOW_CHANGED` 广播；聊天帧 → `AI_WORKFLOW_CHAT` 旁路（M5 前保持旧通道）；订阅者抛错互相隔离。`main/index.ts` 按 SPEC-host L89 顺序装配 clock/scheduler/reconcile/effects（对账在 scheduler 前）。

**验收标准：**

- [ ] 一个订阅者抛错不影响其它分发
- [ ] 启动顺序：开库 → 校验/重建 → 导入迁移 → 对账 → scheduler → clock → 窗口 → IPC
- [ ] 现有 IPC 行为不变

**验证：**

- [ ] `pnpm test tests/host/effects.test.ts tests/main/index.test.ts` 全绿

**依赖：** T10　**涉及文件：** `src/host/effects.ts`、`src/main/index.ts`、`tests/host/effects.test.ts`、`tests/main/index.test.ts`　**规模：** M

### T12 `run.frames` 批量入账

**描述：** 执行器 `io.emit` 的帧进缓冲，按批（≤500 条或 16 ms）写 `run.frames` 事实；宿主为每 run 分配全局单调 `seq`（跨 turn 递增），丢弃执行器本地 seq；超过 500 **分包**而非丢弃（D7）；终态 `output` 取 text 汇总。

**验收标准：**

- [ ] `(run_id,seq)` 全程唯一递增，重跑不覆盖历史
- [ ] 分包后事件数与顺序完整；重建后 `run_events` 与实时逐行全等
- [ ] 实时旁路只影响显示，不影响数据源

**验证：**

- [ ] `pnpm test tests/host/store/runs-projection.test.ts tests/host/scheduler.test.ts` 全绿

**依赖：** T3,T10　**涉及文件：** `src/host/scheduler.ts`、`src/kernel/project.ts`、`tests/host/store/runs-projection.test.ts`　**规模：** M

### 检查点 C（T8–T12）

- [ ] 阶段 run 端到端走事实（建/拖任务→入队→领取→执行→帧→终态→阶段流转）
- [ ] `pnpm test tests/host` 全绿；旧/新执行链差分一致
- [ ] 人工复核 D6/D7/D15

## 阶段 4：崩溃恢复、聊天与取消

### T13 `host/reconcile.ts` + `process_registry`

**描述：** `host/schema.ts` 增宿主私有表 `process_registry(run_id PK,pid,started_at)`（不进投影/指纹，D11）；scheduler spawn 前占位、spawn 后回填 pid、退出删；`reconcile` 启动：按 pid 先杀进程树 → 清表 → `dispatch clock.tick` 回收超租约/超时 run；中断 chat 轮次落错误消息；`waiting` 保留。

**验收标准：**

- [ ] 强杀后重启：无残留 `running`、僵尸进程被清、任务可拖动
- [ ] 只处理过期/孤儿，不误杀正在跑的 run
- [ ] 聊天中断写一条带错误的消息

**验证：**

- [ ] `pnpm test tests/host/reconcile.test.ts`（新增）全绿

**依赖：** T9,T10,T12　**涉及文件：** `src/host/reconcile.ts`、`src/host/schema.ts`、`src/host/scheduler.ts`、`tests/host/reconcile.test.ts`　**规模：** M

### T14 聊天并入 `purpose='chat'`

**描述：** `protocol/inputs.ts` 增 `conversation.create/send/rename/remove`；`decide` 产 `conversation.created/updated` + `message.appended(user)` + `run.queued(purpose='chat', conversationId)`（拒绝时不落消息）；终态产 `message.appended(assistant, runId, error)`；删除 `ChatService` 执行路径，`buildChatPrompt/titleFromContent` 迁 `host/prompt.ts`；聊天与阶段共用 scheduler。

**验收标准：**

- [ ] 同一对话同时只跑一轮（第二请求 reject）；被拒绝不落用户消息
- [ ] 续接只发新消息；`resume_rejected` 用完整历史重试一次后仍失败按 failed 落库
- [ ] 标题/session 由事实可重建；聊天 run 不进 `runs.byTask`
- [ ] 消息顺序/错误文案与旧行为一致

**验证：**

- [ ] `pnpm test tests/host/scheduler.test.ts tests/host/chat.test.ts` 全绿（由 `chat.test.ts` 27 例迁移，断言不放松）

**依赖：** T10,T11　**涉及文件：** `src/protocol/inputs.ts`、`src/kernel/decide.ts`、`src/host/{scheduler,prompt}.ts`、`src/main/ai-workflow/chat.ts`、`tests/host/chat.test.ts`　**规模：** L

### T15 取消链路

**描述：** `run.cancel` 输入接通：scheduler 收到 `run.cancel_requested` 后按「cancel 帧 → 3 s → SIGTERM → 2 s → SIGKILL」终止（Windows `taskkill /T /F`）；无回执时以 `run.host_settled` 写 `run.cancelled/errorCode='cancelled'`；删任务/工作流与退出前先取消活跃 run。

**验收标准：**

- [ ] 宽限常量可注入缩短，测试断言各阶段顺序
- [ ] 取消后任务不推进阶段、状态 `cancelled`
- [ ] 重复取消幂等；取消 `waiting` 不关卡片（卡片 M4）

**验证：**

- [ ] `pnpm test tests/host/scheduler.test.ts tests/kernel/decide.run.test.ts` 全绿

**依赖：** T10　**涉及文件：** `src/host/scheduler.ts`、`src/kernel/run.ts`、`src/main/ai-workflow/ipc.ts`、`tests/host/scheduler.test.ts`　**规模：** M

### 检查点 D（T13–T15）

- [ ] 崩溃恢复三件事人工实测通过（强杀→重启）
- [ ] 聊天与阶段执行共用同一 scheduler 测试
- [ ] 取消时序全绿；人工复核 D11/D12

## 阶段 5：收口与验收

### T16 删旧写路径与测试搬家

**描述：** 先扩 `scripts/floor-guard.mjs` 的 `migratedCounterpart` 映射（`tests/main/ai-workflow/{runner,ipc}→tests/host/*`、`main/index→host/boot`、`repository runs 段→投影测试`、`host/task-effects→host/effects`），跑 `pnpm check:floor` 验证。删 `repository.runCreate/runUpdate/runEventsAppend/activeRunForTask` 与 chat 写方法、删 `runner.ts`、删 `host/task-effects.ts`、删 `shared/stage-machine.ts`（先把 `tests/shared/stage-machine.test.ts` 29 例并入 kernel 版，保护分支 100%）；迁移 `ipc.test`→`tests/host/ipc.test.ts`、`main/index.test`→`tests/host/boot.test.ts`、`repository{,.extra}.test` 的 runs 段→投影测试、`task-effects.test` 17 例→`host/effects.test`；删除 private 实现细节用例（`queued()/waitForIdle()`、PRAGMA 造悬空、usage SQL 分支）。

**验收标准：**

- [ ] 生产代码 `INSERT/UPDATE runs`、`run_events` 只出现在 `host/store/projection-apply.ts`
- [ ] 无 `.skip`、无删断言；旧测试等价覆盖已存在；`stage-machine` 分支 100% 保持
- [ ] 所有新增 `src/**` 文件均被测试 import（改动行覆盖率）

**验证：**

- [ ] `pnpm check` 全绿（覆盖率不低于 99.71/97.59/99.52/99.85）

**依赖：** T2–T15　**涉及文件：** `src/main/ai-workflow/{repository,runner}.ts`、`src/host/task-effects.ts`、`src/shared/stage-machine.ts`、`scripts/floor-guard.mjs`、`tests/**`　**规模：** L

### T17 验收与退出记录

**描述：** 跑满门禁与真 CLI 手动验收；新增 `tests/e2e/crash-recovery.spec.ts`（临时 userData 强杀→重启断言 claimed 回收/任务可拖）；按 D4/D7/D10/D13/D14 修订 SPEC 文档并同步 `TEST-CASES.md`/`TESTING.md`；更新 `CAPABILITY-MAP` 状态、`CONSTRAINTS` 覆盖率基线、`refactor-plan` M2 退出记录；写实现偏差。

**验收标准：**

- [ ] `pnpm check`、`pnpm e2e` 全绿；覆盖率与改动行达标
- [ ] 真 dsh：阶段执行一轮 + 聊天一轮通过
- [ ] SPEC/文档基线更新，D1–D15 口径与偏差入退出记录

**验证：**

- [ ] `pnpm check && pnpm e2e`；手动验收记录入 `refactor-plan`

**依赖：** T16　**涉及文件：** `tests/e2e/crash-recovery.spec.ts`、`docs/specs/*`、`docs/testing/*`、`docs/{CAPABILITY-MAP,planning/refactor-plan}.md`、`CONSTRAINTS.md`　**规模：** M

## 进度记录（开工后填）

- 分支 / 起点 commit：`________`
- 检查点通过时间：A `____` / B `____` / C `____` / D `____` / E `____`

## 实现偏差（执行中确认后写）

1. `________`

## M2 退出记录（验收后写）

- 提交链：`________`
- 证据：`________`
