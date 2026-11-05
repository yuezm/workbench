# Spec: host（宿主）与客户端

> Module ids：`host`（Electron 主进程）与 `shell`（renderer 外壳）。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。总纲见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> 边界：**宿主是唯一有副作用的层**；renderer 是纯客户端，不持有业务权威状态。

## 目录

```
src/
├── kernel/          # 纯内核（SPEC-kernel）
├── protocol/        # 输入/回执/规则/manifest 的校验与类型
├── host/
│   ├── boot.ts      # 装配根：单实例、开库、插件、定时器、窗口、IPC
│   ├── db.ts        # node:sqlite 连接、PRAGMA、事务
│   ├── store/       # 事实追加 + 投影读写 + 重建 + 视图装载（按 viewSpec 切片）
│   ├── clock.ts     # 唯一 setInterval/setTimeout：按 nextWakeAt 唤醒
│   ├── effects.ts   # afterCommit：把事实分发给调度器/通道/窗口
│   ├── channels.ts  # 通道 hub：注册/启停/分发/补投（卡片投递）
│   ├── scheduler.ts # 按运行时领取可跑的 run → 调用执行器插件 → 转交回执
│   ├── executor.ts  # 执行器插件 → ExecutorPort 包装（终态归一、续接重试）
│   ├── executor-registry.ts # 按 runtime.executorKey 取插件端口，组装 SchedulerExecutors
│   ├── sdk-host.ts  # 插件能力面原件（spawn/解析/杀树/扫描目录/时钟/日志/会话根/notify）
│   ├── thread-context.ts # 从事实派生线程上下文（≤6000 字，确定性截断）
│   ├── reconcile.ts # 启动对账：租约过期、残留 running、未完成对话轮次
│   ├── process.ts   # spawn、行读取、进程树终止（沿用现有实现）
│   ├── artifacts.ts # 事件资料落盘 artifacts/<eventId>.md
│   ├── plugins/     # 插件加载、配置、能力授权
│   ├── ipc.ts       # dispatch / query / subscribe 三个入口
│   └── tray.ts, window.ts
├── main/
│   ├── index.ts     # 装配根：单实例、开库、插件清单注入、通道启停、窗口、IPC
│   └── notify.ts    # Electron Notification（sdk.notify 原件；host 不 import electron）
├── preload/index.ts # contextBridge：三个动词
├── shared/          # IPC 契约类型（由 kernel/protocol 派生）
└── renderer/src/
    ├── shell/       # Workbench、TopBar、插件槽、kernelStore
    └── apps/        # app 插件（pomodoro、ai-workflow）
```

## 宿主职责

| 模块                | 职责                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boot`              | 单实例锁、开库、校验指纹并重建、装配插件、启动 sources/channels、挂单定时器、建窗口与托盘                                                                                                                                                                    |
| `store`             | 每个输入：按 `viewSpec` 装载切片 → `decide` → 事务内追加事实 + 应用 `project` 变更 → 更新 `projection_meta`                                                                                                                                                  |
| `clock`             | 只挂一个定时器：`nextWakeAt` 到点发 `clock.tick`；窗口不可见时不降频（托盘常驻）                                                                                                                                                                             |
| `effects`           | 提交后分发：新 `run.queued` 唤醒调度器；`card.opened/updated` 交给通道 hub（fire-and-forget、异常隔离）；事实增量批量推 renderer                                                                                                                             |
| `channels`          | 通道 hub（M4）：按 `plugins/registry.ts` 的 `channels` 顺序启停；分发 `card.opened/updated`、启动补投 `delivery='pending'` 的 open 卡、承接 `delivered` / `answer` 回调；首个成功回 `card.delivered{ref}`，全失败回 `card.delivery_failed`；投递不阻塞写路径 |
| `scheduler`         | 按运行时（`maxConcurrent`）向内核 `run.claim`，领取后按 `runtime.executorKey` 调执行器插件 `run(turn)`；回执转交内核；不自己判断派给谁；线程串行由内核保证                                                                                                   |
| `executor-registry` | 按 `runtime.executorKey` 从装配根注入的插件清单取执行器端口；未知 key 返回 `null`（不猜、不降级），由调度器落兜底终态                                                                                                                                        |
| `thread-context`    | 拼提示词前按事实派生「线程上下文」：元信息、任务、最近 3 条运行摘要、未决卡片、最近 10 条笔记、资料清单；同事实必得同文本，≤6000 字                                                                                                                          |
| `reconcile`         | 启动与定时对账：`claimed` 超租约 → 先终止残留子进程再 `run.abandoned`；`waiting` 保留卡片；`waiting` 且无 open 卡的历史 run 补 `run.host_settled{cancelled}`（D13）；中断的聊天轮次落错误消息                                                                |
| `artifacts`         | 事件资料、大输出尾部；路径 `userData/artifacts/<eventId>.md`，保留 30 天                                                                                                                                                                                     |
| `plugins`           | 注册表装载、配置读写、能力授权、失败隔离（插件异常不拖垮宿主）                                                                                                                                                                                               |

- **未知执行器**：运行时配置的 `executorKey` 在插件注册表里找不到时，调度器不 spawn、不改配置，直接 `run.host_settled` 落 `failed` + `runtime_missing`（文案带 key 便于定位）；不新增 `errorCode`，取值仍是 10 个。
- **执行器清单来源**：宿主不 import 具体插件实现；装配根（`src/main`）把 `src/plugins/registry.ts` 的静态清单注入 `executor-registry` 与 IPC，测试可注入假插件。

## 存储与单实例

- 启动第一件事：`app.requestSingleInstanceLock()`；拿不到锁就聚焦已有窗口并退出（双实例同库会直接产生 `seq` 冲突）。
- SQLite PRAGMA：`journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`、`synchronous=NORMAL`；启动时跑 `PRAGMA integrity_check`，失败先备份坏库、再从事实重建。
- 事务：追加事实 + 应用投影 + 更新 `projection_meta.seq` 在同一事务内完成；提交成功才向调用方应答。
- 宿主兜底写入：执行器不可达、超时或取消无回执时，宿主以 `run.host_settled` 输入写终态（`run.failed` 的 `timeout`/`executor_lost`，或 `run.cancelled` 的 `cancelled`；见 SPEC-kernel「输入目录」），不让 run 悬空。
- **M3 结构升级**：`runtimes` 从旧列 `protocol_family`（旧字段，仅迁移归一用）改成 `executor_key` + `args_template`；旧列被 CHECK 引用、不能 `DROP COLUMN`，因此与 M2 的 `runs` 同法做一次性物理重建（外键 OFF → 临时表 → 拷贝旧行并回填 → 删旧 → 改名）；升级在 `openDatabase` 内完成。
- **启动顺序固定**：「结构升级（`openDatabase`）→ 存量导入（`importLegacyIfNeeded`）→ 指纹重建（`store.ensureProjection`）」。重建 fold 的是历史事实 payload，所以老 payload 的归一函数（`normalizeRuntime`）必须先于指纹/DDL 变化落地，否则老库升级失败。
- 备份：`userData/workbench.db` 与 `userData/artifacts/` 直接复制即完整备份（事实日志自足）；设置页提供「导出全部事实为 JSON」。

## IPC 契约

```ts
// src/shared/workbench-api.ts（M5：三动词 + 通知）
export interface WorkbenchApi {
  dispatch<C extends Command>(command: C): Promise<CommandDispatchResult<C>>
  query<T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>>
  subscribe(handler: (event: KernelEvent) => void): () => void
  /** shell 的通用通知（pomodoro 等 app 用）；ai-workflow 卡片通知走 channel:desktop 的 sdk.notify */
  notify(title: string, body?: string): void
}

export type KernelEvent =
  | { kind: 'facts'; seq: number; types: FactType[] } // 只推「发生了什么」，客户端按需重取视图
  | { kind: 'stream'; runId: string; conversationId: string | null; event: RunEvent }
  | { kind: 'stream-end'; runId: string; conversationId: string | null }
```

- **三个动词之外不新增 RPC 方法**（M5 起合同收紧）：app 插件的命令统一走 `dispatch`，命名 `app.<id>.<action>`；
  ai-workflow 的领域命令是 `workflow.* / agent.* / runtime.* / task.* / card.* / chat.* / app.event`。
  M3 的 `runtimes.executors`、M4 的 `cards.open` / `cards.answer` 具名方法已收敛：前者是宿主视图
  `runtimes.executors`，后者是 `cards.open` 视图 + `card.answer` 命令。
- **通道**：`workbench:dispatch` / `workbench:query`（renderer → main，应答信封 `{ok:true,value}` /
  `{ok:false,error:{code,message}}`，preload 解包失败时抛带文案的 Error）、`workbench:kernel-event`
  （main → renderer 单向推送）。`window.aiWorkflow` 与 `AI_WORKFLOW_*` 常量已删除。
- 每个命令在宿主入口用 `protocol/validate` 校验，renderer 传入的是不可信数据；命令带 `commandId`，
  重复提交返回原结果（`commands` 表按事实区间回放，不重复决策、不重复产事实）；reject 不缓存。
- 视图 id 固定清单（`src/protocol/views.ts`）：`workflows.all`、`agents.all`、`runtimes.all`、
  `runtimes.workloads`、`tasks.byWorkflow`、`task.byId`、`runs.active-by-task`、`runs.active-by-conversation`、
  `runs.byTask`、`run.byId`、`run.events`、`run.last-event-seq`、`runs.stale-chat`、`conversations.all`、
  `messages.byConversation`、`cards.open`、`cards.byRun`、`runs.waiting`、**M5 新增** `tasks.executing`、
  `runtimes.statuses`、`kernel.seq`、`runtimes.executors`、`runtimes.detected`、`runtimes.models`。
  其中后三个是**宿主视图**：由装配根注入只读函数（插件注册表 / CLI 探测 / 执行器
  模型目录 / 运行时负载拼装），与 DB 视图共用同一个 `query` 动词，不写库、不发失效。
- `tasks.executing`：存在 `queued/running/waiting` run 的任务 id 去重集合；看板「执行中」只读它。
- `kernel.seq`：事实日志最大 seq，kernelStore 的启动快照水位。
- 续传顺序：窗口加载时**先 `subscribe` 并缓冲**，再 `query('kernel.seq')` 取快照，最后回放缓存中
  `seq > 快照 seq` 的批次；批次上限 500 条事实或 16 ms，取先到者。聊天流 `stream / stream-end` 即时旁路，
  不进批次。同一窗口只建立一个 IPC 订阅。

## renderer

- `shell/kernelStore.ts`：快照 `seq` + 视图缓存 + 失效表；收到 facts 只做失效，视图按需重取（v1 不做
  乐观更新）。`useKernelView(view, params)` 用 `useSyncExternalStore` 实现；需要展示读失败时用
  `useKernelViewState(view, params)`（`{data,error,loading}`）。组件不自己拼派生状态（「执行中」由
  `tasks.executing` 给）、不轮询、不重复订阅。
- 插件槽：`Workbench` 从 `appPlugins` 清单渲染顶部栏与内容区；新增 app = 新目录 + `appPlugins` 一行
  （沿用现有 `registry.ts` 机制，类型是 `AppPlugin`）。
- 聊天：执行器 `io.emit` 的帧实时走 `stream` 旁路用于显示；同一批帧由宿主按批写 `run.frames` 事实，
  一轮结束写终态事实与 `message.appended`。重建后事件流完整，UI 不依赖旁路作为数据源。
- 禁止：renderer 直接 import `electron` / Node 内置；在组件里写阶段规则；用轮询补状态。

## 启动与关闭

启动：单实例锁 → 开库与 PRAGMA（含旧库 `runs` / `runtimes` 一次性结构升级）→ 存量导入（v2 老库第一次启动）→ 校验 `projection_meta`（不匹配或 `seq` 落后则从事实重建）→ 构造插件能力面与执行器注册表（静态清单，注入 IPC 与调度器）→ 对账 → 构造 effects（`onFacts` 接事实批次 feed）→ **启动通道（M4：`startAll`，补投 `pending` 卡片）** → 启动调度器 → 构造命令路由 + 注册三动词 IPC → 挂定时器 → 建窗口/托盘。

关闭：停 channels（abort + best-effort dispose）→ 停事实推送（feed.stop）→ 终止在跑子进程（cancel → SIGTERM → SIGKILL）→ 关闭 DB → 退出。窗口关闭只隐藏到托盘，不触发关闭流程。

## 错误与诊断

- 宿主把内核 `reject` / `StoreError` 映射为 `{ code, message }`；IPC 用应答信封 `{ok:false,error}` 过桥
  （preload 转成 Error），UI 按 `code` 分支、按 `message` 展示。
- 结构日志写 `userData/logs/`（按天轮转，保留 7 天）：每次决策记录 `input.type / facts 数 / 装载+决策耗时`；不记 prompt 全文、不记密钥。
- 运行详情面板消费 `timeline.ofRun`，展示触发事件、规则版本、智能体、运行时、回执、流转；不再靠协议帧推断。
- 崩溃恢复验收：强杀进程后重启，`claimed` 运行被回收、任务可拖动、卡片仍在、聊天轮次显示中断错误。

## 安全

- 窗口：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；preload 只暴露三个动词。
- 路径：renderer 不能传任意 `cwd`；执行目录只能来自运行时配置、规则或项目配置。
- 密钥：只存主进程（`plugin_config` 的 secret 字段，`safeStorage` 加密），不进快照、不进日志、不进子进程环境白名单之外。
- 外部链接：`shell.openExternal` 只接受 `http(s)` 且域名白名单。

## 测试

- **store：** 内存 SQLite 测「决策 → 事实 → 投影」原子性、并发冲突重试、按 `viewSpec` 装载切片、重建等价。
- **effects：** 提交后分发的订阅者隔离（一个通道抛错不影响其它）；`card.opened/updated` 后通道 hub 被调用，且写路径不被慢通道拖住。
- **channels：** 假通道覆盖「按 registry 顺序分发、首个成功回 `card.delivered`、全失败回 `card.delivery_failed`、只补投 `pending`、通道超时/抛错隔离、`answer` 发 `card.answer{via:'channel'}`」。
- **reconcile：** 假时钟测租约过期回收、残留子进程终止、attempts 递增、退避；`waiting` 有卡保留、无卡补取消（D13）。
- **IPC：** 三动词形状（preload 只暴露 dispatch/query/subscribe/notify）；命令校验拒绝非法载荷；
  `commandId` 幂等（重复提交回放原事实、reject 不缓存）；`query` 的视图/参数校验；订阅先缓冲后回放；
  未知 `executorKey` 给可读错误。
- **命令路由：** 普通命令直达内核；编排命令（`runtime.create/update/probe`）先探测再落事实，
  幂等命中不重复探测；删除类命令先取消活跃 run。
- **feed：** 批次合并与上限、流旁路即时、订阅者异常隔离。
- **renderer：** kernelStore 启动顺序（subscribe → `kernel.seq` 快照 → 回放）与失效重取；单订阅；
  `AppPlugin` 清单渲染；聊天流合并与结束。
- **thread-context：** 同一事实集重复派生文本全等；超长按时间倒序截断且标注；笔记/事件正文只作资料段出现，不混进指令段。
- **E2E：** 现有 Playwright 关键路径 + 一条「审批挂起 → 回答 → 续接跑完」。
