# Spec: plugins（插件体系）

> Module id：`plugins`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。总纲见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> 一句话：**内核之外的一切都是插件**；插件是能力的声明与实现，不是内核的分支。

## 四类插件

| 类型       | 回答的问题                                               | 能做什么                                       | 不能做什么                             |
| ---------- | -------------------------------------------------------- | ---------------------------------------------- | -------------------------------------- |
| `source`   | 事情从哪来                                               | 产生事件、去重键、资料文本                     | 决定交给谁/在哪跑/什么权限             |
| `executor` | 怎么调起并读回一轮（协议适配，无状态，**不是派活目标**） | 探测、列模型、spawn 进程、解析协议帧、产出回执 | 写库、改规则、决定派给谁、自己挑活     |
| `channel`  | 卡片送到哪、答案怎么回来                                 | 展示卡片、收回答、回报投递状态                 | 改卡片内容、决定派给谁、自己开聊天入口 |
| `app`      | 人看到的界面                                             | 注册视图组件、发命令、发自身事件               | 算业务规则、直读数据库                 |

**派活链固定为：规则或阶段 → 执行目标（智能体 `agentId` 或脚本 `script`）→ 运行时 `runtimeId` → 运行时的 `executorKey` 选执行器插件。** 执行器只负责「怎么调起 CLI」，不决定也不领取任务（领取由宿主调度器按运行时发起）。脚本是第二个执行目标（M40）：**命令只来自运行时连接（`runtime.command`），阶段只给步骤（每条一组 argv）**——阶段上再写一条命令就是第二份真相源，因此 `StageScript` 与 `Turn` 都没有命令字段；一条命令证明一件事，N 步就给 N 条 `checks`（M42），脚本不产生提示词、不续会话、不派活。

交付流水线（CI/CD）**不是第五类插件**：它是「自动化规则 + 智能体 + 项目配置」的组合。

## 目录与注册

注册表（`packages/plugins/registry/src/index.ts`）是内置插件的唯一静态导入处：

```ts
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
- **只有装配根 import 本文件**：`apps/server` 把 `executors` 清单注入 `host/executor-registry.ts`（按 key 建执行器端口）与 IPC；`host` 只接收清单，不 import 具体插件实现。
- 内置插件编译期进入 `registry.ts`；新增插件 = 新增目录 + registry 一行，内核与宿主零改动。
- 目录内固定文件名：`manifest.ts`（元数据）、`index.ts`（实现）；一个有副作用的插件只暴露 `start` 或 `run`。
- 插件之间**禁止互相 import**；共享类型与能力只来自 `packages/sdk/capabilities/src` 与 `packages/core/protocol/src`。唯一例外是 `packages/plugins/kit/src/`：只允许纯函数（协议帧解析、参数转 argv），不碰 IO、不持有状态。

## SDK 与能力

插件不能 import 宿主内部实现；它需要的副作用全部由 `sdk` 注入。M3 落地执行器所需的最小面，M4 增加通道所需的 `notify`（`packages/sdk/capabilities/src/types.ts` 定义、`packages/host/host/src/sdk-host.ts` 提供原件、`packages/sdk/capabilities/src/index.ts` 的 `createSdk` 按 manifest 做能力门控）：

```ts
// packages/sdk/capabilities/src/types.ts —— 宿主注入给插件的全部能力（M4）
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
- `notify` 的宿主原件是 `packages/api/http/src/notify.ts`（`sdk.notify` → SSE `notice`），经 `createSdkHost` 注入；`packages/host/host/src/**` 不 import electron，`host/notify.ts` 这个文件名不存在（refactor-plan 的旧口径已更正）。
- `notify(title, body)` 的标题与正文**只作参数**：不拼进命令行、脚本、HTML 或模板字符串；卡片正文同理（见「channel」）。
- M4 **不提供** `fs.read` / `fs.write` / `net` / `emit`：执行器只能经 `ExecutorIO` 回报、通道只能经 `ChannelContext` 回报；能力面随 M7（外部插件）另立任务扩展，SPEC 不提前承诺。
- 子进程环境由宿主构造完整基线交给 `process.spawn`，插件拿不到 `process.env` 本身；白名单收紧随外部插件（M7）另立任务。

## Manifest

```ts
// packages/core/protocol/src/manifest.ts（packages/plugins/manifest.ts 只做再导出）
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

export type ConfigOptionSource = 'agents' // 动态候选来源：设置页订阅对应内核视图

export type ConfigField =
  | {
      key: string
      label: string
      type: 'text' | 'secret' | 'select'
      required?: boolean
      advanced?: boolean
      options?: string[] // select 的静态候选（与 optionsFrom 二选一）
      optionsFrom?: ConfigOptionSource // select 的动态候选来源
      default?: string
      help?: string
    }
  | {
      key: string
      label: string
      type: 'number' | 'boolean'
      required?: boolean
      advanced?: boolean
      default?: number | boolean
      help?: string
    }
```

- 类型定义在 `packages/core/protocol/src/manifest.ts`（`sdk` 需要引用 manifest，依赖方向只允许 `sdk → protocol`），`packages/plugins/manifest.ts` 只做再导出，保持「插件目录内固定文件名」的约定。
- `advanced` 只影响设置页**摆放**：标了它的字段默认收进「高级」里，展开才渲染；校验与保存仍按全部字段走（收起不等于丢掉，隐藏的已存值照样随保存提交、不会被清空）。判据是「第一次就得填」——不需要的配置项不该和常用项平铺在一起。
- `select` 的候选二选一：静态 `options`，或动态 `optionsFrom`（两者同时给判非法）。**动态候选的清单不写进 manifest**：清单里只说「去哪取」（`agents` → 设置页订阅内核视图 `agents.all`），显示名称、落库 id；智能体改名不影响绑定，认不出旧值时留一条「（找不到对应智能体）」而不是静默清空。
- 下拉的**空值写空串**（其余字段空值不写入，保留 manifest 缺省值）：选回「未设置」必须真的清掉旧值，否则用户选了「不指定智能体」却照旧带着旧绑定。
- 执行器的 `config` 是**运行时表单的字段来源与默认值**，只覆盖连接字段：`command` / `profile`（`dsh`）、`command` / `profile` / `argsTemplate`（`command`）由宿主按所选 manifest 写入 `Runtime` 行。**执行配置（模型 / 思考强度 / 并发 / 访问权限 / 工作目录 / 环境变量）是智能体的设置**，由运行时表单之外的地方维护。`runtimes.create` 的缺省值由 IPC 从 manifest 取（未指定 `executorKey` 取注册表首项），表单下拉选项来自 `runtimes.executors()`。
- 配置值存 `plugin_config` 投影；`secret` 字段用 Electron `safeStorage` 加密后落库，只存主进程，不进 UI 快照、不进日志、不回传明文。
- 新增运行时协议只需：`packages/plugins/executor-<id>/`（manifest + 实现）+ registry 一行，契约枚举、DB CHECK、UI 选项、detect 白名单四处硬编码全部消失。**验收含义**：加完这一行，`runtimes.executors()` 立刻出现该选项、detect 自动汇总该插件的 `detect()`、在运行时配置里选中它即可跑通一轮——内核、宿主、renderer 都不改动。

## 接口

### source

```ts
export interface SourcePlugin {
  start(ctx: SourceContext): Promise<() => void>
}

export interface SourceContext {
  sdk: Sdk
  /** 外部事件入口（M7）：宿主转 `event.received{hops:1}` → 内核产事实并匹配规则 */
  emit(event: RawEvent): void
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

**M7 落地（`packages/plugins/sources/**` + `packages/host/host/src/sources.ts`）**：内置 `webhook` 来源是真消费者——`start(ctx)` 用 `ctx.sdk.net.listen` 绑 `127.0.0.1`（宿主强制，插件不指定地址），POST + 路径 + 时间戳窗口 + HMAC-SHA256 验签（`ctx.sdk.net.verifyHmacSha256`，`node:crypto` 只在宿主 `host/net.ts`）通过后 `ctx.emit`；失败回 4xx 且零事件；未配置 secret/端口时不监听（no-op dispose + 日志）。来源 hub 按清单启停、单条失败隔离、`statuses()` 供设置页展示；**事件入口仍是唯一的 `event.received` 宿主输入**，manual 源 = `rule.trigger`、app 源 = `app.event` 不变。外部 source 插件经子进程帧 `event` → 适配器 → 同一 `ctx.emit`。

### executor

```ts
export interface ExecutorPlugin {
  /**
   * 连接可用性探测（`runtime.create` 落库前必经；`runtime.probe` / 表单「测试」也用它）。
   * 判据由插件自己定：dsh 跑 `--probe` 帧、claude 校验 `--help` 里的必需参数、
   * `command` 只解析可执行文件与参数模板（通用命令没有统一的版本旗标，**不 spawn**）。
   */
  probe?(ctx: ExecutorContext): Promise<RuntimeProbe>
  models?(ctx: ExecutorContext): Promise<RuntimeModelOption[]>
  /** 只读扫描本机候选；零副作用，`executorKey` / `supported` 由 registry 汇总时填 */
  detect?(ctx: DetectContext): DetectedRuntime[] | Promise<DetectedRuntime[]>
  /** 宿主领取后调用一轮；插件不轮询、不领活 */
  run(ctx: ExecutorContext, turn: Turn, io: ExecutorIO): Promise<Receipt>
}

export interface ExecutorContext {
  /** 运行时配置整行 = **连接**：executorKey / command / profile / argsTemplate / 启用。执行配置在 `Turn` 上。 */
  runtime: Runtime
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
  cwd: string // 项目文件夹 > 智能体工作目录（脚本阶段为脚本 cwd）> 空串（宿主默认目录）
  /**
   * M42 脚本阶段：步骤序列（每条一组 argv，按顺序执行、各产一条 `checks`）。
   * 缺省（智能体轮）用运行时的 `argsTemplate` 展开成一步；命令不在这里，只来自 runtime.command。
   */
  steps?: readonly TurnStep[]
  /** 全部步骤跑完再判（缺省 true）；false = 首个非 0 退出即停 */
  runAll?: boolean
  access: Access // 由智能体的 permissionMode 映射
  model?: { provider: string; id: string } | null // 智能体的模型配置
  effort?: string | null // 智能体的思考强度
  env?: Record<string, string> // 智能体配置的环境变量（只覆盖，不清空宿主基线）
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
  /** M8：派生子任务（只声明 subject/summary/stageId/batch/key；父任务与派活目标由内核决定） */
  spawn?: SpawnTask[]
  /** M6.5：线程笔记（只作资料，每条 ≤2000 字） */
  notes?: string[]
  /** M11：闸门判定（只对闸门阶段有意义；缺省 = 没给结论） */
  verdict?: 'pass' | 'fail'
  /** M11：判定证据（`{ cmd, exitCode, acceptance? }`，pass 时退出码必须全为 0） */
  checks?: GateCheck[]
  errorCode?: ErrorCode
  /** 失败原因文案（给人看；与 errorCode 的归类分开） */
  error?: string
  exitCode?: number
  durationMs?: number
  resumeRejected?: boolean
}
```

**detect 汇总契约**（`packages/plugins/registry/src/index.ts` 的 `detectAll`）：

- **零副作用**：只经 `sdk.process.scanDirs()` / `findInDirs()` 读本机，不 spawn、不读版本、不写库、不发 changed。
- **插件不自报归属**：`DetectedRuntime` 的 `executorKey`（= 注册表 key）与 `supported`（= 注册表里存在该执行器）由汇总时填；插件只报「本机装了这个命令」。
- **顺序**：按 `executors` 数组顺序**串行**调用各插件的 `detect()`；输出按 `plugins/shared/cli-catalog.ts` 的候选顺序稳定排列。
- **失败隔离**：单个插件抛错或超时（默认 2 s/插件）只跳过该插件并记日志，不影响其它插件与 UI；整体永不抛。
- **同名去重**：同一 `command` 被多个插件声明时，按注册表顺序先到先得，冲突记一条 warn、不抛。
- **未注册也列出**：本机装了但无插件认领的 CLI 仍以 `supported:false` 出现，UI 三态（已添加 / 使用 / 不支持）不变。

**回执与执行约定**：

- 回执必须原样回传 `Turn` 里的 `leaseId` 与 `turn`；内核据此拒绝迟到尝试的写入（见 SPEC-kernel「调度」）。
- **回执块格式（M4 唯一口径，M8 增 spawn、M6.5 增 notes、M11 增 verdict/checks、M14 增 findings/addresses、M34 删 acceptance）**：执行器取自己最终输出里**最后一个 ```json 围栏块**；该块解析成 JSON 对象后，**只要含 `ask / notices / resolves / later / events / spawn / notes / verdict / checks / findings / addresses` 任一键**才算回执块，未知键忽略（`acceptance` 已废弃，出现即忽略）。示例：

  ```json
  {
    "ask": [{ "title": "选一个", "text": "用哪个方案？", "options": ["A", "B"], "key": "plan" }],
    "notices": ["已完成依赖安装"],
    "resolves": ["card-0"],
    "later": "2026-11-06T09:00:00.000Z",
    "events": [
      { "source": "agent", "type": "issues.opened", "subject": "issue-1", "summary": "发现新问题" }
    ],
    "spawn": [
      { "subject": "实现登录页", "summary": "含表单与校验", "stageId": "st-2", "key": "login" }
    ],
    "notes": ["先跑测试再提交"],
    "verdict": "fail",
    "checks": [
      { "cmd": "pnpm check", "exitCode": 0, "acceptance": 1 },
      { "cmd": "pnpm verify:e2e", "exitCode": 1, "acceptance": 2 }
    ],
    "findings": [
      {
        "key": "R1",
        "severity": "blocker",
        "location": "src/a.ts:42",
        "claim": "越界下标没有校验",
        "requiredAction": "复跑 pnpm verify:all 且不红即算修好"
      }
    ],
    "addresses": [{ "findingId": "rpt-1#R1", "disposition": "fixed", "checkRef": "git tag" }]
  }
  ```

- **解析位置**：解析器是纯函数 `packages/plugins/kit/src/receipt-block.ts`；`dsh` 执行器从 `result` 帧的 `output` 解析，`command` 执行器从 stdout 解析。解析结果只填 `Receipt` 的十一个字段，**不改 `output` 原文、不改终态、不抛错**。每个执行器的 `toReceipt` 都必须调 `applyReceiptBlock`——漏了任何一个字段，对应能力就整条断路：漏 `verdict` / `checks` 闸门永远停在判定上（含验收覆盖判据），漏 `findings` / `addresses` 评审硬门不触发。
- **解析失败按键盘收（R1，2026-11-21）**：非法 JSON、非对象、十二键全无 → 整块不成立；**单个键**校验不过（`ask` 标题/选项超限、`later` 非 ISO、`events`/`spawn` 形状非法、`verdict` 非 `pass|fail`、`checks` 命令为空或退出码非整数、`checks[].acceptance` 非正整数、`findings` 小标重复、`addresses` 的 `fixed` 缺 `checkRef` 或 `rejected`/`deferred` 缺 `note` 等）→ **只丢该键**，其余键照常生效（原因随 `receiptFromObject` 的 `dropped` 返回，工具通道据此回错误）。空数组 / `null` 视为未提供（`checks: []` 不连累同块 `verdict`）。旧口径是「任一键不合格整块作废」，实测代价是一次闸门卡死（`findings[].severity` 用了 `Required`，把同块的 `ask` 一起丢掉）。SPEC 原「解析失败只重写最后一条回复、上限 2 次」需要额外 execute 帧与模型调用，**重写机制留 M6**（D15 已知边界），M4 不做。
- 回执的 `ask / notices / resolves / later / events / spawn / notes / verdict / checks / deliverables / findings / addresses` 到内核事实的映射见 SPEC-kernel「审批」「M8 任务派生」「M6.5 线程」「M11 闸门」「M14 评审回执」「M28 交付物」「M34 验收归属」与「事实目录」。`deliverables` 的解析与写回由 `receipt-fields.ts` 负责（M28 一度只在提示词与工具 schema 里有这个键，解析器漏了它，`runs.deliverables_json` 长期为 null；2026-11-21 补齐）。
- **工具通道（M24）**：回执除了「回复末尾写 ```json 围栏块」，还可以由模型调一次工具交上来。
  - 字段校验只有一份：`packages/plugins/kit/src/receipt-fields.ts` 的 `receiptFromObject`（逐键，返回 `{ block, dropped }`）/ `applyReceiptFields`，`receipt-block`（文本）与 `receipt-tool`（工具）都调它；
  - 工具名白名单 `RECEIPT_TOOL_NAMES`（`workbench.receipt` / `mcp__workbench__receipt`），其余名字一律不认；
  - server 是独立进程 `packages/plugins/kit/src/receipt-mcp-server.cjs`（stdio MCP，只暴露一个 `receipt` 工具，不读文件不联网）；启动配置由宿主解析（`host/receipt-tool.ts`）后经 `sdk.paths.receiptTool` 下发，插件只用 `receipt-mcp-config` 拼成协议帧；
  - **两种协议的元素形状不一样**：ACP（hermes）是 `{ type:'stdio', name, command, args, env:[{name,value}] }`；dsh 的 `mcp_servers` 要 `{ transport:'stdio', name, command, args, env:{KEY:'value'} }`——**字段名是 `transport` 不是 `type`，`env` 是对象不是数组**。这是 2026-11-11 在 dsh 0.2.1-rc.5 上实测的（`ready.capabilities.mcp = ["stdio","streamable-http"]`；写错当场拒收：`mcp_servers[0].transport must be a non-empty string` / `mcp_servers[0].env must be an object`），探针脚本见 `scripts/dsh-stdio-probe.mjs`；
  - **默认开**：`WORKBENCH_RECEIPT_TOOL=0` 才关（`packages/host/host/src/receipt-tool.ts`），脚本随构建发到 `out/server/receipt-mcp-server.cjs`；关掉后执行器拿到的就是空数组，行为与纯文本通道逐字一致；
  - 两条通道同时有值时**工具通道优先**（结构化参数没有「取最后一个围栏块」的歧义）；`tool_call` 帧照常落 `run.frames`，审计面不丢。
- **提示词不拼命令行**：`command` 执行器把 `runtime.argsTemplate`（JSON 数组文本，≤20 项、单项 ≤500 字符）逐项展开成 argv，占位符白名单 `{model}` / `{effort}` / `{cwd}` / `{context}` / `{prompt}`；模板含 `{prompt}` 时提示词替换成独立 argv 元素、不再写 stdin，否则只经 stdin 传入。Windows 下 `.cmd`/`.bat` 固定包装成 `cmd.exe /c <脚本> <参数...>`、`shell:false`，不做 shell 字符串拼接。
- 终态归一、`errorCode` 取值、取消时序沿用 `SPEC-ai-workflow.md`，不变。

### channel

```ts
// packages/core/protocol/src/channels.ts
export interface ChannelPlugin {
  start(ctx: ChannelContext): Promise<() => void>
}

export interface ChannelContext {
  /** 通道所需的能力子集（log / now / notify）；`packages/sdk/capabilities/src` 的 `Sdk` 结构上满足它。
   *  protocol 不反向 import sdk（依赖方向 plugins → sdk → protocol）。 */
  sdk: ChannelSdk
  /**
   * 订阅卡片（M43）：宿主按 registry 顺序分发 `card.opened` / `card.updated`（新版本）与
   * `card.answered` / `card.resolved`（这张卡在这个通道发过时，回到原消息改口）。
   * 第二参 `ref` 是这个通道上次成功发出的引用（从未发过为 null）——有它就原地更新，
   * 没有就是第一次发。第三参 `context`（M54）是这张卡的归属上下文（见下），读不到就是 null。
   * 返回退订函数。 */
  onCard(handler: (card: Card, ref: string | null, context: CardContext | null) => void): () => void
  /** 回报「这个通道送达了」：每个通道各写一条 card.delivered{channel}，ref 是该通道侧引用 */
  delivered(cardId: Id, version: number, ref: string): Promise<void>
  /**
   * 通道侧回答：经宿主发 card.answer（via='channel'，`ref` 用来确认「点的是我发出去的那条
   * 消息」，`byRef` 是回答人标识）。返回 `{ changed, status }`：已经不在等你时
   * `changed=false`（不抛错），通道据此把那张卡刷成终态。 */
  answer(
    cardId: Id,
    optionIndex: number,
    ref?: string,
    byRef?: string,
  ): Promise<{ changed: boolean; status: Card['status'] }>
  /**
   * 入站文本（M44）：人在 IM 里发的一句话交给宿主派活。`ref` 是平台消息引用（幂等键）。
   * 派给谁**由宿主决定**（读通道配置里的默认智能体），通道只拿 `{ accepted, conversationId,
   * receipt }`：`receipt` 是宿主写的回执文案，通道原样回帖（包括没派出去的原因）。
   * `agent`（M45）只给多连接通道用：按连接覆盖默认智能体（id 或名称），空则沿用通道配置。
   */
  submit(text: string, ref?: string, agent?: string): Promise<ChannelSubmitOutcome>
  /**
   * 进展（M44）：这个通道提交过的会话里，智能体说完了一轮（`reply`）或这一轮失败
   * （`failed`）。通道据此回帖到发起那条消息下面；别的会话不会打扰这个通道。
   */
  onProgress(handler: (progress: ChannelProgress) => void): () => void
  /** 宿主停用通道或退出时 abort */
  signal: AbortSignal
}

export interface ChannelSdk {
  log(line: string): void
  now(): number
  notify(title: string, body: string): void // 需要 manifest 声明 capabilities: ['notify']
  /** 插件自有配置（M7：manifest 默认值 + 用户设置合并；宿主按通道分别注入） */
  config<T = Record<string, unknown>>(): T
  /** 出站 HTTP（M7）：需要 manifest 声明 capabilities: ['net']；宿主未注入时不可用 */
  net?: ChannelNet
  /**
   * 子进程（M42）：需要 manifest 声明 capabilities: ['spawn']，未声明时访问即抛
   * `capability_not_declared`。只暴露 `spawn` / `resolve` / `killTree` 三件事——
   * IM 通道要驱动自带凭据与长连接的 CLI（`lark-cli`），宿主不为每个平台写适配器。
   * `spawn(command, args, options)` 的 `options.env` **省略即继承宿主环境**；要增删个别键
   * 用 `options.envPatch`（M45：先删 `unset` 再覆盖 `set`），卡片正文只作 argv / stdin
   * 参数，不拼命令行字符串。
   */
  process: ChannelProcess
}

/**
 * 卡片上下文（M54）：这张卡**属于哪件活**。宿主从投影里算好随卡片下发（`host/card-context.ts`），
 * 通道只负责摆进消息——全部字段只读展示，不参与「谁该答」的判定，缺值就是 null。
 */
export interface CardContext {
  projectName: string | null
  taskTitle: string | null
  conversationTitle: string | null
  stageName: string | null
  agentName: string | null
}
```

- **卡片上下文（M54）**：卡片标题与正文是智能体写的自由文本，`Card` 只带 `taskId` / `conversationId` 这类弱引用。真机上落到飞书的就是一句「覆盖率棘轮红：打回补测还是接受现状？」——收到的人不知道这是哪个项目、哪条任务、谁在问，于是「不知道该怎么回答」。所以宿主每次投递按视图查一份上下文（`task.byId` / `run.byId` / `projects.all` / `workflows.all` / `agents.all` / `conversations.all`）交给通道：**只读、best-effort**——查询失败或形状不对逐项降级为 null，全部为 null 时整份给 null，投递照常；飞书把它渲染成正文第一块（项目 · 任务 · 会话 / 阶段 · 智能体），外部通道的 `card` 帧同样带 `context`。
- 端口版本：`CHANNEL_PORT_VERSION = 7`（`packages/core/protocol/src/channels.ts`；1 = M4 最小面，2 = M42 增 `process`，3 = M43 的 `onCard(card, ref)` 与 `answer(..., ref, byRef) → { changed, status }`，4 = M44 的 `submit` / `onProgress`，5 = M45 的 `submit(text, ref, agent)` 与 `SpawnOptions.envPatch`，6 = M47 的 `submit(text, hints, agent)` 入站线索，7 = M54 的 `onCard(card, ref, context)`）；上下文形状变化时递增，外部通道（M7）按它做兼容判断。外部通道的 `card` 帧带 `ref` 与 `context`（可选字段，老插件不读即忽略），`answer` 帧不带 ref（适配器按 `undefined` 处理，校验退化为「只认 open 状态」）。
- 卡片正文是**别人写的文字**：只能作为参数传进平台/通知 API，绝不能拼进脚本/模板/HTML；`notify(title, body)` 的两个参数同样只作参数。
- **Windows 的 `.cmd` 垫片要折回真实入口（2026-11-15）**：`spawn(..., { shell: true })` 在 Windows 上经 `cmd.exe`，而 cmd 会先吃掉参数里的双引号（`--content '{"schema":"2.0"}'` 到程序手里变成 `{schema:…}`），正文里的 `&` / `%` 还会被当成命令分隔符与变量展开——飞书卡片 JSON 发不出去（真机复现：`--content is not valid JSON`）。所以宿主 `host/process.ts` 在 `shell: true` 时先读 `.cmd` / `.bat`，把 npm 垫片模板里的 `"%_prog%" "%dp0%\…\x.js" %*` 折回「`node` + 脚本」直接 spawn（`shell:false`；Electron 下补 `ELECTRON_RUN_AS_NODE=1`），参数原样进 argv；解析不出绝对脚本才退回 shell。执行器侧 `command` 插件仍用 `cmd.exe /c <脚本> <参数>`、提示词只走 stdin（那条路不传 JSON，见上文）。
- 投递状态是**两层账**（M43）：
  - **按通道**：`cards.delivery_refs_json` 存 `Record<通道键, { version, status, ref, at }>`，只有成功发出过才有条目；同一 `(通道, 卡片, 版本, 状态)` 只投一次。回答 / 关闭也是「状态」，所以终态会**回到每一处已经发出去的消息**上改口（IM 里的卡不会永远带按钮）。
  - **聚合**：`cards.delivery`（`pending → delivered | failed` = 至少一个通道送达）、`deliveryRef`（本版本首个成功通道的 ref）、`deliveryAttempts` / `nextDeliveryAt` / `deliveryGivenUp`（重投曲线，不按通道各算一份）。重启后只补「卡片仍 open、该通道还没同步这个版本 / 状态」的那些。
- 投递语义（`packages/host/host/src/channels.ts#planFor`）：卡片 open → 没发过 / 版本变了就发（有 ref 走原地更新）；卡片已答或已关 → **只补给「发过这张卡、且还停在旧版本 / 旧状态」的通道**，从未发过的通道不必知道「已经答复了」；`deliveryGivenUp` 且从未发过 → 不再打扰。
- **回答的唯一性与锁定**在内核（`kernel/scopes/cards.ts#answerFacts`）：`open` 之外一律 `conflict` 零事实，所以同一张卡无论从工作台还是 IM 回答，只有第一次有效；`answer` 的 `ref` 校验保证「旧消息上的点击」不计入（答案必须配当前这一版问题）。
- 通道崩溃、抛错或超时不影响内核：卡片仍是 `open`，投递由宿主 fire-and-forget 隔离并在恢复后按上面的规则补投；本轮所有通道都没成功才落 `card.delivery_failed{channel}`。
- 通道只读卡片、只回报投递与回答；**不改卡片内容、不决定派给谁**。
- **`submit` / `onProgress` 留在协议里，但飞书通道不再使用**（产品口径：工作台只做 AI 自动化，不做 IM 聊天，也不需要「私聊派活 / 进展回帖」）。飞书侧已删除入站解析（`inbound.ts`）、入站长连接、`adopt`（第一条私聊认人）、回执与进展回帖；下面两条因此只描述协议与 hub 的既有能力，给仍要接 IM 聊天的外部通道用。
- 入站派活（M44，`submit` / `onProgress`）：
  - 通道只把「谁说的哪句话」交上去（正文 + 平台消息 id），**派给哪个智能体由 hub 读通道配置里的 `agent`（id 或名称）决定**；找不到 / 没配 / 内核拒绝都回 `accepted:false` + 一句原因，通道照样回帖——沉默是最差的反馈。
  - hub 用 `chat.create` + `chat.send` 两条命令落地，幂等键 `channel:<通道>:<平台消息 id>`：长连接重连或事件重放不会派两次活。
  - 进展只认「这个通道提交过的会话」：内核给聊天轮终态补的那条 assistant `message.appended` 被翻成 `ChannelProgress`（成功 `reply` / 失败 `failed`），只发给提交它的通道；别的会话、人发的消息、其它角色都不打扰。
  - 会话归属记在 hub 进程内（`submitted`）；重启后旧会话不再回帖——完整对话与产出仍在工作台里，IM 里只丢「后来那几句」。
- 宿主 hub（`packages/host/host/src/channels.ts`）负责注册/启停/分发/补投，通道启停排在 effects 之后、scheduler 之前；退出时 abort + best-effort dispose。每个通道的 ack / 未确认都记一条 `[channels]` 日志（按通道可观）。
- 多连接与环境隔离（M45，飞书通道）：
  - **一个通道可以接多个 IM 应用**：飞书通道的 `connections` 配置是一组连接，每条 = 一个 `lark-cli` profile = 一个飞书应用（一个机器人）。每条连接有自己的接收人 / 群 / 拍板人名单，事件长连接各自独立——于是「工作台助手」和别的 agent 的助手是两个机器人，消息不混、也**不会抢同一个应用的事件总线**（同一个飞书应用全局只允许一处 `event consume`）。
  - 通道的 `ref` 变成**按连接聚合的 JSON**（`{"<连接 id>": "<message_id>"}`），宿主原样存取；点击时通道逐连接比对「这条消息是不是该连接当前版本的那条」，不再依赖单值 `ref` 校验（既不传 `ref` 给 `answer`，也只认自己发过的消息）。
  - **只推需要拍板的卡（产品口径）**：飞书不再是聊天入口——通道只投 `kind === 'ask'`（缺列的老数据按「有没有选项」兜底，与 desktop 通道同口径）且仍 `open` 的卡，每条连接只挂一条长连接（`event consume card.action.trigger`）；`notice` 卡一张都不发、只 ack；终态只改「这条连接确实发过」的那条消息，没发过的卡照旧 ack、不在飞书里凭空多一张。**不订阅 `im.message.receive_v1`、不 `submit`、不回帖进展**，连接里也没有「派给哪个智能体」这一项。
  - **不继承别的 agent 的身份**：`lark-cli` 会按 `HERMES_HOME` / `OPENCLAW_HOME` 自动绑定到对方的工作区（`config bind --source hermes`），通道因此用 `envPatch.unset` 剔除这些变量（`LARK_ENV_UNSET`），落回本机默认工作区 `~/.lark-cli`；不剔除就会和别的 agent 共用应用与登录态。
  - **没有发送目标就不投递**：既没配接收人 / 群、也读不到 `lark-cli` 登录人的连接照样启用，但拍板卡发不出去——只记一次日志（「先在设置里填接收人或群，否则拍板卡发不出去」）。原来那条「第一条私聊认人」（M46 的 `adopt`）依赖入站事件，产品不再接收入站后一并删除。
  - **发群但没点名谁能拍板**（`chat` 配了、名单为空）才禁用整条连接：群里谁都能替你作答是不可接受的默认。
  - 设置页的「飞书连接」面板（`components/FeishuConnections.tsx`）负责生成这段配置，并经 `WORKBENCH_LARK_CHANNEL` 做本机探测（工作区 / 应用 / 身份 / 与别的 agent 是否撞车）、建 profile（app secret 只经 stdin 交给 CLI，不落工作台库）与设备码登录。面板与插件设置里的标量表单**不写同一个键**：`connections` 不由 manifest 声明字段、只归面板写（两边都能写同一个键时，父表单的旧值会把面板刚存的覆盖回去）。
  - **读侧必须配套（写进去要读得到）**：`sdk.config()` 由 manifest 默认值 + 设置里的已存值合并——manifest 声明的字段按字段类型收；**内置插件**另外透传设置里未声明的标量键（`connections` 这类「不进清单、只归专属面板写」的键必须到得了插件手上，否则面板写进去、插件读不到：profile 回落 CLI 当前登录、消息发到别的应用上——真机复现过「面板保存了，飞书里却没动静」）。外部插件仍只认 manifest 声明的字段：第三方插件的配置面由清单唯一决定，声明之外的键（含历史残留）不自动生效；非标量（脏投影里的对象 / 数组 / null）一律不下发。
  - **版式分四段，一段一件事（2026-11-15 重做）**：①**状态卡**（`FeishuStatusCard.tsx`）——状态点 + 一句话结论（可用 / 待登录 / 未就绪 / 撞车）+ 三格本机事实（`lark-cli` 路径、工作区、身份 · token）+ 一行接入链路（撞车告警、开放平台事件订阅入口），结论只写一次不重复 `appId`；②**连接列表**——每条一行，名字 + 健康度徽标（就绪 / 未登录 / 本机没有这个 profile / 跟随当前登录）+ `profile · 落点`，行内「编辑」「移除」；③**本机应用**——一行摘要 + 「管理本机应用」进弹窗；④**插件参数已撤（M46 收口）**——`lark` / `user` / `chat` / `answerers` 四项不再由 manifest 声明，面板底部不渲染标量表单（见下一条）。理由：这些内容原来平铺在同一屏，14 个输入控件混在一起，用户分不清哪些格子属于已有连接、哪些属于新连接。
  - **一条连接 = 一个弹窗（`FeishuConnectionDialog.tsx`）**：新增与编辑共用同一张表单，回填现有配置。落点用分段控件（跟随登录人 / 私聊某人 / 发到群）而不是两个并排的地址输入框——配置里 `chat` 优先于 `user`，两个都能填时用户无法预判消息落到群还是私聊；选了落点却没填地址就地报错（不静默退化成「发给自己」），连接名与 profile 都空也报错。编一条绑了已删除 profile 的旧连接时，下拉补一条「（本机没有）」兜底项，不退回「没选」。**没有「派给哪个智能体」这一项**：飞书只承载拍板卡，没有可以派活的对象。名单项的展示口径是「谁能拍板」（字段仍叫 `answerers`）。
  - **配置面收口到「一条连接」里（M46 收口）**：飞书 manifest **不再声明任何标量字段**（`config: []`）——发到哪、谁能拍板只存在于一条连接里，设置页的「插件参数」整块因此不渲染。原来那四项（`lark` / `user` / `chat` / `answerers`）只在 `connections` 为空时作为旧配置兜底活着（`readFeishuConnections` 的 legacy 分支），界面上不再暴露：连接里有同名字段时它们一行都不读（该函数在拿到第一条连接后就提前返回），留在版面上只会让人以为「填这里也生效」。状态卡底部的开放平台入口**不断言「还差一步」**——订阅状态本机探测不到，文案只陈述「长连接只要求订阅 card.action.trigger（拍板卡的按钮回调）」并给入口。
  - **「我已完成授权」按状态判定，不按退出码判定**：`lark-cli auth login --device-code` 会把进度日志打到 stderr（设备码流程里是 `[lark-cli] device-flow: token response received`），而且在「token 已拿到、写 token 存储失败 / 抢锁超时」这类情况下**仍会非零退出**。所以 `host/lark-admin.ts` 的 `loginPoll` 分两步：①退出码非零时先用 `whoami` 复查该 profile，token 真在就返回 `ok:true`（别让人对着一个红条重复点）；②确实失败时给 `exitReason(exitCode, stdout, stderr)`——先找失败信封（含「日志与 JSON 帧混在一段」的情况），再退回「剔掉 `[lark-cli]` 日志行后的剩余行」，两者都没有就给带退出码的兜底建议。**禁止把 CLI 的进度日志原样报成错误**，也禁止在无输出时回一句空文案（这三个动作一次改齐：`add-profile` / `logout` / `remove-profile` 同样走 `exitReason`）。
  - **本机应用是一张 profile 表（`FeishuAppDialog.tsx`）**：profile 本身就是列表数据（名字 / 应用 / 登录人 / token 状态），所以铺成表格——列取这五项，新建是表格上方的主操作，登录与删除是**行内操作**（`登录` / `删除`），一次能看全「这台机器上有哪几个应用、各自什么状态」。授权指引挂在该行下面一行（短标签「打开授权页」+ 完整地址进 `title`/`href` + 「我已完成授权」）——设备码 URL 长且不可换行，把地址原样铺进单元格会把表格撑宽、把右侧操作列挤出可视区（真机复现过的缺陷），所以链接文字固定为短标签、说明文字 `min-w-0 truncate`、表格容器 `overflow-x-auto` 兜底，删除只有点开的那一行进确认态（同一行变成 `×` + `确认删除`），不打断别的行。**删除 profile**（`profile remove <name>`）会连带清掉它的 app secret 与 token（不可撤销），所以要先抬一次确认态；删成功后重新探测，并把那一行展开的授权指引一起收起（删别的行不动它）。**登录走行内**：点哪一行就登哪个 profile（请求带该行名字，不再有独立的「登录目标」下拉），发起中该行按钮显示「发起中…」且不可重复点。分段控件（新建 / 登录 / 删除）不适用：那把「有哪几个应用」这一层跨屏拆散，且三件事之外的大部分时间用户只是在看清单。

### app

```ts
// packages/client/shell/src/types.ts（M5 定稿）
export interface AppPlugin {
  id: string
  name: string
  icon: ComponentType<AppIconProps>
  component: ComponentType
  /** 可发事件类型（如 pomodoro.completed）；必须同步 packages/contract/app-events/src/index.ts 的白名单 */
  events?: readonly string[]
}
```

- 注册表在 `renderer/src/shell/registry.ts` 导出 `appPlugins`；`Workbench` 只按清单渲染，外壳零改动。
- app 只消费内核视图、只发命令：读用 `useKernelView(view, params)` / `useKernelViewState`，
  写用 `getKernelStore().dispatch(command)`；不得自己起 IPC 订阅、不得轮询、不得在组件里算「执行中」。
- **app 事件（M5/M6）**：`events` 只是可发类型声明；宿主在 `app.event` 命令入口按
  `packages/contract/app-events/src/index.ts` 的 `APP_EVENTS` 校验 `appId + eventType`，不在清单里的一律拒绝。
  命令载荷 `{ appId, eventType, subject, summary?, detail?, link?, dedupeKey? }`，内核产一条
  `event.received`（`source='app'`、`hops=1`、`originRunId=null`）；M6 起与外部事件走同一匹配路径，
  命中规则即建任务（同一规则 + 同一入口键只建一次）。
  当前内置 app 只有 `ai-workflow`（`events: []`）；`pomodoro` 已随整个包删除。

## 内置插件清单

| 类型     | id                | 说明（运行时协议）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 现状来源                                                                                             |
| -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| executor | `dsh`             | DeepSeek Harness `--stdio` JSONL 协议，探测/模型/执行/终止；`detect` 只报本机 `dsh` 命中                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/plugins/executor-dsh/`（含 `detect.ts`）                                                   |
| executor | `command`         | 通用 CLI：`argsTemplate` 逐项展开成 argv，`{prompt}` 决定 argv 元素或 stdin；**M40**：脚本阶段用 `Turn.args`（逐项原样、不展开）且命令只取 `runtime.command`，`prompt` 为空时不写 stdin；`probe` 只解析可执行文件 + 参数模板（不 spawn），**不提供 `detect`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `packages/plugins/executor-command/`                                                                 |
| executor | `remote`          | 远端 Worker 架构位（M7）：无传输时回执 `runtime_missing`，有传输时透传事件/回执；不监听端口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `packages/plugins/executor-remote/`（M7）                                                            |
| executor | `claude`          | Claude Code `--print --output-format stream-json`：提示词走 stdin、逐行 JSON 帧；探测要求 `--help` 含 `--print`/`--output-format`；不支持 `models`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `packages/plugins/executor-claude/`（2026-11-08）                                                    |
| executor | `hermes`          | Hermes Agent `hermes acp`（ACP / JSON-RPC 2.0 over stdio）：initialize → session/new\|load → set_mode/set_model → prompt；审批往返回帧、取消走 `session/cancel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/plugins/executor-hermes/`（2026-11-08）                                                    |
| executor | `codex`           | 后续；接入方式 = 新增插件目录 + registry 一行，`detect` 只读扫描                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 后续                                                                                                 |
| source   | `app`             | app 插件发来的事件（经 `app.event` 命令，按 `APP_EVENTS` 白名单校验）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | M5 起（事件消费 M6）                                                                                 |
| source   | `manual`          | 设置里手动触发一条自动化规则（`rule.trigger` 命令，不是独立插件进程）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | M6                                                                                                   |
| source   | `webhook`         | 本机回环 HTTP（只绑 `127.0.0.1`）+ HMAC-SHA256 验签；通过后 `ctx.emit` → `event.received`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/plugins/sources/webhook/`（M7）                                                            |
| source   | `fs`              | 目录变化去抖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 可选                                                                                                 |
| channel  | `in-app`          | 默认通道：投影即送达，收到卡片（含终态回写）立即 ack `delivered{ref:'in-app'}`；UI 直接批                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/plugins/channels/in-app/`（M4；M43 终态也 ack）                                            |
| channel  | `desktop`         | Electron 系统通知：`sdk.notify(title, 固定指引)`——标题来自卡片，正文固定一句「点开工作台查看并处理」，卡片正文与选项不进系统通知；**只弹 `kind='ask'` 的卡**（缺 `kind` 的老数据按「有无选项」兜底），**不按 run 合并**：每张卡各弹一次，同一张卡的同一 `version` 重投不重复弹、`version + 1` 的原地更新照弹（其余照常 ack `delivered`）；失败落 `card.delivery_failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `packages/plugins/channels/desktop/`（M4；M12 收敛打扰口径；原件 `packages/api/http/src/notify.ts`） |
| channel  | `webhook-channel` | 出站 webhook（M7）：把 open 卡 POST 到配置地址（单向，不回收答案）；终态不推送、只 ack；未配置不投递                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `packages/plugins/channels/webhook-channel/`（M7；M43 终态 ack）                                     |
| channel  | `feishu`          | 飞书（M42/M43/M45，M48 收敛为「只推拍板卡」）：经本机 `lark-cli` 发 interactive 卡片（`im +messages-send`）、原地更新（`im messages patch`）、长连接收回调（`event consume card.action.trigger`）→ `answer`；**只投 `kind='ask'` 且仍 `open` 的卡**（缺 `kind` 的老数据按「有无选项」兜底，与 desktop 通道同口径），`notice` 一张都不发、只 ack；同一 `(cardId, version)` 每个连接只发一次，`ref` 是按连接聚合的 JSON 由宿主持久化（重启后仍能改口），终态只改「这条连接确实发过」的那条消息（没发过的不落新消息、照旧 ack），**渲染一律按卡片当前状态**（已答 → 绿色「已记录：X」且去掉按钮；已关 → 灰色）；点击监听退出 30 s 重连（同一飞书应用全局只允许一处 event bus）；**没有发送目标（没配接收人/群、也读不到登录人）时只记一次日志、不投递**。**不做聊天**：不订阅 `im.message.receive_v1`、不 `submit`、不回帖进展，连接里也没有「派给哪个智能体」。**不存 app secret、不开公网端口**（凭证与 WS 长连接都在 CLI 侧） | `packages/plugins/channel-feishu/`（M42；M43 终态回写；M45 多连接；M48 只推拍板卡）                  |
| app      | `ai-workflow`     | 看板 / 任务详情 / 设置三视图                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `packages/client/apps/pomodoro`                                                                      |
| app      | ~~`pomodoro`~~    | 已删除（`app-pomodoro` 整个包下线，注册表只剩 `ai-workflow`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `packages/client/apps/ai-workflow`                                                                   |

## 外部插件（M7）

- 目录：`userData/plugins/<kind>/<id>/`（`manifest.json` + `plugin.mjs`，固定入口名）。宿主启动时扫描（`host/plugins/discover`），**不做安装向导、不执行安装脚本、不装依赖**——用户放入目录即被发现。
- 开放范围：**M7 只开放 `source` / `channel` 两类**；`executor` 外部插件需要 probe/models/领取往返，manifest 合法但以 `kind_unsupported` 拒绝并展示原因；`app` 类外部插件同样不开放。
- 加载顺序：用户目录与内置同 `(kind, id)` 时用户优先（覆盖内置）；插件 id 全局唯一（跨 kind 撞 id 或用户目录内重复 → `duplicate_id` 拒绝）；manifest 非法 / 入口缺失 → 不装载、记日志、设置页「插件」里以 `manifest_error` + 具体原因展示，**不静默降级**。
- 运行：**独立子进程**（`process.execPath`，cwd = 插件目录），stdio JSONL 帧 v1（`PLUGIN_HOST_PROTOCOL_VERSION=1`）：
  - host → plugin：`welcome{pluginId,granted,config}`（收到合法 `hello` 后自动下发，config 含授权后的 secret）、`card`、`shutdown`；
  - plugin → host：`hello{id,kind,version,capabilities}`、`log`、`event`（source）、`delivered` / `answer`（channel）。
    单帧 ≤64 KiB（超长行整行丢弃不涨内存）、`hello` 超时 5 s、非 0 退出/崩溃最多重拉 3 次（1 s），之后状态 `error`；`stop` 先 `shutdown` 再 SIGTERM 再 killTree。
- 环境：子进程环境走**白名单**（`PATH` / `SystemRoot` / `SystemDrive` / `COMSPEC` / `PATHEXT` / `TEMP` / `TMP` / `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` / `HOME` / `SHELL` / `LANG` / `LC_*` / `ELECTRON_RUN_AS_NODE`），**不继承 `process.env` 其他键**；secret 只经 `welcome` 下发，不进命令行/日志/环境。
- 授权：外部插件默认未启用；manifest 声明的能力须**全部**被授权且 `enabled=true` 才启动，缺一即 `unauthorized`（不启动）。授权是**信任门不是 OS 沙箱**：子进程仍受操作系统权限约束，宿主只控制「启不启动 / 下发哪些 config 与 secret」。
- 设置与 secret：非密钥设置走第 14 张投影表 `plugin_settings`（`plugins.replaced` 整批替换、版本 +1）；secret 写宿主私有表 `plugin_secrets`（`safeStorage` 加密，不进事实/视图/快照），视图只回 `secretKeys`；`safeStorage` 不可用时写入口拒绝（`unsupported`），不落明文。
- 设置生效时机：端口 / 地址 / secret 等运行期配置在**应用启动时**装配，修改后需重启应用生效（不引入热重启状态机）。
- 设置页「插件」：宿主视图 `plugins.all`（磁盘目录 + 设置 + 运行状态）；两级展示——列表只给概览（名称、可用性、启停开关、种类 · 版本、内置/外部、一行描述），点进「插件详情」才有逐项授权、config 表单（secret 只写）、错误原因与保存；授权勾选只能选 manifest 声明的能力。

## 插件边界与审查要点

这些算出错：

- 插件 import 了 `packages/host/host/src/**` 内部实现、别的插件、或直接开 SQLite。
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
- **回执块：** 多块取最后一块、块内无十一键视为无回执、非法 JSON/非对象忽略、`ask` 选项为空/超限/标题超限整块忽略、`spawn` 标题为空/批次越界/条数超限整块忽略、`verdict` 非 `pass|fail` 与 `checks` 形状非法整块忽略（`checks: []` 不连累 `verdict`）、`checks[].acceptance` 非正整数整块忽略、`findings` 小标重复或字段超限整块忽略、`addresses` 的 `fixed` 缺 `checkRef` / `rejected`·`deferred` 缺 `note` 整块忽略、**`acceptance` 键出现即忽略（M34 废弃，不连累同块其它键）**、只带 `verdict` 也算回执块、解析不修改 `output` 与终态；dsh 从 `result` 帧、`command` 从 stdout 各一条成功与失败用例。
- **通道：** 假通知/假平台，不发真消息；断言卡片文字与通知标题/正文只作为参数传递；每个通道各写一条 `card.delivered{channel}`、同一 `(通道, 版本, 状态)` 不重复投递；终态（answered / resolved）只补给「发过这张卡」的通道，从未发过它的通道不打扰；回答返回 `{changed, status}`，旧消息（ref 对不上）的点击不计入；**归属上下文**（M54）覆盖「查得到就随卡片下发 → 各通道各拿一份」「查不到 / 形状不对 → null 且投递照常」，以及飞书侧的「上下文在正文第一块、缺项不占位、全空不出现」。
- **飞书通道（M42/M43）：** 假 `ChannelProcess`（脚本化 stdout/退出/超时）覆盖：卡片 JSON 结构（ask 三态色、按钮回传值、notice 无按钮、已答 / 已关无按钮且换成结论、越界下标给占位文案）、`card.action.trigger` 解析（对象/JSON 字符串回传值、非按钮组件与表单提交不算答案、下标非整数忽略）、`lark-cli` 适配（argv 顺序、`--content` 整串、patch 走 stdin、非零退出/超时/找不到命令/输出非 JSON 都拒绝）、`start` 编排（未登录与缺答复人时 no-op、同版本重投走原地更新、版本更新走 patch 且失败退回新发、终态更新失败只记日志、白名单外点击不计数、已 settled 只记「未计入」、监听退出 30 s 重连、dispose 幂等）。不发真消息、不连真长连接。
- **注册表：** id 唯一、`key === manifest.id`、kind 合法、capabilities 在枚举内、必填字段齐全；`executors/*`、`channels/*` 目录与清单双向一致。
- **detect 汇总：** 按注册表顺序串行且顺序稳定、`executorKey`/`supported` 由汇总回填、输出按候选清单排序、同 `command` 先到先得、单插件抛错或超时被隔离、空注册表返回空数组且不扫盘。
- **外部插件装载（M7）：** 用户目录扫描按 `source`/`channel` 分目录；manifest 非法 / 入口缺失 / 未知类别 / 跨 kind 撞 id 全部拒绝并带原因；同 kind+id 用户覆盖内置且只保留一份；根目录/类别目录不可读降级不抛；`kind_unsupported` 只对合法的 `executor`/`app` 声明。
- **外部插件运行（M7）：** 假 spawn 覆盖 `hello` 前退出、hello 超时、非 JSON/超长行丢弃、重复 hello、帧解析失败、`start` 重入与停止中拒绝、崩溃重拉次数上限、`stop` 幂等与并发、`killTree` 抛错/无 pid；环境白名单不含 `process.env` 其它键、secret 不进环境与命令行。
- **能力面（M7）：** `net.fetch` 的头合并/超时/响应超限/非 2xx、`listen` 只绑回环且端口占用/关闭幂等/请求体超限/客户端中断、`verifyHmacSha256` 的格式/长度/常数时间比较；`fake-net` 与真实宿主实现同契约。
- **webhook（M7）：** 来源的路径/方法/时间戳窗口/签名/请求体上限矩阵，失败 4xx 且零事件、未配置不监听且 dispose 幂等；通道 2xx → `delivered`、非 2xx/超时/网络错误只记日志、`Authorization: Bearer` 只含 secret、无 secret 不带头。
- **设置与 secret（M7）：** `plugins.replace` 整批校验（id/kind/enabled/granted/config 标量）与版本 +1、`plugin.set` 合并与授权 ⊆ 声明能力、secret 键 ⊆ 声明的 secret 字段、幂等回放返回最新快照；投影/重建逐表等价且重建不清 `plugin_secrets`；真实库路径校验列名与「写入→读回明文、库里只有密文」；`safeStorage` 不可用时写入口拒绝（不落明文）。
