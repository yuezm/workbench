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
│   ├── scheduler.ts # 按运行时领取可跑的 run → 调用执行器插件 → 转交回执
│   ├── thread-context.ts # 从事实派生线程上下文（≤6000 字，确定性截断）
│   ├── reconcile.ts # 启动对账：租约过期、残留 running、未完成对话轮次
│   ├── process.ts   # spawn、行读取、进程树终止（沿用现有实现）
│   ├── artifacts.ts # 事件资料落盘 artifacts/<eventId>.md
│   ├── notify.ts    # Electron Notification（channel:desktop 复用）
│   ├── plugins/     # 插件加载、配置、能力授权
│   ├── ipc.ts       # dispatch / query / subscribe 三个入口
│   └── tray.ts, window.ts
├── preload/index.ts # contextBridge：三个动词
├── shared/          # IPC 契约类型（由 kernel/protocol 派生）
└── renderer/src/
    ├── shell/       # Workbench、TopBar、插件槽、kernelStore
    └── apps/        # app 插件（pomodoro、ai-workflow）
```

## 宿主职责

| 模块             | 职责                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot`           | 单实例锁、开库、校验指纹并重建、装配插件、启动 sources/channels、挂单定时器、建窗口与托盘                                                                  |
| `store`          | 每个输入：按 `viewSpec` 装载切片 → `decide` → 事务内追加事实 + 应用 `project` 变更 → 更新 `projection_meta`                                                |
| `clock`          | 只挂一个定时器：`nextWakeAt` 到点发 `clock.tick`；窗口不可见时不降频（托盘常驻）                                                                           |
| `effects`        | 提交后分发：新 `run.queued` 唤醒调度器；新/更新卡片通知通道；事实增量批量推 renderer                                                                       |
| `scheduler`      | 按运行时（`maxConcurrent`）向内核 `run.claim`，领取后按 `runtime.executorKey` 调执行器插件 `run(turn)`；回执转交内核；不自己判断派给谁；线程串行由内核保证 |
| `thread-context` | 拼提示词前按事实派生「线程上下文」：元信息、任务、最近 3 条运行摘要、未决卡片、最近 10 条笔记、资料清单；同事实必得同文本，≤6000 字                        |
| `reconcile`      | 启动与定时对账：`claimed` 超租约 → 先终止残留子进程再 `run.abandoned`；`waiting` 保留卡片；中断的聊天轮次落错误消息                                        |
| `artifacts`      | 事件资料、大输出尾部；路径 `userData/artifacts/<eventId>.md`，保留 30 天                                                                                   |
| `plugins`        | 注册表装载、配置读写、能力授权、失败隔离（插件异常不拖垮宿主）                                                                                             |

## 存储与单实例

- 启动第一件事：`app.requestSingleInstanceLock()`；拿不到锁就聚焦已有窗口并退出（双实例同库会直接产生 `seq` 冲突）。
- SQLite PRAGMA：`journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`、`synchronous=NORMAL`；启动时跑 `PRAGMA integrity_check`，失败先备份坏库、再从事实重建。
- 事务：追加事实 + 应用投影 + 更新 `projection_meta.seq` 在同一事务内完成；提交成功才向调用方应答。
- 宿主兜底写入：执行器不可达、超时或取消无回执时，宿主以 `run.host_settled` 输入写终态（`run.failed` 的 `timeout`/`executor_lost`，或 `run.cancelled` 的 `cancelled`；见 SPEC-kernel「输入目录」），不让 run 悬空。
- 备份：`userData/workbench.db` 与 `userData/artifacts/` 直接复制即完整备份（事实日志自足）；设置页提供「导出全部事实为 JSON」。

## IPC 契约

```ts
// src/shared/workbench-api.ts
export interface WorkbenchApi {
  dispatch(command: Command): Promise<CommandResult>
  query<T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>>
  subscribe(handler: (event: KernelEvent) => void): () => void
  /** 兼容旧契约，M5 后由 channel:desktop 接管 */
  notify(title: string, body?: string): void
}

export type KernelEvent =
  | { kind: 'facts'; seq: number; types: FactType[] } // 只推「发生了什么」，客户端按需重取视图
  | { kind: 'stream'; runId: Id; event: RunEvent } // 运行中的文本/工具帧的实时旁路（同时按批入账）
  | { kind: 'stream-end'; runId: Id }
```

- 三个动词之外不新增 RPC 方法；app 插件的命令统一走 `dispatch`，命名 `app.<id>.<action>`。
- 每个命令在宿主入口用 `protocol/validate` 校验，renderer 传入的是不可信数据；命令带 `commandId`，重复提交返回原结果。
- 视图 id 固定清单（`src/protocol/views.ts`）：`tasks.byWorkflow`、`workflows.all`、`agents.all`、`runtimes.all`、`runtimes.detected`、`threads.open`、`thread.byId`、`thread.timeline`、`runs.byTask`、`run.events`、`runs.active`、`cards.open`、`conversations.all`、`messages.byConversation`、`timeline.ofRun`、`state.overview`。
- 续传顺序：窗口加载时**先 `subscribe` 并缓冲**，再取快照，最后回放缓冲中 `seq > 快照 seq` 的批次；批次上限 500 条或 16 ms，取先到者。

## renderer

- `shell/kernelStore.ts`：快照 + `seq` + 失效表；收到 `facts` 只做失效，视图按需重取（v1 不做乐观更新）。
- `useKernelView(view, params)`：`useSyncExternalStore` 实现；组件不自己拼派生状态（「执行中」由内核视图给）。
- 插件槽：`Workbench` 从 `appPlugins` 清单渲染顶部栏与内容区；新增 app = 新目录 + `appPlugins` 一行（沿用现有 `registry.ts` 机制，类型换成 `AppPlugin`）。
- 聊天：执行器 `io.emit` 的帧实时走 `kernel:stream` 旁路用于显示；同一批帧由宿主按批写 `run.frames` 事实，一轮结束写终态事实与 `message.appended`。重建后事件流完整，UI 不依赖旁路作为数据源。
- 禁止：renderer 直接 import `electron` / Node 内置；在组件里写阶段规则；用轮询补状态（现有 `RunLog` 的 1 s 轮询与 runner 广播的双更新一起删掉）。

## 启动与关闭

启动：单实例锁 → 开库与 PRAGMA → 校验 `projection_meta`（不匹配则重建）→ 载入插件与配置 → 对账 → 启动 sources/channels 与调度器 → 挂定时器 → 建窗口/托盘 → 注册 IPC → 通知 renderer 取快照。

关闭：停 sources/channels → 终止在跑子进程（cancel → SIGTERM → SIGKILL）→ 关闭 DB → 退出。窗口关闭只隐藏到托盘，不触发关闭流程。

## 错误与诊断

- 宿主把内核 `reject` 映射为 `{ code, message }` 返回；UI 按 `code` 分支，不匹配中文文案。
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
- **effects：** 提交后分发的订阅者隔离（一个通道抛错不影响其它）。
- **reconcile：** 假时钟测租约过期回收、残留子进程终止、attempts 递增、退避、超限开卡片。
- **IPC：** 命令校验拒绝非法载荷；`commandId` 幂等；订阅先缓冲后回放；视图参数越权拒绝。
- **renderer：** kernelStore 失效与重取、插件槽按清单渲染、聊天流合并与结束。
- **thread-context：** 同一事实集重复派生文本全等；超长按时间倒序截断且标注；笔记/事件正文只作资料段出现，不混进指令段。
- **E2E：** 现有 Playwright 关键路径 + 一条「审批挂起 → 回答 → 续接跑完」。
