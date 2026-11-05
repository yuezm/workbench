# Spec: plugins（插件体系）

> Module id：`plugins`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。总纲见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> 一句话：**内核之外的一切都是插件**；插件是能力的声明与实现，不是内核的分支。

## 四类插件

| 类型       | 回答的问题                                               | 能做什么                                       | 不能做什么                         |
| ---------- | -------------------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| `source`   | 事情从哪来                                               | 产生事件、去重键、资料文本                     | 决定交给谁/在哪跑/什么权限         |
| `executor` | 怎么调起并读回一轮（协议适配，无状态，**不是派活目标**） | 探测、列模型、spawn 进程、解析协议帧、产出回执 | 写库、改规则、决定派给谁、自己挑活 |
| `channel`  | 卡片送到哪、答案怎么回来                                 | 展示卡片、收回答、回报投递状态                 | 改卡片内容、改派活                 |
| `app`      | 人看到的界面                                             | 注册视图组件、发命令、发自身事件               | 算业务规则、直读数据库             |

**派活链固定为：规则或阶段 → 智能体 `agentId` → 该智能体的运行时 `runtimeId` → 运行时的 `executorKey` 选执行器插件。** 执行器只负责「怎么调起 CLI」，不决定也不领取任务（领取由宿主调度器按运行时发起）。

交付流水线（CI/CD）**不是第五类插件**：它是「自动化规则 + 智能体 + 项目配置」的组合。

## 目录与注册

```
src/
├── sdk/                        # 插件能力接口（宿主注入；见下节）
└── plugins/
    ├── registry.ts             # 内置插件清单（唯一静态导入点）
    ├── shared/                 # 仅纯函数：JSONL 切行、argv 模板展开、CLI 候选清单（cli-catalog）
    ├── sources/{app,manual,webhook,fs}/
    ├── executors/{dsh,command,claude,codex}/
    └── channels/{in-app,desktop,webhook}/

src/renderer/src/apps/          # app 插件（UI 侧，见 SPEC-host）
├── pomodoro/
└── ai-workflow/
```

注册表（`src/plugins/registry.ts`）是内置插件的唯一静态导入处：

```ts
export interface ExecutorRegistryEntry {
  key: string // 执行器键 = manifest.id = 运行时配置的 executorKey
  label: string // 展示名（运行时表单下拉、运行时角标）
  manifest: PluginManifest
  plugin: ExecutorPlugin
}

/** 数组顺序即 UI 下拉顺序与 detect 输出顺序 */
export const executors: ReadonlyArray<ExecutorRegistryEntry>

/** 按 key 取注册项；未知 key 抛可读错误（调度器把「未注册」落成兜底终态） */
export function executorById(key: string): ExecutorRegistryEntry

/** 通道清单（M4）：数组顺序即投递顺序（in-app 在前、desktop 在后） */
export interface ChannelRegistryEntry {
  key: string // 通道键 = manifest.id；写进 card.delivered.ref / cards.deliveryRef
  label: string
  manifest: PluginManifest
  plugin: ChannelPlugin
}

export const channels: ReadonlyArray<ChannelRegistryEntry>

/** 按 key 取通道；未知 key 抛可读错误（装配时不启动未知通道） */
export function channelById(key: string): ChannelRegistryEntry
```

- **顺序即契约**：`executors` 的数组顺序决定运行时表单的下拉顺序、`runtimes.executors()` 的返回顺序与 detect 的汇总顺序；`channels` 的数组顺序决定 `card.opened/updated` 的分发与补投顺序。不按字母、不按装载顺序重排。
- **只有装配根 import 本文件**：`src/main` 把 `executors` 清单注入 `host/executor-registry.ts`（按 key 建执行器端口）与 IPC；`host` 只接收清单，不 import 具体插件实现。
- 内置插件编译期进入 `registry.ts`；新增插件 = 新增目录 + registry 一行，内核与宿主零改动。
- 目录内固定文件名：`manifest.ts`（元数据）、`index.ts`（实现）；一个有副作用的插件只暴露 `start` 或 `run`。
- 插件之间**禁止互相 import**；共享类型与能力只来自 `src/sdk` 与 `src/protocol`。唯一例外是 `src/plugins/shared/`：只允许纯函数（协议帧解析、参数转 argv），不碰 IO、不持有状态。

## SDK 与能力

插件不能 import 宿主内部实现；它需要的副作用全部由 `sdk` 注入。M3 落地执行器所需的最小面，M4 增加通道所需的 `notify`（`src/sdk/types.ts` 定义、`src/host/sdk-host.ts` 提供原件、`src/sdk/index.ts` 的 `createSdk` 按 manifest 做能力门控）：

```ts
// src/sdk/types.ts —— 宿主注入给插件的全部能力（M4）
export interface Sdk {
  log(line: string): void // 宿主加插件 id 前缀；不记 prompt 全文
  now(): number // 毫秒；ISO 由回执/事实载体决定
  paths: { sessionRoot: string | null } // 协议会话持久化目录
  config<T>(): T // 插件自有配置（M3 无消费者，返回默认值/空对象）
  /** 系统通知：只有 manifest 声明 capabilities: ['notify'] 才拿到，否则访问即抛 capability_not_declared */
  notify(title: string, body: string): void
  process: {
    // 只有 manifest 声明 capabilities: ['spawn'] 才拿到，否则访问即抛 capability_not_declared
    spawn(command: string, args: string[], options: SpawnOptions): Spawned
    resolve(command: string): { path: string | null; error: string | null }
    killTree(pid: number, signal?: string): boolean
    scanDirs(): string[]
    findInDirs(command: string, dirs: string[]): string | null
  }
}
```

- `capabilities` 是**授权声明**：v1 内置插件全部可信，按声明做静态检查（ESLint 边界 + 源码扫描 + `createSdk` 运行期门控）；外部插件在 M7 按声明逐次授权。
- `notify` 的宿主原件是 `src/main/notify.ts`（Electron `Notification`），经 `createSdkHost` 注入；`src/host/**` 不 import electron，`host/notify.ts` 这个文件名不存在（refactor-plan 的旧口径已更正）。
- `notify(title, body)` 的标题与正文**只作参数**：不拼进命令行、脚本、HTML 或模板字符串；卡片正文同理（见「channel」）。
- M4 **不提供** `fs.read` / `fs.write` / `net` / `emit`：执行器只能经 `ExecutorIO` 回报、通道只能经 `ChannelContext` 回报；能力面随 M7（外部插件）另立任务扩展，SPEC 不提前承诺。
- 子进程环境由宿主构造完整基线交给 `process.spawn`，插件拿不到 `process.env` 本身；白名单收紧随外部插件（M7）另立任务。

## Manifest

```ts
// src/protocol/manifest.ts（src/plugins/manifest.ts 只做再导出）
export type PluginKind = 'source' | 'executor' | 'channel' | 'app'
export type Capability = 'net' | 'fs.read' | 'fs.write' | 'spawn' | 'notify'

export interface PluginManifest {
  id: string // kebab-case，全局唯一
  kind: PluginKind
  name: string
  version: string
  description?: string
  capabilities: Capability[]
  config?: ConfigField[] // 设置页据此渲染表单并校验
}

export type ConfigField =
  | {
      key: string
      label: string
      type: 'text' | 'secret' | 'select'
      required?: boolean
      options?: string[]
      default?: string
      help?: string
    }
  | {
      key: string
      label: string
      type: 'number' | 'boolean'
      required?: boolean
      default?: number | boolean
      help?: string
    }
```

- 类型定义在 `src/protocol/manifest.ts`（`sdk` 需要引用 manifest，依赖方向只允许 `sdk → protocol`），`src/plugins/manifest.ts` 只做再导出，保持「插件目录内固定文件名」的约定。
- 执行器的 `config` 是**运行时表单的字段来源与默认值**：`command` / `profile` / `permissionMode` / `model` / `reasoningEffort` / `workdir`（`dsh`）、`command` / `profile` / `argsTemplate`（`command`）由宿主按所选 manifest 写入 `Runtime` 行。`runtimes.create` 的缺省值由 IPC 从 manifest 取（未指定 `executorKey` 取注册表首项），表单下拉选项来自 `runtimes.executors()`。
- 配置值存 `plugin_config` 投影；`secret` 字段用 Electron `safeStorage` 加密后落库，只存主进程，不进 UI 快照、不进日志、不回传明文。
- 新增运行时协议只需：`src/plugins/executors/<id>/`（manifest + 实现）+ registry 一行，契约枚举、DB CHECK、UI 选项、detect 白名单四处硬编码全部消失。**验收含义**：加完这一行，`runtimes.executors()` 立刻出现该选项、detect 自动汇总该插件的 `detect()`、在运行时配置里选中它即可跑通一轮——内核、宿主、renderer 都不改动。

## 接口

### source

```ts
export interface SourcePlugin {
  start(ctx: SourceContext): Promise<() => void>
}

export interface SourceContext {
  sdk: Sdk
  signal: AbortSignal
}

export interface RawEvent {
  source: string
  type: string // kebab-case，如 issues.opened
  subject: string // 事项标识，用于合并
  summary?: string // ≤200 字
  detail?: string // 全文，落资料文件
  link?: string
  dedupeKey?: string
}
```

定时（cron）不需要 source 插件：规则里的 `cron` 由内核 `clock.tick` 派生事实（见 SPEC-kernel「规则」）。

**M6 边界**：M6 **不落地** source 插件进程——外部事件入口是宿主输入 `event.received`（source 插件与测试注入共用），manual 源 = `rule.trigger` 命令，app 源 = `app.event` 命令；`SourcePlugin` / `SourceContext` 接口与 `src/plugins/sources/**` 留给 M7 webhook 的首个消费者，避免为没有传输层的来源引入第二套事件入口。

### executor

```ts
export interface ExecutorPlugin {
  probe?(ctx: ExecutorContext): Promise<RuntimeProbe>
  models?(ctx: ExecutorContext): Promise<RuntimeModelOption[]>
  /** 只读扫描本机候选；零副作用，`executorKey` / `supported` 由 registry 汇总时填 */
  detect?(ctx: DetectContext): DetectedRuntime[] | Promise<DetectedRuntime[]>
  /** 宿主领取后调用一轮；插件不轮询、不领活 */
  run(ctx: ExecutorContext, turn: Turn, io: ExecutorIO): Promise<Receipt>
}

export interface ExecutorContext {
  runtime: Runtime // 运行时配置整行：executorKey / command / profile / argsTemplate / permissionMode / model / maxConcurrent …
  sdk: Sdk
}

/** detect 不绑运行时，只需要能力面 */
export interface DetectContext {
  sdk: Sdk
}

export interface Turn {
  runId: Id
  leaseId: string // 本次领取凭证，回执原样带回
  turn: number // 第几轮（续接递增）
  purpose: 'stage' | 'chat'
  prompt: string // 宿主按模板拼好
  cwd: string
  access: Access
  model?: { provider: string; id: string } | null
  effort?: string | null
  resumeSessionId?: string | null
  /** 续接被拒后的重试提示词（带完整历史）；执行器用它重发一次 */
  fallbackPrompt?: string | null
  timeoutMs: number
  contextFile?: string | null // 资料文件路径（不是指令）
  signal: AbortSignal
}

export interface ExecutorIO {
  emit(event: RunEvent): void // text / thinking / tool_call / tool_result / status / usage
  session?(id: string): void // 协议会话 id（回执缺 sessionId 时宿主兜底）
  process?(pid: number): void // spawn 成功即上报，崩溃对账用
}

export interface Receipt {
  status: 'succeeded' | 'failed' | 'cancelled'
  /** 原样回传 Turn.leaseId（内核据此拒绝迟到尝试，见 SPEC-kernel「调度」） */
  leaseId: string
  /** 原样回传 Turn.turn */
  turn: number
  output?: string
  sessionId?: string
  usage?: Usage
  ask?: Ask[] // 要拍板的事项
  notices?: string[]
  resolves?: Id[] // 关掉之前的卡片
  later?: Iso // 约时间复查
  events?: RawEvent[] // 派生新事件（hops 由内核加一）
  errorCode?: ErrorCode
  /** 失败原因文案（给人看；与 errorCode 的归类分开） */
  error?: string
  exitCode?: number
  durationMs?: number
  resumeRejected?: boolean
}
```

**detect 汇总契约**（`src/plugins/registry.ts` 的 `detectAll`）：

- **零副作用**：只经 `sdk.process.scanDirs()` / `findInDirs()` 读本机，不 spawn、不读版本、不写库、不发 changed。
- **插件不自报归属**：`DetectedRuntime` 的 `executorKey`（= 注册表 key）与 `supported`（= 注册表里存在该执行器）由汇总时填；插件只报「本机装了这个命令」。
- **顺序**：按 `executors` 数组顺序**串行**调用各插件的 `detect()`；输出按 `plugins/shared/cli-catalog.ts` 的候选顺序稳定排列。
- **失败隔离**：单个插件抛错或超时（默认 2 s/插件）只跳过该插件并记日志，不影响其它插件与 UI；整体永不抛。
- **同名去重**：同一 `command` 被多个插件声明时，按注册表顺序先到先得，冲突记一条 warn、不抛。
- **未注册也列出**：本机装了但无插件认领的 CLI 仍以 `supported:false` 出现，UI 三态（已添加 / 使用 / 暂不支持）不变。

**回执与执行约定**：

- 回执必须原样回传 `Turn` 里的 `leaseId` 与 `turn`；内核据此拒绝迟到尝试的写入（见 SPEC-kernel「调度」）。
- **回执块格式（M4 唯一口径）**：执行器取自己最终输出里**最后一个 ```json 围栏块**；该块解析成 JSON 对象后，**只要含 `ask / notices / resolves / later / events` 任一键**才算回执块，未知键忽略。示例：

  ```json
  {
    "ask": [{ "title": "选一个", "text": "用哪个方案？", "options": ["A", "B"], "key": "plan" }],
    "notices": ["已完成依赖安装"],
    "resolves": ["card-0"],
    "later": "2026-11-06T09:00:00.000Z",
    "events": [
      { "source": "agent", "type": "issues.opened", "subject": "issue-1", "summary": "发现新问题" }
    ]
  }
  ```

- **解析位置**：解析器是纯函数 `src/plugins/shared/receipt-block.ts`；`dsh` 执行器从 `result` 帧的 `output` 解析，`command` 执行器从 stdout 解析。解析结果只填 `Receipt` 的五个字段，**不改 `output` 原文、不改终态、不抛错**。
- **解析失败不生效**：非法 JSON、非对象、五键全无、字段校验不过（`ask` 标题/选项超限、`later` 非 ISO、`events` 形状非法等）→ 整个块忽略，不产这些字段；终态与其他字段照常落库。SPEC 原「解析失败只重写最后一条回复、上限 2 次」需要额外 execute 帧与模型调用，**重写机制留 M6**（D15 已知边界），M4 不做。
- 回执的 `ask / notices / resolves / later / events` 到内核事实的映射见 SPEC-kernel「审批」与「事实目录」。
- **提示词不拼命令行**：`command` 执行器把 `runtime.argsTemplate`（JSON 数组文本，≤20 项、单项 ≤500 字符）逐项展开成 argv，占位符白名单 `{model}` / `{effort}` / `{cwd}` / `{context}` / `{prompt}`；模板含 `{prompt}` 时提示词替换成独立 argv 元素、不再写 stdin，否则只经 stdin 传入。Windows 下 `.cmd`/`.bat` 固定包装成 `cmd.exe /c <脚本> <参数...>`、`shell:false`，不做 shell 字符串拼接。
- 终态归一、`errorCode` 取值、取消时序沿用 `SPEC-ai-workflow.md`，不变。

### channel

```ts
// src/protocol/channels.ts
export interface ChannelPlugin {
  start(ctx: ChannelContext): Promise<() => void>
}

export interface ChannelContext {
  /** 通道所需的能力子集（log / now / notify）；`src/sdk` 的 `Sdk` 结构上满足它。
   *  protocol 不反向 import sdk（依赖方向 plugins → sdk → protocol）。 */
  sdk: ChannelSdk
  /** 订阅卡片投递（宿主按 registry 顺序分发 card.opened / card.updated）；返回退订函数 */
  onCard(handler: (card: Card) => void): () => void
  /** 回报「已送达至少一个通道」；ref 写进 cards.deliveryRef 与 card.delivered 的审计字段 */
  delivered(cardId: Id, version: number, ref: string): Promise<void>
  /** 通道侧回答：经宿主发 card.answer（via='channel'）；被内核拒绝时 Promise reject */
  answer(cardId: Id, optionIndex: number): Promise<void>
  /** 宿主停用通道或退出时 abort */
  signal: AbortSignal
}

export interface ChannelSdk {
  log(line: string): void
  now(): number
  notify(title: string, body: string): void // 需要 manifest 声明 capabilities: ['notify']
}
```

- 端口版本：`CHANNEL_PORT_VERSION = 1`（`src/protocol/channels.ts`）；上下文形状变化时递增，外部通道（M7）按它做兼容判断。
- 卡片正文是**别人写的文字**：只能作为参数传进平台/通知 API，绝不能拼进脚本/模板/HTML；`notify(title, body)` 的两个参数同样只作参数。
- 投递状态是 `cards` 的**单列** `delivery`（`pending → delivered | failed`，= 已送达至少一个通道，不按通道拆表）：重启后只补投 `pending`，已投递的同一版本不重复打扰；卡片更新（`version+1`）重新进 `pending`。`deliveryRef` 记最后一个成功通道。
- 通道崩溃、抛错或超时不影响内核：卡片仍是 `open`，投递由宿主 fire-and-forget 隔离并在恢复后按上面的规则补投；失败只落 `card.delivery_failed`。
- 通道只读卡片、只回报投递与回答；**不改卡片内容、不改派活**。
- 宿主 hub（`src/host/channels.ts`）负责注册/启停/分发/补投，通道启停排在 effects 之后、scheduler 之前；退出时 abort + best-effort dispose。

### app

```ts
// src/renderer/src/shell/types.ts（M5 定稿）
export interface AppPlugin {
  id: string
  name: string
  icon: ComponentType<AppIconProps>
  component: ComponentType
  /** 可发事件类型（如 pomodoro.completed）；必须同步 src/shared/apps.ts 的白名单 */
  events?: readonly string[]
}
```

- 注册表在 `renderer/src/shell/registry.ts` 导出 `appPlugins`；`Workbench` 只按清单渲染，外壳零改动。
- app 只消费内核视图、只发命令：读用 `useKernelView(view, params)` / `useKernelViewState`，
  写用 `getKernelStore().dispatch(command)`；不得自己起 IPC 订阅、不得轮询、不得在组件里算「执行中」。
- **app 事件（M5/M6）**：`events` 只是可发类型声明；宿主在 `app.event` 命令入口按
  `src/shared/apps.ts` 的 `APP_EVENTS` 校验 `appId + eventType`，不在清单里的一律拒绝。
  命令载荷 `{ appId, eventType, subject, summary?, detail?, link?, dedupeKey? }`，内核产一条
  `event.received`（`source='app'`、`hops=1`、`originRunId=null`）；M6 起与外部事件走同一匹配路径，
  命中规则即建任务（同一规则 + 同一入口键只建一次）。
  当前内置：`pomodoro` → `pomodoro.completed`（计时结束发一条）。

## 内置插件清单

| 类型     | id                 | 说明（运行时协议）                                                                                       | 现状来源                                                         |
| -------- | ------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| executor | `dsh`              | DeepSeek Harness `--stdio` JSONL 协议，探测/模型/执行/终止；`detect` 只报本机 `dsh` 命中                 | `src/plugins/executors/dsh/`（含 `detect.ts`）                   |
| executor | `command`          | 通用 CLI：`argsTemplate` 逐项展开成 argv，`{prompt}` 决定 argv 元素或 stdin；**不提供 `detect`/`probe`** | `src/plugins/executors/command/`                                 |
| executor | `claude` / `codex` | 后续；接入方式 = 新增插件目录 + registry 一行，`detect` 只读扫描                                         | 后续                                                             |
| source   | `app`              | app 插件发来的事件（经 `app.event` 命令，按 `APP_EVENTS` 白名单校验）                                    | M5 起（事件消费 M6）                                             |
| source   | `manual`           | 设置里手动触发一条自动化规则（`rule.trigger` 命令，不是独立插件进程）                                    | M6                                                               |
| source   | `webhook`          | 本机 HTTP + HMAC 验签                                                                                    | M7                                                               |
| source   | `fs`               | 目录变化去抖                                                                                             | 可选                                                             |
| channel  | `in-app`           | 默认通道：投影即送达，`start` 内把 `pending` 卡片 ack 为 `delivered{ref:'in-app'}`；UI 直接批            | `src/plugins/channels/in-app/`（M4）                             |
| channel  | `desktop`          | Electron 系统通知：`sdk.notify(title, body)`，标题/正文只作参数；失败落 `card.delivery_failed`           | `src/plugins/channels/desktop/`（M4；原件 `src/main/notify.ts`） |
| channel  | `webhook`          | 飞书/钉钉/Slack 等（需可达地址）                                                                         | M7                                                               |
| app      | `pomodoro`         | 计时；可发 `pomodoro.completed` 事件                                                                     | `src/renderer/src/apps/pomodoro`                                 |
| app      | `ai-workflow`      | 看板/聊天/设置三视图                                                                                     | `src/renderer/src/apps/ai-workflow`                              |

## 外部插件（v2）

- 安装：`userData/plugins/<kind>/<id>/`（`manifest.json` + `plugin.mjs`），设置页「安装插件」只做复制与校验，不执行安装脚本、不装依赖。
- 运行：**独立子进程**，stdio JSONL，帧 `{ v: 1, type: 'hello' | 'claim' | 'heartbeat' | 'receipt' | 'event' | 'card' | 'answer' }`；宿主按 `capabilities` 过滤环境与接口。
- 加载顺序：用户目录优先于内置（同名覆盖），manifest 不合法直接拒绝并提示，不静默降级。
- v1 只开放内置插件；外部插件开关默认关闭。

## 插件边界与审查要点

这些算出错：

- 插件 import 了 `src/host/**` 内部实现、别的插件、或直接开 SQLite。
- 插件调用了未声明的能力（spawn/fs/net）。
- 事件里的文字被拼进提示词当指令，或事件携带 `cwd/executor/access` 影响派活。
- 一个插件能读到另一个插件的 secret，或内核密钥出现在子进程环境里。
- 通道把卡片文字拼进脚本/HTML；打开链接就算回答。
- 新插件绕过 registry 静态注册（运行时字符串拼路径 import）。
- 插件在 `decide` 之前做业务判断（提前算「执行中」、提前过滤任务）。
- 执行器绕过智能体直接执行（例如事件里指定命令、或插件自己挑 queued run）。
- 插件失败导致内核不可用：所有插件调用都必须可超时、可中止、可重启。

## 测试

- **契约测试：** 每类插件用假实现跑通「manifest 校验 → 注册 → 启动 → 收到事件/卡片 → 回报」；通道契约覆盖「启动 → `onCard` 收到卡片 → `delivered` / `answer` 回报 → dispose 可重复调用」。
- **边界测试：** 扫描插件源码，禁止 import 清单（host/其它插件/DB）；未声明能力被调用时拒绝（含 `notify` 的「声明 ↔ 用法」一致性）。
- **执行器：** 假进程/假流覆盖帧解析、终态归一、取消时序、迟到回执；`detect` 零副作用；`command` 插件的模板展开（项数与单项长度上限、未知占位符拒绝）、`{prompt}` 存在与否决定 argv/stdin、Windows `.cmd` 固定包装、提示词不出现在 argv 拼接字符串里。
- **回执块：** 多块取最后一块、块内无五键视为无回执、非法 JSON/非对象忽略、`ask` 选项为空/超限/标题超限整块忽略、解析不修改 `output` 与终态；dsh 从 `result` 帧、`command` 从 stdout 各一条成功与失败用例。
- **通道：** 假通知/假平台，不发真消息；断言卡片文字与通知标题/正文只作为参数传递；补投只针对 `pending`、同一版本不重复投递。
- **注册表：** id 唯一、`key === manifest.id`、kind 合法、capabilities 在枚举内、必填字段齐全；`executors/*`、`channels/*` 目录与清单双向一致。
- **detect 汇总：** 按注册表顺序串行且顺序稳定、`executorKey`/`supported` 由汇总回填、输出按候选清单排序、同 `command` 先到先得、单插件抛错或超时被隔离、空注册表返回空数组且不扫盘。
