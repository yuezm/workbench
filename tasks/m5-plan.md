# 实施计划：M5 客户端插件（IPC 三动词 / kernelStore / AppPlugin）

> 依据 [refactor-plan](../docs/planning/refactor-plan.md) M5 行、[ARCHITECTURE.md](../docs/ARCHITECTURE.md)（IPC 收敛、renderer 快照 + 增量）、[SPEC-host.md](../docs/specs/SPEC-host.md)（IPC 契约、renderer、启动顺序）、[SPEC-plugins.md](../docs/specs/SPEC-plugins.md)（app 插件）、[SPEC-shell.md](../docs/specs/SPEC-shell.md)（外壳与 AppDefinition）。
> 起点：`master` @ `337667f`（M4 退出后，M4 已 fast-forward 合入 `master`）。工作分支 `refactor/m5-client`。
> 目标：**写只走 `dispatch`、读只走 `query`、变更只走 `subscribe`**——30 余方法的 RPC 表收敛成三个动词；renderer 用 `kernelStore`（快照 + `seq` + 失效表）统一读内核视图；app 插件只声明视图与组件，不再自己算「执行中」；同一窗口只订阅一次；重连按 `seq` 续传。
> 本阶段不做：规则与线程（M6/M6.5）、外部插件子进程（M7）、timeline 视图（M6）、回执块重写（M6）。

## 开工前提（2026-11-05）

- 分支 `refactor/m5-client` @ `337667f`；工作树干净。
- 门禁基线：`pnpm check` exit 0；覆盖率 **99.85 / 98.12 / 100 / 100**（阈值 98/93/95/98）；`check:diffcov` 门槛 90%；`pnpm e2e` 8/8。
- `floor-guard` 默认 base 是 `master`，必须在分支上工作（直接改 `master` diff 为空会假绿）；扫描未跟踪文件全文，本计划与任务清单不得出现关闭检查器/未完成标记/放松测试的写法。
- 实库仍是 v2 格式，首启走 `host/store/import.ts` 兼容层；M5 不改投影表、不改 `KERNEL_VERSION`，兼容层不删。

## 现状（测绘结论，2026-11-05）

| 事实                                                                                                                                                                           | 证据                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| renderer ↔ main 是一张 32 方法的 RPC 表（单一 `ai-workflow:invoke` 通道 + `aiWorkflow:changed` 无载荷广播 + `ai-workflow:chat` 旁路）；`window.workbench` 只有 `notify`        | `src/main/ai-workflow/ipc.ts:169-393`、`src/preload/index.ts`、`src/shared/ai-workflow-api.ts`、`tests/preload/index.test.ts` |
| 命令契约只覆盖配置三组 + 任务四动作 + 卡片两条；聊天四个动作还是宿主输入（无 `commandId`）；`commandId` **零实现**（只校验长度，重复提交会重复产事实）                         | `src/protocol/commands.ts:19-36`、`src/protocol/inputs.ts:20-34,169-194`、`kernel/` 全目录无 commandId 逻辑                   |
| 读路径全部经具名方法打到 `store.query`，没有 `query(view, params)` 入口；`runs.events` 由 RunLog 1 s 轮询；看板按任务逐个拉 `runs.listByTask` 现算「执行中」并自行订阅 changed | `src/main/ai-workflow/ipc.ts:169-393`、`KanbanBoard.tsx:29-108`、`RunLog.tsx:126-159`、`AiWorkflowPage.tsx:100-165`           |
| 变更广播无载荷：renderer 收到即全量重拉；没有快照 `seq`、没有失效表、没有续传                                                                                                  | `src/main/index.ts:97-99,211-220`、`src/main/ai-workflow/ipc.ts:398-401`                                                      |
| `AppDefinition` 只有 id/name/icon/component，无 `events`；app 注册表是 shell 唯一数据源                                                                                        | `src/renderer/src/shell/types.ts`、`shell/registry.ts`                                                                        |
| pomodoro 只发系统通知（`window.workbench.notify`），没有事件出口                                                                                                               | `apps/pomodoro/**`、`src/shared/workbench-api.ts`                                                                             |
| 视图清单 18 个，缺「活跃任务集合」「运行时负载汇总」「内核 seq」；`runtimes.detect/executors/models` 是只读具名方法                                                            | `src/protocol/views.ts:23-42`、`src/main/ai-workflow/ipc.ts:222-246`                                                          |
| 宿主 `effects.dispatch` 已是唯一写入口（IPC / scheduler / clock / 通道），`afterCommit` 有现成 hook                                                                            | `src/host/effects.ts:61-91`、`src/main/index.ts:187-208`                                                                      |

## 架构决议（M5 口径）

| #   | 缺口        | M5 口径                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | IPC 三动词  | `WorkbenchApi = { dispatch(command), query(view, params), subscribe(handler), notify }`；通道 `workbench:dispatch` / `workbench:query` / `workbench:kernel-event`。三个动词之外不新增方法；`window.aiWorkflow` 与 `AI_WORKFLOW_CHANNEL/CHANGED/CHAT` 删除。                                                                                                                                                       |
| D2  | 命令幂等    | 新增**非投影表** `commands(command_id PK, first_seq, fact_count, at)`；`store.dispatch` 对带 `commandId` 的输入同事务查表，命中即按 `first_seq/fact_count` 从事实日志回放原结果、零新事实。reject 不入表（允许重试）。重建不清 `commands` 表（不属于投影集）。                                                                                                                                                    |
| D3  | 编排类命令  | `runtime.create` / `runtime.update` / `runtime.probe` 需要执行器探测（副作用）后才能落事实：由宿主命令路由（`host/commands.ts`）先探测、再经 `effects.dispatch` 写内核事实；路由以同一 `commandId` 查 `store.commandFacts` 做幂等，命中直接返回原结果（不重复探测）。`task.remove` / `workflow.remove` 的前置「取消活跃 run」同样留在路由（先 `run.cancel` 再删，行为与 M4 一致）。                               |
| D4  | 读路径      | 业务数据一律走 `query(view, params)`：新增 DB 视图 `tasks.executing`（全部有 queued/running/waiting run 的 taskId）、`runtimes.statuses`（`runtimes.all` + `runtimes.workloads` 拼装）、`kernel.seq`（事实日志最大 seq）。`runtimes.executors` / `runtimes.detected` / `runtimes.models` 是**宿主视图**：由装配根注入只读函数（插件注册表 / CLI 探测 / 执行器 models），走同一个 `query` 动词、不写库、不发失效。 |
| D5  | 聊天命令化  | `conversation.create/send/remove/rename` 从宿主输入改为命令（带 `commandId`），命名 `chat.create/send/remove`；新增 `chat.cancel` 命令：内核按 `conversationId` 查活跃 run，逐条产 `run.cancel_requested`（与 `run.cancel` 输入同一收尾链路）。`Input` 联合里不再保留同名宿主输入。                                                                                                                               |
| D6  | app 事件    | app 插件可发事件：`AppPlugin.events` 声明前缀；共享清单 `src/shared/apps.ts`（`APP_EVENTS`）同时给 renderer 注册表与宿主校验用。命令 `app.event { appId, type, subject, summary?, detail?, link?, dedupeKey? }`：宿主校验 `appId/type` 属于清单，内核产一条 `event.received`（`source='app'`、`hops=1`、`originRunId=null`、`summary` ≤200 字）。M6 才消费事件。pomodoro 计时结束即发。                           |
| D7  | 事实推送    | `host/feed.ts`：订阅者在提交后收到 `{kind:'facts', seq, types}` 批次（≤500 条或 16 ms，先到者；`seq` = 批内最后一条事实的 seq、`types` 去重）；聊天帧走 `{kind:'stream', runId, conversationId, event}` 与 `{kind:'stream-end', ...}` 即时旁路。`effects.onFacts` 接 feed；删除 `notifyChanged` 广播与 `AI_WORKFLOW_CHAT` 旁路。                                                                                  |
| D8  | kernelStore | `renderer/src/shell/kernelStore.ts`：快照 `seq` + 视图缓存 + 失效表；启动**先 subscribe 并缓冲**，再 `query('kernel.seq')` 取快照，回放 `seq > 快照` 的批次；收到 facts 只做失效，视图按需重取；同一窗口只有一个 IPC 订阅。`useKernelView(view, params)` 用 `useSyncExternalStore`，组件不写派生态。                                                                                                              |
| D9  | 失效映射    | 事实类型 → 视图 id 的失效表写在 kernelStore（`fact.type` 前缀映射，未知类型全量失效兜底）；`run.frames` 失效 `run.events`/`runs.byTask`/`tasks.executing`/`runtimes.statuses`；`card.*` 失效 `cards.open`/`cards.byRun`。                                                                                                                                                                                         |
| D10 | AppPlugin   | `AppDefinition` 更名 `AppPlugin`（id/name/icon/component + `events?`），注册表 `appPlugins`；`Workbench` 只按清单渲染。app 侧只读视图、只发命令；`AiWorkflowPage` 的 reload 链、看板逐任务拉取、RunLog 轮询全部删除。                                                                                                                                                                                             |
| D11 | 旧 RPC 清理 | 删除 `src/shared/ai-workflow-api.ts`、`src/main/ai-workflow/ipc.ts`、`src/renderer/src/apps/ai-workflow/api.ts`；`preload` 只暴露 `workbench`；`api.d.ts` 同步。测试改打 `window.workbench` 或 kernelStore 假 transport。                                                                                                                                                                                         |
| D12 | 门禁与文档  | 阈值不动；清单类断言（COMMAND_NAMES / VIEW_IDS / HOST_INPUT_NAMES / INPUT_NAMES / preload / schema）同批改；新增 `tests/host/commands.test.ts`（幂等 / 探测编排 / 前置取消）、`tests/host/feed.test.ts`（批次与 seq）、`tests/renderer/src/shell/kernelStore.test.ts`（快照续传 / 失效 / 单订阅）；SPEC-host / SPEC-shell / SPEC-plugins / CAPABILITY-MAP / refactor-plan 同步。                                  |

## 目标结构

```
src/
├── protocol/
│   ├── commands.ts        # + chat.create/send/remove/cancel、app.event
│   ├── inputs.ts          # - conversation.*（迁到 commands）
│   ├── ipc.ts             # DispatchResult / CommandResults / KernelEvent / 通道名（新）
│   ├── views.ts           # + tasks.executing、runtimes.statuses、kernel.seq、宿主视图
│   └── validate.ts        # 新命令校验、视图参数校验
├── kernel/
│   ├── decide.ts          # chat.* / app.event / 幂等不在这里（在 store）
│   ├── view-spec.ts       # chat.* / app.event 切片
│   └── prompt.ts          # 不变
├── host/
│   ├── commands.ts        # 命令路由：探测编排、前置取消、结果取值（新）
│   ├── feed.ts            # 事实批次 + 流事件订阅（新）
│   ├── store/index.ts     # 幂等查表 / 回放 / 记录
│   ├── store/{facts,views}.ts  # facts 范围回放、新视图查询
│   └── schema.ts          # commands 表 DDL
├── shared/
│   ├── workbench-api.ts   # 三动词 + notify
│   └── apps.ts            # APP_EVENTS（app 事件白名单，新）
├── preload/index.ts       # 只暴露 workbench
├── main/
│   ├── ipc.ts             # 注册三动词 + kernel-event 推送
│   └── index.ts           # 装配命令路由 / feed / 订阅者广播
└── renderer/src/
    ├── shell/{types,registry,kernelStore,Workbench}.ts(x)
    └── apps/**            # 读视图、发命令、删轮询
```

## 任务拆分

**M5a 契约与宿主（T1–T5 串行）**

| 编号 | 任务                                                                                                                                                                            | 依赖  | 规模 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| T1   | 契约：`protocol/ipc.ts`、`commands.ts` 增聊天/事件命令、`inputs.ts` 移除同名宿主输入、`views.ts` 新视图、`validate.ts` 校验、`shared/workbench-api.ts` 三动词、`shared/apps.ts` | 无    | L    |
| T2   | 内核：`chat.*` 决策分支（沿用原 conversation 逻辑）、`chat.cancel`（逐条 `run.cancel_requested`）、`app.event`（`event.received`）、`view-spec` 切片                            | T1    | M    |
| T3   | 幂等：`commands` 表 + `store.dispatch` 查表回放 / 同事务入表 + `factsBetween` + `commandFacts/rememberCommand`                                                                  | T1    | L    |
| T4   | 读视图：`store/views.ts` 增 `tasks.executing` / `runtimes.statuses` / `kernel.seq`，宿主视图注册与参数校验                                                                      | T1    | M    |
| T5   | 命令路由 `host/commands.ts` + 事实推送 `host/feed.ts` + 装配根 / preload / main IPC 三动词                                                                                      | T2–T4 | L    |

**M5b renderer（T6–T8 可与 T5 尾段并行；kernelStore 先落）**

| 编号 | 任务                                                                                                               | 依赖   | 规模 |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------ | ---- |
| T6   | `shell/kernelStore.ts` + `useKernelView` + `shell/types.ts`（AppPlugin）+ registry/Workbench + 测试                | T1     | L    |
| T7   | ai-workflow：页面/看板/运行记录/聊天/审批改读视图与命令，删 reload 链与轮询；设置区 CRUD 改 dispatch；组件测试迁移 | T6     | XL   |
| T8   | pomodoro：`events: ['pomodoro.completed']` + 计时结束发 `app.event`；通知仍走 `notify`                             | T6, D6 | S    |

**M5c 收尾（T9–T11）**

| 编号 | 任务                                                                                   | 依赖   | 规模 |
| ---- | -------------------------------------------------------------------------------------- | ------ | ---- |
| T9   | 删除旧 RPC 与 `window.aiWorkflow`，`api.d.ts`/测试同步；e2e 适配（审批条回答、聊天流） | T5, T7 | M    |
| T10  | 覆盖率补口：新增分支用例、清单断言、`check:diffcov`、`pnpm e2e`                        | T1–T9  | M    |
| T11  | 验收与退出记录：真 CLI 一轮、README/SPEC/CAPABILITY-MAP/refactor-plan 同步             | T10    | M    |

## 检查点

- **A（T1–T4）**：`pnpm typecheck && pnpm lint` 绿；`tests/protocol`、`tests/kernel`、`tests/host/store` 全绿；同一 `commandId` 重复提交零新事实、返回同一批事实。
- **B（T5）**：`tests/host/{commands,feed}.test.ts` 全绿；三动词 IPC 在 `tests/main` 覆盖；preload 只暴露 `workbench` 且形状=4。
- **C（T6–T8）**：kernelStore 快照续传/失效/单订阅用例绿；组件测试全绿；看板「执行中」只来自 `tasks.executing`；`grep` 无 1 s 轮询与 `runs.listByTask` 现算。
- **D（T9–T11）**：`pnpm check` exit 0、覆盖率不低于基线、改动行 ≥90%；`pnpm e2e` 全绿；SPEC 与索引同步。

## 必须保住的行为（M5 相关，逐条验收）

1. 写路径唯一仍是 `effects.dispatch`；renderer 不能直连 store/DB，命令先校验形状。
2. 重复 `commandId` 返回原结果、不产新事实；reject 不缓存。
3. 「执行中」只认内核视图（`tasks.executing`），看板不再自己按 run 列表推导。
4. 变更到达即失效、按需重取；同一窗口只建立一个 IPC 订阅；加载顺序 subscribe → 快照 → 回放。
5. 聊天流仍是旁路显示、事实是数据源；`end` 后按视图重取消息。
6. 删除任务/工作流前仍先取消活跃 run（进程不成孤儿）。
7. `runtimes.create` 仍「探测通过才落库」；`detect` 只读、无副作用。
8. app 事件只能发清单里声明的类型；事件文字只入库、不进提示词。
9. renderer 禁 Electron/Node；host 不 import 具体插件实现；app 插件之间不互相 import。
10. 质量门禁不放松：覆盖率阈值、改动行 ≥90%、`stage-machine` 分支 100%。

## 验收（退出条件）

- `pnpm check` exit 0；覆盖率不低于基线；`check:diffcov` ≥90%；`pnpm e2e` 全绿。
- IPC 表面只剩 `dispatch/query/subscribe/notify`；`window.aiWorkflow` 不存在。
- kernelStore：先订阅后快照、`seq` 续传、批量失效、单订阅；断线重连（刷新窗口）不丢事实。
- 看板「执行中」来自 `tasks.executing`；RunLog 无轮询；设置区 CRUD 全走 `dispatch`。
- pomodoro 完成发 `event.received`（`source='app'`），宿主拒绝未声明的事件类型。
- 真 CLI 手工验收：聊天一轮、卡片回答、任务拖拽各一次。
- SPEC-host / SPEC-shell / SPEC-plugins / CAPABILITY-MAP / refactor-plan 同步。

## 风险与对策

| 风险                                       | 影响 | 对策                                                                                      |
| ------------------------------------------ | ---- | ----------------------------------------------------------------------------------------- |
| 30 余方法一次替换，组件测试 mock 面大      | 高   | 先落 kernelStore 与测试替身；按 app 区域分批迁移，逐文件改，不批量删断言                  |
| 命令幂等表与事实事务不一致                 | 高   | 幂等查表与入表在 `store.dispatch` 同一事务内完成；编排类命令路由层二次校验 `commandFacts` |
| 宿主视图（detect/models）走 query 语义边界 | 中   | 只读、不写库、不发失效；在 `views.ts` 标 `HostViewId`，参数校验同 DB 视图                 |
| 流式聊天旁路改为 subscribe 后丢帧          | 中   | 帧同时入账；`end` 后按视图重取；旁路只影响实时显示                                        |
| `commands` 表增长无清理                    | 低   | 个人单机量级；退出记录登记后续可加保留策略                                                |
| e2e 依赖旧桥接                             | 中   | 优先跑 `pnpm e2e` 暴露；审批/聊天用例按新选择器改，不改业务断言                           |

## 评审口径（开工即定，实施中不再变更）

1. **聊天命令命名** `chat.*`（与 UI/API 同名），不加 `app.ai-workflow.` 前缀；通用命令前缀规则留 M6 的来源/规则命令。
2. **宿主编排命令**限定为 `runtime.create/update/probe` 与 `task.remove/workflow.remove` 的前置取消；其余命令一律 `decide` 直出事实。
3. **app 事件**只入账、不派活；白名单放 `src/shared/apps.ts`，renderer 注册表与宿主校验共用。
4. **`KERNEL_VERSION` 不递增**：投影表与折叠语义未变，`commands` 表不属于投影集；首启只多执行一条 `CREATE TABLE IF NOT EXISTS`。
5. **测试策略**：host 用假 store/假执行器；renderer 用 `configureKernel(fakeTransport)`；e2e 仍用夹具执行器，不改真 CLI。
