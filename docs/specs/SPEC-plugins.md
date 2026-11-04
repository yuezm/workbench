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
    ├── shared/                 # 仅纯函数：协议帧解析等跨执行器复用
    ├── sources/{app,manual,webhook,fs}/
    ├── executors/{dsh,command,claude,codex}/
    └── channels/{in-app,desktop,webhook}/

src/renderer/src/apps/          # app 插件（UI 侧，见 SPEC-host）
├── pomodoro/
└── ai-workflow/
```

- 内置插件编译期进入 `registry.ts`；新增插件 = 新增目录 + registry 一行，内核与宿主零改动。
- 目录内固定文件名：`manifest.ts`（元数据）、`index.ts`（实现）；一个有副作用的插件只暴露 `start` 或 `run`。
- 插件之间**禁止互相 import**；共享类型与能力只来自 `src/sdk` 与 `src/protocol`。唯一例外是 `src/plugins/shared/`：只允许纯函数（协议帧解析、参数转 argv），不碰 IO、不持有状态。

## SDK 与能力

插件不能 import 宿主内部实现；它需要的副作用全部由 `sdk` 注入：

```ts
// src/sdk/index.ts —— 宿主注入给插件的全部能力
export interface Sdk {
  log(line: string): void
  now(): Iso
  config<T>(): T
  emit(events: RawEvent[]): Promise<void> // 宿主校验 + 落资料文件后才进内核
  process: {
    // 只有声明 capability 'spawn' 的插件才拿到
    spawn(
      argv: string[],
      options: { cwd: string; env?: Record<string, string>; signal: AbortSignal },
    ): Spawned
  }
  fs: {
    // 只有声明 'fs.read' / 'fs.write' 的插件才拿到
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
  }
}
```

- `capabilities` 是**授权声明**：v1 内置插件全部可信，按声明做静态检查（调了没声明的能力 → 运行时拒绝并记审计）；外部插件在 M7 按声明逐次授权。
- 子进程环境由宿主白名单构造，插件无法把内核密钥或别的插件凭据带进去。

## Manifest

```ts
// src/plugins/manifest.ts
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

- 配置值存 `plugin_config` 投影；`secret` 字段用 Electron `safeStorage` 加密后落库，只存主进程，不进 UI 快照、不进日志、不回传明文。
- 新增运行时协议只需：`src/plugins/executors/<id>/`（manifest + 实现）+ registry 一行；契约枚举、DB CHECK、UI 选项、detect 白名单四处硬编码全部消失。

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

### executor

```ts
export interface ExecutorPlugin {
  probe?(ctx: ExecutorContext): Promise<ProbeResult>
  detect?(): Promise<DetectedRuntime[]> // 只读扫描本机可接入的运行时候选
  models?(ctx: ExecutorContext): Promise<ModelOption[]>
  run(turn: Turn, io: ExecutorIO): Promise<Receipt> // 宿主领取后调用；插件不轮询、不领活
}

export interface ExecutorContext {
  runtime: RuntimeRow // 运行时配置：command / profile / permissionMode / model / maxConcurrent …
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
  model?: { provider: string; id: string }
  effort?: string
  resumeSessionId?: string
  timeoutMs: number
  contextFile?: string // 资料文件路径（不是指令）
  signal: AbortSignal
}

export interface ExecutorIO {
  emit(event: RunEvent): void // text / thinking / tool_call / tool_result / status / usage
  session(id: string): void
}

export interface Receipt {
  status: 'succeeded' | 'failed' | 'cancelled'
  output?: string
  sessionId?: string
  usage?: Usage
  ask?: Ask[] // 要拍板的事项
  notices?: string[]
  resolves?: Id[] // 关掉之前的卡片
  later?: Iso // 约时间复查
  events?: RawEvent[] // 派生新事件（hops 由内核加一）
  errorCode?: ErrorCode
  exitCode?: number
  durationMs?: number
  resumeRejected?: boolean
}
```

- 回执必须原样回传 `Turn` 里的 `leaseId` 与 `turn`；内核据此拒绝迟到尝试的写入（见 SPEC-kernel「调度」）。
- 回执的 `ask / notices / resolves / later / events` 与 autoloop 的回执块语义一致；解析失败时**只重写最后一条回复**，不重做业务，重写上限 2 次。
- **提示词不拼命令行**：`command` 执行器用 argv 数组（`{prompt}` 只能替换成独立 argv 元素或走 stdin），模板只允许 `{model}`/`{effort}`/`{cwd}`/`{context}`；Windows 下 `.cmd`/`.bat` 经固定包装启动（`cmd /c` + 单一脚本参数），不做 shell 拼接。
- 终态归一、`errorCode` 取值、取消时序沿用 `SPEC-ai-workflow.md`，不变。

### channel

```ts
export interface ChannelPlugin {
  start(ctx: ChannelContext): Promise<() => void>
}

export interface ChannelContext {
  sdk: Sdk
  onCard(handler: (card: CardView) => void): () => void
  delivered(cardId: Id, version: number, ref: string): Promise<void>
  answer(cardId: Id, optionIndex: number, by: Actor): Promise<void>
  signal: AbortSignal
}
```

- 卡片正文是**别人写的文字**：只能作为参数传进平台 API，绝不能拼进脚本/模板/HTML（桌面通知沿用 autoloop 的 `--` 分隔做法）。
- 投递状态在 `cards.delivery`：`pending → delivered | failed`；重启后只补投 `pending`，已投递的同一版本不重复打扰；卡片更新（`version+1`）重新进 `pending`。
- 通道崩溃或不可达不影响内核：卡片仍是 `open`，恢复后按上面的规则补投。

### app

```ts
export interface AppPlugin {
  id: string
  name: string
  icon: ComponentType<AppIconProps>
  component: ComponentType
  events?: string[] // 可发事件前缀，如 pomodoro.*
}
```

`AppDefinition` 是它的子集，现有两个 app 先按旧契约注册（只多可选 `events`），M5 再统一改名。

## 内置插件清单

| 类型     | id                 | 说明（运行时协议）                                         | 现状来源                                          |
| -------- | ------------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| executor | `dsh`              | DeepSeek Harness `--stdio` JSONL 协议，探测/模型/执行/终止 | `src/main/ai-workflow/runtime/dsh.ts`（整文件搬） |
| executor | `command`          | 通用 CLI：argv 数组 + 占位符替换，prompt 走 argv/stdin     | 新增，照 autoloop `plugins/command`               |
| executor | `claude` / `codex` | 后续；`detect` 只读扫描                                    | 后续                                              |
| source   | `app`              | app 插件发来的事件（如番茄结束）                           | 新增                                              |
| source   | `manual`           | 设置里手动触发一条自动化规则                               | 新增                                              |
| source   | `webhook`          | 本机 HTTP + HMAC 验签                                      | M6                                                |
| source   | `fs`               | 目录变化去抖                                               | 可选                                              |
| channel  | `in-app`           | 默认通道：卡片落投影，UI 直接批                            | 新增                                              |
| channel  | `desktop`          | Electron 系统通知                                          | `main/tray.ts`、`workbench:notify` 改造           |
| channel  | `webhook`          | 飞书/钉钉/Slack 等（需可达地址）                           | M7                                                |
| app      | `pomodoro`         | 计时；可发 `pomodoro.completed` 事件                       | `src/renderer/src/apps/pomodoro`                  |
| app      | `ai-workflow`      | 看板/聊天/设置三视图                                       | `src/renderer/src/apps/ai-workflow`               |

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

- **契约测试：** 每类插件用假实现跑通「manifest 校验 → 注册 → 启动 → 收到事件/卡片 → 回报」。
- **边界测试：** 扫描插件源码，禁止 import 清单（host/其它插件/DB）；未声明能力被调用时拒绝。
- **执行器：** 假进程/假流覆盖帧解析、终态归一、取消时序、迟到回执；`detect` 零副作用；提示词不出现在 argv 拼接字符串里。
- **通道：** 本地假 HTTP/假通知命令，不发真消息；断言卡片文字只作为参数传递；补投只针对 `pending`。
- **注册表：** id 唯一、kind 合法、capabilities 在枚举内、必填字段齐全。
