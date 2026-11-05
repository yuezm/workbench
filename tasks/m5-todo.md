# M5 任务清单（客户端插件）

> 进度（2026-11-05，M5 退出）：T1–T11 已全部交付。提交链 `3ae3635`（计划）→ `eeefced`（契约/内核）→ `6fad6a4`（kernelStore/AppPlugin）→ `f19da18`（命令路由/幂等/feed/IPC/宿主测试）→ `5ef7936`（renderer 迁移与 e2e）→ 退出记录。门禁：`pnpm check` exit 0、105 文件 / 1330 用例、覆盖率 99.89/98.18/100/100、改动行 565/565 = 100%、`pnpm e2e` 8/8。证据与已知边界见 refactor-plan 的 M5 退出记录；下文勾选框保留为原始验收项。
>
> 计划说明见 [m5-plan.md](./m5-plan.md)。规则：每个任务结束跑 `pnpm check:fast`；检查点跑完整 `pnpm check` 与 `pnpm e2e`。
> 本阶段把 32 方法 RPC 表收敛成 `dispatch/query/subscribe` 三动词；renderer 用 `kernelStore`（快照 + `seq` + 失效表）读内核视图；`AppDefinition` 升级 `AppPlugin`；pomodoro 发 app 事件。
> 前置：分支 `refactor/m5-client` @ `337667f` 已开；契约与口径以 m5-plan「架构决议 D1–D12」为准；`floor-guard` 扫描未跟踪文件全文，本文件不得出现关闭检查器/未完成标记/放松测试的写法。

## 阶段 1：契约与宿主

### T1 契约：三动词 / 命令 / 视图 / 校验

**描述：** 新增 `protocol/ipc.ts`（`DispatchResult`、`CommandResults`、`KernelEvent`、通道名）；`protocol/commands.ts` 增 `chat.create/send/remove/cancel`、`app.event`；`protocol/inputs.ts` 移除同名 `conversation.*` 宿主输入；`protocol/views.ts` 增 `tasks.executing`、`runtimes.statuses`、`kernel.seq` 与三个宿主视图 id；`protocol/validate.ts` 校验新命令与视图参数；`shared/workbench-api.ts` 改为 `dispatch/query/subscribe/notify`；新增 `shared/apps.ts` 的 `APP_EVENTS`。

**验收标准：**

- [ ] `COMMAND_NAMES` 与 `HOST_INPUT_NAMES` 不重叠；`INPUT_NAMES` 一致
- [ ] `validateCommand` 接受合法 `chat.*` / `app.event`，拒绝未知 app/type、超长字段、非法视图参数
- [ ] `WorkbenchApi` 只有 4 个键，renderer 可直接从 `protocol` 取 `Command`/`ViewId` 类型

**验证：**

- [ ] `pnpm test tests/protocol` 绿

**依赖：** 无　**涉及文件：** `src/protocol/**`、`src/shared/**`、`tests/protocol/**`　**规模：** L

### T2 内核：聊天命令 / 取消 / app 事件

**描述：** `kernel/decide.ts` 把原 `conversation.create/send/remove` 分支改为 `chat.*`；新增 `chat.cancel`（按 `conversationId` 查活跃 run，逐条产 `run.cancel_requested`）；新增 `app.event`（产 `event.received`，`source='app'`、`hops=1`、`originRunId=null`、`summary` ≤200）；`kernel/view-spec.ts` 补切片。

**验收标准：**

- [ ] 原聊天行为零变化（创建/发送/失败文案/单轮并发校验）
- [ ] `chat.cancel` 对无活跃 run 零事实、对多条活跃 run 各一条
- [ ] `app.event` 的 `event.received` payload 与回执派生事件同形

**验证：**

- [ ] `pnpm test tests/kernel` 绿

**依赖：** T1　**涉及文件：** `src/kernel/{decide,view-spec}.ts`、`tests/kernel/**`　**规模：** M

### T3 幂等：commands 表与事实回放

**描述：** `host/schema.ts` 增 `commands(command_id PK, first_seq, fact_count, at)`；`host/store/facts.ts` 增按 seq 范围回放；`host/store/index.ts` 对带 `commandId` 的输入查表、命中回放、成功同事务入表；新增 `commandFacts(commandId)` / `rememberCommand(...)` 供编排命令使用。

**验收标准：**

- [ ] 同一 `commandId` 提交两次：第二次零新事实、返回相同事实集
- [ ] 零事实命令也记录（回放空数组）；reject 不记录
- [ ] 重建后 `commands` 表保留、幂等仍生效

**验证：**

- [ ] `pnpm test tests/host/store tests/host/schema` 绿

**依赖：** T1　**涉及文件：** `src/host/{schema.ts,store/**}`、`tests/host/**`　**规模：** L

### T4 读视图与宿主视图

**描述：** `store/views.ts` 增 `tasks.executing`、`runtimes.statuses`、`kernel.seq`；`protocol/views.ts` 登记；三动词路由支持装配根注入的宿主视图（`runtimes.executors` / `runtimes.detected` / `runtimes.models`）。

**验收标准：**

- [ ] `tasks.executing` 含 queued/running/waiting 的 taskId，去重
- [ ] `runtimes.statuses` 与现 `runtimes.statuses` 方法逐行等价
- [ ] `kernel.seq` = `facts` 最大 seq

**验证：**

- [ ] `pnpm test tests/host/store/views.test.ts` 绿

**依赖：** T1　**涉及文件：** `src/protocol/views.ts`、`src/host/store/views.ts`、`tests/host/store/views.test.ts`　**规模：** M

### T5 命令路由 / 事实推送 / 装配

**描述：** 新增 `host/commands.ts`（探测编排、前置取消、结果取值、幂等）与 `host/feed.ts`（事实批次 ≤500 / 16 ms、流事件、订阅者隔离）；`main/ipc.ts` 注册 `dispatch/query/subscribe` 与 `kernel-event` 推送；`preload/index.ts` 只暴露 `workbench`；`main/index.ts` 接 feed 与命令路由。

**验收标准：**

- [ ] `dispatch` 校验失败返回 `{ code, message }`，reject 文案可读
- [ ] 同一 `commandId` 经 IPC 重复提交不重复产事实
- [ ] 事实批次 seq 单调、`types` 去重；流事件即时到达
- [ ] `window.workbench` 只含 dispatch/query/subscribe/notify

**验证：**

- [ ] `pnpm test tests/host tests/main tests/preload` 绿

**依赖：** T2–T4　**涉及文件：** `src/host/{commands,feed}.ts`、`src/main/{ipc,index}.ts`、`src/preload/index.ts`、`tests/host/**`、`tests/main/**`、`tests/preload/**`　**规模：** L

### 检查点 A/B（T1–T5）

- [ ] `pnpm typecheck`、`pnpm lint` 绿
- [ ] 幂等、批次、三动词契约用例全绿
- [ ] 旧库副本首启正常（无投影变化）

## 阶段 2：renderer

### T6 kernelStore 与 AppPlugin

**描述：** 新增 `renderer/src/shell/kernelStore.ts`（`configureKernel`、快照 seq、缓冲回放、失效表、`useKernelView`、stream 订阅）与测试；`shell/types.ts` 改名 `AppPlugin` + `events?`；`registry.ts` 改 `appPlugins`；`Workbench` 同步；`main.tsx` 启动 store。

**验收标准：**

- [ ] 启动顺序：先 subscribe 缓冲 → `kernel.seq` 快照 → 回放 `seq >` 快照
- [ ] 同一窗口只调用一次 `workbench.subscribe`
- [ ] 失效后按需重取；组件不自己推导
- [ ] `useKernelView` 在失效时重取、跨视图不串数据

**验证：**

- [ ] `pnpm test tests/renderer/src/shell` 绿

**依赖：** T1　**涉及文件：** `src/renderer/src/shell/**`、`src/renderer/src/main.tsx`、`tests/renderer/src/shell/**`　**规模：** L

### T7 ai-workflow 应用迁移

**描述：** `AiWorkflowPage` 删 reload 链与 onChanged，改 `useKernelView`；看板「执行中」改读 `tasks.executing`；RunLog 删 1 s 轮询、事件改 `run.events` 视图；审批条改 `cards.open` 视图 + `card.answer` 命令；聊天改视图 + `dispatch` + kernelStore stream；设置区（运行时/智能体/工作流）改 `dispatch` + 视图；删除 `api.ts` 与 `window.aiWorkflow` 引用；组件测试改 fake transport。

**验收标准：**

- [ ] 看板「执行中」只来自 `tasks.executing`，不再逐任务拉 `runs.listByTask`
- [ ] RunLog 无 setInterval 轮询，事件随失效刷新
- [ ] 聊天发送/取消/创建/删除全走命令；流事件来自 subscribe
- [ ] 设置区 CRUD 返回实体仍能选中新建项
- [ ] 现有组件行为与文案不变

**验证：**

- [ ] `pnpm test tests/renderer/src/apps` 绿

**依赖：** T6　**涉及文件：** `src/renderer/src/apps/ai-workflow/**`、`tests/renderer/src/apps/ai-workflow/**`　**规模：** XL

### T8 pomodoro 事件

**描述：** `pomodoro` 注册 `events: ['pomodoro.completed']`；计时结束 `dispatch({ type:'app.event', ... })`；通知仍走 `workbench.notify`；补测试。

**验收标准：**

- [ ] 计时完成发一条 `app.event`（appId=pomodoro、type=pomodoro.completed）
- [ ] 未声明类型不会从 pomodoro 发出（注册表断言）
- [ ] 通知行为不变

**依赖：** T6　**涉及文件：** `src/renderer/src/apps/pomodoro/**`、`tests/renderer/src/apps/pomodoro/**`　**规模：** S

## 阶段 3：收尾

### T9 旧 RPC 删除与 e2e 适配

**描述：** 删除 `src/shared/ai-workflow-api.ts`、`src/main/ai-workflow/ipc.ts`、`apps/ai-workflow/api.ts`；`api.d.ts` 只声明 `workbench`；清理常量与测试；e2e（审批 / 聊天 / 看板）按新桥接适配。

**验收标准：**

- [ ] `grep` 无 `window.aiWorkflow` / `AI_WORKFLOW_CHANNEL` / `AI_WORKFLOW_CHAT`
- [ ] `pnpm e2e` 全绿

**依赖：** T5、T7　**涉及文件：** `src/**`、`tests/**`　**规模：** M

### T10 覆盖率与门禁

**描述：** 新增分支用例补口；清单类断言同批更新；`pnpm check`、`check:diffcov`、`pnpm e2e`。

**验收标准：**

- [ ] 覆盖率不低于 99.85/98.12/100/100
- [ ] 改动行 ≥90%
- [ ] `check:floor` / `check:secrets` clean

**依赖：** T1–T9　**规模：** M

### T11 验收与退出记录

**描述：** 真 CLI 一轮（聊天 + 卡片 + 拖拽）；SPEC-host / SPEC-shell / SPEC-plugins / CAPABILITY-MAP / refactor-plan M5 记录同步。

**验收标准：**

- [ ] 真 CLI 手工验收通过（等待期零进程沿用 M4 证据）
- [ ] 五份文档同步，无「旧 RPC 仍存在」描述
- [ ] `refactor-plan` 写入 M5 退出记录（提交链、门禁数字、已知边界）

**依赖：** T10　**规模：** M
