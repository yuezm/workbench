# M4 宿主/UI 侧现状测绘（recon-host）

只读测绘，未改 `src/**`、未跑 `pnpm check/e2e`、未提交。基线：M1–M3 已落地（事实+投影、调度器、执行器插件、`src/sdk`、`plugins/registry`）。M4 = `card.*` 事实、`run.waiting`、回答续接、`in-app` + `desktop` 通道、挂起期间零进程。

## 1. 事实提交后的分发：`host/effects.ts`

- 现状：唯一写入口 `effects.dispatch`，先 `store.dispatch` 再 `afterCommit(facts)`（`src/host/effects.ts:71-78`）。订阅者形态是**三个可选回调 + 一个惰性 scheduler**（`effects.ts:26-34,52-69`），按 `fact.type` 内联 if：`run.queued→wake`、`run.cancel_requested→cancel`（`effects.ts:56-65`）。
- 调用点：main 装配 `store / scheduler / notifyChanged`（`src/main/index.ts:166-170`）；IPC 用 `effects.dispatch`（`main/index.ts:216-223`）；scheduler 自己写入走 `effects.dispatch`（`main/index.ts:190-193`）；clock 写入走 `effects.dispatch`（`main/index.ts:182-189`）。
- 隔离：每个订阅点用 `safely()` 包住，异常不外溢（`effects.ts:44-50,58-68`；测试 `tests/host/effects.test.ts:96-135`）。
- 已有但未接的钩子：`onFacts` 诊断回调（`effects.ts:32-33`），main 装配没有传（`main/index.ts:166-170`）——这是最小的「卡片→通道」挂点。
- 缺口：没有多订阅者列表、没有按事实类型注册表、没有异步/队列；`card.*` 事实根本不存在（`src/protocol/facts.ts:30-66` 无 card 项）。
- 集成点：在 `afterCommit` 里对 `card.opened/updated/resolved` 调 channel hub；hub 必须在 effects 之后才可用 → 沿用 `scheduler: () => scheduler` 的惰性 getter 模式（`effects.ts:21-24,28-29`）。
- 风险：`afterCommit` 同步跑在写事务提交之后、IPC/调度器返回之前（`src/host/store/index.ts:127-141,144-160`）→ 通道投递慢会拖住写路径，必须 fire-and-forget + 自捕获。

## 2. 调度器 claim/settle 与「挂起期间零进程」

- claim：`wake()`（`src/host/scheduler.ts:523-539`）→ `pump()` 对每个启用运行时 `dispatch({type:'run.claim', capacity: runtime.maxConcurrent})`（`scheduler.ts:509-521`）→ `run.claimed` → `start()` 校验运行时/执行器端口、建 `AbortController`、`execute()`（`scheduler.ts:484-507`）。
- settle：`port.run(...)` 返回后先 flush 帧、再 `dispatch({type:'run.receipt'})`（`scheduler.ts:438-451`）。回执带 `ask[]` 时内核产 `run.waiting`（`src/kernel/decide.ts:819-830`），把 `leaseId/leaseUntil/deadlineAt` 清空（`src/kernel/run.ts:207-221`），`cards: []`（`run.ts:228`）。
- 并发位释放是**事实层自动完成**：`occupiedSlots` 只数 `running`（`run.ts:41-51`），所以 waiting 不占窗口；下一次 `wake` 可领新 run。
- 定时器：`run.waiting` 不参与 `nextWakeAt`（`src/kernel/next-wake.ts:13-30`），clock 按 `nextWakeAt` 只挂一个 timer（`src/host/clock.ts:91-100`），scheduler 领取/收尾后 `rearm()`（`scheduler.ts:388`，`clock.ts:122-125`）。挂起期间**没有**定时唤醒，符合「可以几天后回」。
- 收尾：`finishOnce()` 关帧、清心跳、`registry.remove`、`controllers.delete`、`wake`、`releaseIdle`、`rearmClock`（`scheduler.ts:372-391`）。
- 零进程证据链：执行器只在子进程 `onClose` 后 resolve 回执（`src/plugins/executors/dsh/run.ts:291-304,320-325`；`src/plugins/executors/command/run.ts:240-251,265-269`），因此 `run.receipt` 到达时进程已退出；登记行在 `finishOnce` 里删（`scheduler.ts:380`）。`reconcile` 也把 `waiting` 当「可能有子进程」的状态处理（`src/host/reconcile.ts:23-24,58-66`）。
- 缺口：宿主没有运行时断言「回执提交前进程/登记必须已清」；测试只能靠 E2E 探 pid。取消 waiting 可走 `run.cancel`→`scheduler.cancel`（无 controller）→`host_settled{cancelled}`（`scheduler.ts:544-554`，`decide.ts:861-872`），但**不写 `card.resolved`**。
- 缺口：`scheduler.active()` 不含 waiting（`scheduler.ts:571`），`cancelAll` 只处理 controllers（`scheduler.ts:555-570`）→ 重启后 open card 无任何宿主动作，需 in-app 通道从投影补投/展示。
- 续接现状：内核**没有**回答入口；`tests/host/scheduler.test.ts:1037-1049` 用裸 SQL 把 run 改回 `running/turn=2` 来模拟续接——这是 M4 必须补的真实路径（`RunRow.turn/resumeSessionId/sessionId` 字段已就绪，`src/protocol/entities.ts:385-400`）。

## 3. 执行器适配层：Receipt → 宿主动作

- `createExecutorPort` 归一后**整份回执原样返回**，`normalizeReceipt` 用展开保留所有未知字段（`src/host/executor.ts:28-41,71-94`）；scheduler 把整份回执塞进 `run.receipt`（`scheduler.ts:447-451`）。
- `protocol/validate` 接受 `ask/notices/resolves/later/events`（`src/protocol/validate.ts:466-494`）；但内核只用 `ask` 判 waiting（`decide.ts:828-830`），其余四个字段**无处落地**：`FACT_TYPES` 无 card 事实（`facts.ts:30-66`），`project` 无 card 分支（`src/kernel/project.ts:98-121`），`waitingFacts` 固定空 cardIds（`run.ts:223-229`）。
- `Ask` 结构只有 `title/text/options/key`，缺卡片 id/version/delivery（`src/protocol/inputs.ts:44-52`）；`card.*` payload 形状只在 SPEC（`docs/specs/SPEC-kernel.md:191-196,303-309`）。
- 执行器侧目前都不产 `ask`：dsh 帧类型里没有 ask 字段（`src/plugins/executors/dsh/frames.ts:23-50,132-140`），command 回执只填 status/output/usage（`command/run.ts:59-72`）→ M4 需要执行器插件配合（不在本测绘范围，但属于关键依赖）。
- 结论：宿主的「转交」一层不用改；要改的是 kernel 事实/投影与执行器插件。

## 4. 通道插件需要的宿主原件

- 契约：`ChannelPlugin.start(ctx) → dispose`，`ChannelContext { sdk, onCard, delivered, answer, signal }`（`docs/specs/SPEC-plugins.md:239-257`）。四件宿主原件目前**全部不存在**（`src/plugins/channels/` 目录都没有）。
- `onCard`：需要 channel hub 订阅 `card.opened/updated`，启动时按 `pending` 补投（`SPEC-plugins.md:255-257`）。
- `delivered` / `answer`：需要新宿主输入 `card.delivered`（host actor）与新命令 `card.answer`（owner via `channel`，`Actor` 已支持，`src/kernel/types.ts:34-37`）。当前 `HOST_INPUT_NAMES` 无 card 项（`inputs.ts:20-32`），`COMMAND_NAMES` 无 card 项（`src/protocol/commands.ts:11-26`），`validateInput` 只认这两张清单（`validate.ts:557-575`）。
- sdk 能力：`Sdk` 只有 log/now/paths/config/process（`src/sdk/types.ts:69-79`），`SdkHost` 同（`types.ts:82-88`），`createSdk` 只门控 `spawn`（`src/sdk/index.ts:34-45`）。`Capability` 已含 `notify`（`src/protocol/manifest.ts:18`），但 `sdk/index.ts` 与 `tests/plugins/boundary.test.ts:200-205` 都没实现/扫描它 → 只加声明会被判「声明没用」。
- 结论：M4 需 `Sdk.notify(title, body)`；原件放 main（`Notification`），经 `createSdkHost` 注入，`createSdk` 加 `notify` 门控，boundary 扫描加一条规则。

## 5. IPC / 桥接现状

- 单一 RPC：`AI_WORKFLOW_CHANNEL='ai-workflow:invoke'`（`src/shared/ai-workflow-api.ts:172-177`），方法表在 `src/main/ai-workflow/ipc.ts:169-364`，注册在 `:373-378`；preload 逐方法封装（`src/preload/index.ts:18-20,22-79`）。
- **没有**任何卡片/回答方法；preload 契约 `AiWorkflowApi` 无 cards（`shared/ai-workflow-api.ts:110-170`）。
- changed 通知：每次提交后 `broadcastChanged` 向所有窗口 `send(AI_WORKFLOW_CHANGED)`，无 payload（`src/main/index.ts:88-90`，由 `effects.notifyChanged` 触发 `:166-170`）；renderer `onChanged` 后重拉视图（`preload/index.ts:72-78`；`AiWorkflowPage.tsx:106-124`）。这是事件推送，不是轮询。
- 聊天流另有旁路 `AI_WORKFLOW_CHAT`（`main/index.ts:172-180`，scheduler `:190-204,336-351`）；waiting/k卡片没有等价旁路。
- 视图面：`VIEW_IDS` 无 cards（`src/protocol/views.ts:21-37`），`queryView` switch 无 cards（`src/host/store/views.ts:598-631`），投影白名单九表无 cards（`kernel/types.ts:43-53`；`host/schema.ts:327-337`）。
- 错误码：IPC 直接抛 `StoreError`（`ai-workflow/ipc.ts:366-370`），`StoreError.code`（`host/store/errors.ts:10-18`）不过桥 → 「重复回答拒绝」当前只能展示文案（SPEC-host 要求的 `{code,message}` 见 `SPEC-host.md:65-84`，属 M5）。

## 6. 通知能力（desktop 通道可复用的部分）

- `window.workbench.notify` → preload `ipcRenderer.invoke(NOTIFY_CHANNEL,{title,body})`（`preload/index.ts:11-15`；契约 `shared/workbench-api.ts:5-17`）→ main 直接 `new Notification({title,body}).show()`（`src/main/ipc.ts:1-9`）。与托盘无关，`tray.ts` 只做托盘图标/菜单（`src/main/tray.ts:26-41`）。
- Windows toast 前提已就位：`app.setAppUserModelId('com.workbench.desktop')`（`main/index.ts:84`）。
- 「文字只作参数」：Electron Notification 是类型化参数，结构性安全；SPEC 的 `--` 分隔针对 CLI 型通知命令（`SPEC-plugins.md:255`）。不存在 `host/notify.ts`（文件不存在），refactor-plan 写的 `host/notify.ts` 与 ESLint「host 不得 import electron」（`eslint.config.mjs:73-95`）冲突。
- 风险：同一版本只投一次（`SPEC-plugins.md:256`）需要 `cards.delivery` 投影；通知失败不得回写卡片状态之外的事实。

## 7. UI 侧现状

- 无卡片/审批 UI：`apps/ai-workflow/components/` 只有看板/聊天/设置类组件；唯一 waiting 呈现是运行记录的状态标签（`RunLog.tsx:19-36`）。
- `api.ts` 只是取 `window.aiWorkflow`（`apps/ai-workflow/api.ts:4-8`）。
- 看板刷新：`onChanged` → `reload()` 重拉 workflows/agents/tasks（`AiWorkflowPage.tsx:82-97,106-124`），`runs` 在 `selectedTaskId` 变化时拉（`:146-164`）；`RunLog` 对 `running` 每 1s 轮询事件（`RunLog.tsx:12-13,146-152`）。
- waiting 任务会锁卡片（`KanbanBoard.tsx:29-34`，`AiWorkflowPage.tsx:146-164`），属预期。
- E2E 已有能力：`page.evaluate` 直接调 `window.aiWorkflow`（`tests/e2e/crash-recovery.spec.ts:49-67`）、直接读 DB（`seed-crash.ts:189`）、探 pid（`seed-crash.ts:212`）→ 问答闭环可沿用。
- 结论：M4 若只做「投影+IPC 可读」，E2E 可程序化驱动但人看不到审批；建议最小 in-app UI（RunLog/TaskCard 上一条 open card 条 + 两个按钮），不新开导航。

## 8. 通道插件生命周期与装配

- 装配根在 `src/main/index.ts` 的 `whenReady`：开库（`:92`）→ store（`:95`）→ 存量导入/重建（`:98-99`）→ sdkHost（`:105`）→ executorRegistry（`:107`）→ processRegistry（`:148`）→ reconcile（`:149-157`）→ effects（`:166-170`）→ clock（`:182-189`）→ scheduler（`:190-213`）→ IPC（`:216-223`）→ `wake()`+`clock.start()`（`:226-227`）→ 建窗（`:229`）→ 托盘（`:234-238`）。SPEC-host 的期望顺序（含 start sources/channels）见 `SPEC-host.md:96-100`。
- 当前**没有** channels 装配、start/stop；退出只 `activeScheduler.cancelAll()`（`main/index.ts:249-253`），无 dispose 等待。
- AbortSignal：只有 per-run controller（`scheduler.ts:206,502-503`），没有进程级 signal；通道需要自己建 controller，`before-quit` 里 abort + best-effort dispose（当前 handler 非 async）。
- 崩溃隔离：`effects.safely` 只隔离同步异常（`effects.ts:44-50`）；通道投递是异步，hub 必须自己 catch + 超时（可参考 `detectAll` 的 `withTimeout`，`plugins/registry.ts:59-67,101-122`），失败落 `card.delivery_failed`。
- 装配点：新增 `src/host/channels.ts`（hub：注册/startAll/stopAll、收 `card.*` 分发、承接 `delivered/answer`），在 effects 之后建、scheduler 之前；通道清单需从 `plugins/registry.ts` 新增 `channels` 导出（当前只有 `executors`，`registry.ts:31-46`）。

## 需评审决策点（建议 + 代价）

1. **通道分发接口**：A 复用 `onFacts`（改 1 文件）；B 新增 `EffectsOptions.subscribers` 通用订阅表（effects + 测试重写）。建议 A（M4 只增一个钩子，M5/M6 再抽通用），代价是与「诊断钩子」语义混用。
2. **回答入口**：A 具名 RPC `cards.answer`（preload/shared/IPC 各加一处，UI 立即可用）；B 提前上 M5 的 `dispatch/query/subscribe` 三动词。建议 A（M4 可独立验收），代价是 M5 要收敛掉这层临时面。
3. **desktop 通道落点**：A `Sdk` 增 `notify`，Notification 留在 main 注入（改 sdk types/sdk-host/createSdk/boundary 4 处）；B 放行 `host/notify.ts` import electron（改 ESLint）。建议 A（守住「host 无 Electron」，M7 外部插件可复用），代价是新能力面要过门控测试。
4. **in-app 通道形态**：A 只做投影 + effects 分发，不实现 `ChannelPlugin.start`（UI 读视图）；B 与 desktop 同构实现完整 `ChannelPlugin`。建议 B（SPEC 要求每类插件契约测试，空 start 成本很低），代价是多一个几乎无逻辑的插件目录。
5. **回答续接的输入形态**：A 新命令 `card.answer`（复用 `commandId` 幂等，`store/index.ts:144-160`）；B 宿主输入 `run.answer`（不经 IPC）。建议 A（与 SPEC-kernel 输入表一致：`card.answer → card.answered + run.queued`，`SPEC-kernel.md:161,307`），代价是 `COMMAND_NAMES` 公开面 +1，需同步 validate 与 IPC 方法表。
