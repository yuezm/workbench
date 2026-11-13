# Spec: kernel（内核）

> Module id：`kernel`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。总纲见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> 定位：主进程内的纯 TS 模块。无 IO、无时钟、无随机数、无网络、无产品名。

## Objective

把「事件 → 决策 → 事实 → 投影」这一条链固定下来，让任务流转、运行调度、审批挂起、失败重试、跳数熔断只在一个地方定义；宿主与插件只负责输入与执行。

**非目标：** 开库、迁移、spawn、通知、UI、配置表单、HTTP。这些都在 `host` 或插件里。

## 派活单位：智能体

| 概念                       | 是什么                                                                                                   | 谁拥有                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **智能体（Agent）**        | 派活目标 + 执行配置：System Prompt、模型、思考强度、并发上限、访问权限、工作目录、环境变量、绑定的运行时 | 用户配置，内核投影 `agents`   |
| **运行时（Runtime）**      | 一条连接：执行器插件、命令、profile、参数模板、启用开关、最近探测结论                                    | 用户配置，内核投影 `runtimes` |
| **执行器插件（Executor）** | 协议适配实现（dsh / command / claude…），无状态；只负责「怎么调起并读回一轮」                            | 插件注册表                    |

派活链固定为：**规则 → 任务（工作流 + 阶段）→ 阶段绑定的智能体 `agentId` → 该智能体的运行时 `runtimeId` → 运行时的 `executorKey` 选择执行器插件**。规则只建任务，不直接派 run。内核只透传 `executorKey` 字符串，不知道 dsh、claude 是什么。执行器插件不是派活目标，也不能自己挑活。

**连接与执行配置分家（M27）**：运行时只回答「怎么把 CLI 起来」；模型、思考强度、并发上限、访问权限、工作目录、环境变量是智能体的设置。派活时内核把智能体的 `permissionMode` 映射成 `run.access`（闸门阶段至少 `full`：验收要求回执给出命令退出码，而 `workspace-write` 跑不了命令）、`workdir` 参与折算 `run.cwd`（项目文件夹优先）；激活时宿主把模型 / 思考强度 / 环境变量放进 `Turn`。

内核只校验 `executorKey` 的形状（非空 slug，`^[a-z][a-z0-9-]{0,63}$`），**不校验取值**；取值合法性由宿主入口按执行器插件注册表判断。`command` / `profile` / `executorKey` 的缺省值由 IPC 入口按执行器插件 manifest 补齐后再 `dispatch`，内核只见完整输入、零产品名。

## 类型契约

```ts
// src/kernel/types.ts
export type Seq = number
export type Id = string
export type Iso = string
export type Access = 'read' | 'edit' | 'full'

export type Actor =
  | { kind: 'owner'; via: 'ui' | 'channel' }
  | { kind: 'plugin'; id: string; kind: PluginKind }
  | { kind: 'host'; via: 'timer' | 'scheduler' | 'reconcile' | 'timeout' | 'cancel' }
  | { kind: 'kernel' }

export interface FactDraft<P = unknown> {
  type: FactType
  actor: Actor
  at: Iso // 由边界传入的 now，内核不取时钟
  cause?: Seq // 触发本事实的输入或事实，构成 why 链
  hops?: number // 仅事件类事实
  payload: P
}

export interface Fact<P = unknown> extends FactDraft<P> {
  seq: Seq
}

/** 只读视图：宿主按 `viewSpec(input)` 装好切片，内核不查库。 */
export interface View {
  seq: Seq
  rules: AutomationRule[]
  rulesVersion: number
  /** M7：插件设置快照与版本（`plugin_settings` 单行切片） */
  pluginSettings: PluginSetting[]
  pluginSettingsVersion: number
  tasks: Map<Id, TaskRow>
  workflows: Map<Id, WorkflowRow>
  stages: Map<Id, StageRow>
  agents: Map<Id, AgentRow>
  runtimes: Map<Id, RuntimeRow>
  threads: Map<Id, ThreadRow>
  runs: Map<Id, RunRow>
  cards: Map<Id, Card>
  conversations: Map<Id, ConversationRow>
  messages: Map<Id, MessageRow>
  eventKeys: Set<string> // (source, dedupeKey) 去重
}

/**
 * 卡片投影行（M4 第 10 张投影表；与 `src/protocol/entities.ts` 的 `Card` 逐列对应）。
 *
 * 正文是智能体产出的文字，只作平台/通知 API 的参数；投递按 `(id, version)` 去重，
 * 同一版本只投一次，更新（`version+1`）重新进 `pending`。
 */
export interface Card {
  id: Id
  runId: Id
  taskId: Id | null // 阶段 run 挂任务；聊天 run 为 null
  conversationId: Id | null // 聊天 run 挂对话；阶段 run 为 null
  title: string
  text: string
  kind: 'ask' | 'notice' // M12：通知口径的判据；ask 阻塞续接并发系统通知，notice 只知会
  options: string[] // 选项文案；信息卡（notices）为空数组
  key: string | null // 同一 run 内的稳定键，重复 ask 按它去重
  version: number // 1 基；更新 +1，投递按版本去重
  status: 'open' | 'answered' | 'resolved'
  delivery: 'pending' | 'delivered' | 'failed' // 单列 = 已送达至少一个通道
  deliveryRef: string | null // 最后一个成功投递的通道 ref
  optionIndex: number | null // 选中的选项下标（answered 后）
  answeredBy: 'ui' | 'channel' | null // 回答来源
  answeredAt: Iso | null
  createdAt: Iso
  updatedAt: Iso
}

/**
 * `View.runtimes` 的元素（`runtimes` 投影行）：字段与 `src/protocol/entities.ts` 的
 * `Runtime` 逐列对应。M3 起用 `executorKey` 表达「用哪个执行器插件」，无协议族字段；
 * M27 起运行时只描述**连接**（执行配置搬到 `agents`，见 `Agent`）。
 */
export interface RuntimeRow {
  id: Id
  name: string
  executorKey: string // 执行器插件键（slug；取值合法性由宿主入口按注册表判断）
  command: string // 启动命令（缺省值来自执行器插件 manifest）
  profile: string // 启动 profile（dsh 用它选 --stdio/--probe；其它执行器可为空串）
  argsTemplate: string // 参数模板（JSON 数组文本；空串 = 无参数）
  enabled: boolean
  createdAt: Iso
  lastProbe: RuntimeProbe | null
}

/** `View.agents` 的元素：派活目标 + 执行配置（M27 从运行时搬来）。 */
export interface Agent {
  id: Id
  name: string
  description: string
  runtimeId: Id
  systemPrompt: string
  model: string | null // provider/model；null = CLI 默认
  reasoningEffort: string | null // null = 模型默认
  maxConcurrent: number // 1–8，默认 1（同一智能体同时在跑的 run 上限）
  permissionMode: PermissionMode // 派活时映射成 run.access（闸门阶段抬到 full）
  workdir: string | null // 项目文件夹优先，其次这里，再空串 = 宿主默认目录
  env: Record<string, string> // 追加给子进程的环境变量
  createdAt: Iso
}

export interface Environment {
  timezone: string
  limits: Limits
}

export interface Limits {
  maxHops: 8
  leaseMs: 120_000
  heartbeatMs: 30_000
  maxAttempts: 3
  backoffBaseMs: 300_000
  backoffCapMs: 3_600_000
  runTimeoutMs: 3_600_000 // 缺省单轮超时 60 min（M26）；阶段配了 runTimeoutMs 就用阶段值
  cancelGraceMs: 3_000
  killAfterMs: 2_000
  maxFramesPerBatch: 500 // 运行帧批进入账上限，超出截断并记一条 dropped
}
```

## 函数

| 函数                                      | 职责                                        | 约束                                |
| ----------------------------------------- | ------------------------------------------- | ----------------------------------- |
| `viewSpec(input): Table[]`                | 声明该输入需要装载哪些投影切片              | 纯；宿主据此装 `View`，避免全表装载 |
| `decide(view, input, now, env): Decision` | 唯一决策入口：输入 → 事实                   | 纯；不抛异常，非法输入返回 `reject` |
| `project(fact): Change[]`                 | 事实 → 投影变更                             | 纯；实时写入与重建共用              |
| `nextWakeAt(view, now, env): Iso \| null` | 下一个到期时刻（cron / `notBefore` / 租约） | 纯；宿主只挂一个定时器              |
| `timeline(facts, scope, id)`              | `why` 时间线（事实 + cause 链）             | 纯；供宿主查询与 UI 展示            |

```ts
export interface Decision {
  facts: FactDraft[]
  reject?: { code: Reason; message: string }
}

export type Table =
  | 'tasks'
  | 'workflows'
  | 'stages'
  | 'agents'
  | 'runtimes'
  | 'threads'
  | 'runs'
  | 'run_events'
  | 'cards'
  | 'conversations'
  | 'messages'
  | 'event_keys'
  | 'rules'
  | 'plugin_config'

export interface Change {
  table: Table
  key: Id
  row: Row | null
} // row=null 为删除
```

**单写入者：** `decide` 只产出 `facts`；`project` 只产出 `changes`；写库只发生在宿主的一次事务里。内核里不得出现 `INSERT/UPDATE/DELETE`。

## 输入目录

| 输入                                                          | 来源                                            | 前置校验                                                                                                                                                       | 事实                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event.received`                                              | source 插件、app 插件、执行器回执派生（经宿主） | 字段白名单、类型合法、`hops` ≤ 上限、不带 `cwd/agent/runtime/access`                                                                                           | `event.received`（M6 起入账后立即按当前规则集匹配建任务；同一规则 + 同一入口键不重复建任务）；超过跳数则 `event.dropped`                                                                                                                     |
| `run.claim`                                                   | 宿主调度器（未来远端 worker 用同一形状）        | 运行时已配置且启用，`capacity` 1–8                                                                                                                             | `run.claimed` ×N（N ≤ capacity，且每条候选所属**智能体**在跑数 < 该智能体的 `maxConcurrent`）                                                                                                                                                |
| `run.heartbeat`                                               | 宿主调度器                                      | `leaseId` 匹配当前租约                                                                                                                                         | `run.lease_extended`                                                                                                                                                                                                                         |
| `run.receipt`                                                 | 执行器插件（经宿主转交）                        | run 属于该运行时、`leaseId` 与 `turn` 匹配当前轮                                                                                                               | 终态事实 + 回执五字段（`ask` → `card.opened` + `run.waiting`；`notices` → 信息卡；`resolves` → `card.resolved`；`later` → `run.queued`；`events` → `event.received`/`event.dropped`）+ 阶段流转                                              |
| `run.cancel`                                                  | owner                                           | run 处于 queued/claimed/waiting                                                                                                                                | `run.cancel_requested`                                                                                                                                                                                                                       |
| `run.host_settled`                                            | 宿主（scheduler / reconcile / cancel）          | 仅宿主 actor；run 存在                                                                                                                                         | 终态事实：`run.failed`（`timeout`/`executor_lost`）或 `run.cancelled`（`cancelled`）                                                                                                                                                         |
| `card.answer`                                                 | owner（ui）、通道插件（经宿主）                 | 卡片存在且 `status='open'`、`optionIndex` 在 `options` 范围内、run 处于 `waiting`；同一卡片只答一次                                                            | `card.answered`；该 run 的 open 卡**全部答完**时再产 `run.queued`（续接，`turn+1`、`resumeSessionId`）                                                                                                                                       |
| `card.resolve`                                                | owner                                           | 卡片存在且 `status='open'`                                                                                                                                     | `card.resolved{reason:'manual'}`；不改变 run 状态                                                                                                                                                                                            |
| `task.create` / `task.move` / `task.complete` / `task.remove` | owner                                           | 工作流/阶段存在；有活跃 run 时拒绝移动/完成；`task.create` 的项目可省（M11，省 = 默认目录），给了必须存在；子任务必须与父任务同项目                            | 任务事实 + 进入阶段效果（阶段绑定的智能体）；run 的工作目录取项目文件夹，无项目回落智能体 `workdir` / 默认目录；`task.remove` 顺带判定线程：还剩任务就按是否全部结束归档，队列删光则连线程一起删（`thread.removed`，宿主清该线程的落盘归档） |
| `thread.note`                                                 | owner、执行器回执（经宿主）                     | 线程 open、文本 ≤2000 字                                                                                                                                       | `thread.note_appended`                                                                                                                                                                                                                       |
| `thread.close`                                                | owner                                           | 线程存在                                                                                                                                                       | `thread.closed`（reason=manual）；有新事件时自动重开                                                                                                                                                                                         |
| `thread.bind`                                                 | owner                                           | 线程存在、`(source, externalRef)` 未被占用                                                                                                                     | `thread.bound`                                                                                                                                                                                                                               |
| `thread.remove`                                               | owner（线程详情页「删除线程」）                 | 线程存在；线程内没有活跃 run（queued / running / waiting，先 `task.stop`）；不存在按幂等删除（零事实）                                                         | 逐条 `run.removed`（执行记录）+ 各任务 `task.removed` + `thread.removed`（tombstone）；评论 / 评审报告由投影层按 `task_id` 联删，落盘归档由宿主清 `<artifacts>/threads/<threadId>/`                                                          |
| `task.stop`                                                   | owner（任务详情页「停止执行」）                 | 任务存在；只处理活跃 run（queued / running / waiting），已请求过的跳过                                                                                         | `run.cancel_requested`（逐条，`by='owner'`）；任务行不动，终态由宿主按取消时序落 `run.cancelled`                                                                                                                                             |
| `task.comment`                                                | owner（任务详情页反馈框）                       | 任务存在、正文 ≤2000 字；`rerun=true` 时仅当任务停在 `entryMode='agent'` 阶段且无活跃 run 才再排一轮                                                           | `task.comment_added`（+ `rerun` 可跑时附带一条 `run.queued`，提示词带反馈段）                                                                                                                                                                |
| `task.rerun`                                                  | owner（任务详情页「重新执行」）                 | 任务存在且未完成；当前阶段属于该工作流、`entryMode='agent'`、绑定的智能体与运行时都在；无活跃 run（执行中先 `task.stop`）                                      | `run.queued`（与 `task.comment{rerun}` 同一条进入阶段效果：`turn+1`、线程上下文、会话续接、项目工作目录；任务行与闸门预算不动）；条件不满足 reject，不静默零事实                                                                             |
| `workflow.*` / `agent.*` / `runtime.*`                        | owner                                           | 引用完整、名称唯一；有活跃 run 时拒绝改阶段；删运行时前校验被智能体引用                                                                                        | 配置事实                                                                                                                                                                                                                                     |
| `project.create` / `update` / `remove`                        | owner                                           | 名称与文件夹必填；名称与路径都唯一；项目下有执行中的任务（queued / running / waiting）时拒绝删除（M10）；删除成功时该项目下的其余任务与会话改归默认目录（M11） | `project.created` / `project.updated` / `project.removed`（整行事实，tombstone 删除）+ 归属变化时的 `task.updated` / `conversation.updated`                                                                                                  |
| `chat.create` / `send` / `remove` / `cancel`                  | owner                                           | 同一对话同时只跑一轮；`cancel` 只取消该对话的活跃 run；`chat.create` 的 `projectId` 可省（M11，省 = 默认目录），给了必须存在；聊天 run 的 cwd 取会话项目文件夹 | `message.appended` + `run.queued`（`purpose='chat'`）；被拒绝时不落消息；`cancel` 逐条产 `run.cancel_requested`                                                                                                                              |
| `app.event`                                                   | app 插件（经宿主白名单校验）                    | `appId + eventType` 必须在 `src/shared/apps.ts` 的 `APP_EVENTS` 内；摘要 ≤200 字                                                                               | `event.received`（`source='app'`、`hops=1`、`originRunId=null`）；M6 起与外部事件走同一匹配路径建任务                                                                                                                                        |
| `event.received`                                              | source 插件 / 宿主注入（M6）                    | 字段白名单同 `RawEvent`；`hops` 0–8；不带 `cwd/agent/runtime/access`                                                                                           | `event.received`（外部事件入账）+ 命中规则 `task.created`（同一规则 + 同一入口键只建一次）；超跳数只写 `event.dropped`                                                                                                                       |
| `rules.replace`                                               | owner                                           | 整批校验：`protocol/rules` 校验形状与字段上限，内核解析 `cron` 合法性，且 `workflowId` / `stageId` 必须存在与从属                                              | `rules.replaced`（版本 +1，整批替换）；整批非法则拒绝，旧版继续生效                                                                                                                                                                          |
| `rule.trigger`                                                | owner（规则页「立即运行」）                     | 规则存在且启用                                                                                                                                                 | `task.created`（`origin='rule'`、`externalRef=null`、title=规则名）+ 入口 run；不存在/停用 reject                                                                                                                                            |
| `plugins.replace`                                             | owner（设置页整批保存）                         | 整批校验：`protocol/plugins` 形状 / 上限；内核补 id 唯一、能力可识别、config 标量语义；secret 不在这条命令里                                                   | `plugins.replaced`（版本 +1，整批替换）；任一条非法整批拒绝、旧版继续生效                                                                                                                                                                    |
| `plugin.set`                                                  | owner（设置页改一条）                           | **宿主编排**：读 `plugins.settings` + 磁盘 manifest 合并 patch；授权必须 ⊆ 声明能力、secret 键必须 ⊆ 声明的 secret 字段                                        | 转 `plugins.replace`；`secrets` 写宿主私有表（不进事实）；直接进 decide 返回 `unsupported`                                                                                                                                                   |
| `clock.tick`                                                  | host 单定时器                                   | —                                                                                                                                                              | 到期事实：重试、租约过期、cron 到点（`task.created` + 入口 run + `rule.fired`；同刻一次、停机错过只补最近一次）                                                                                                                              |

去重与幂等：同一 `(source, dedupeKey)` 只处理一次，重复输入不产生事实；每轮回执按 `(runId, turn, payload 哈希)` 判定，同哈希返回上次结果、异哈希返回 `conflict`；所有命令带 `commandId`，重复提交返回原结果——M5 起由宿主 `commands` 表按事实区间回放（同事务记录，reject 不缓存；编排命令由命令路由二次校验）。

## 事实目录

| 事实                                                 | payload 关键字段                                                                                                                             | 投影                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `event.received`                                     | `eventId, source, type, subject, summary, detailRef, link, hops, originRunId, dedupeKey`（`summary` ≤200；`detailRef` 指向宿主落的资料文件） | —（只入账；M6 起命中规则由同一批事实产 `task.created`，重建时按 seq fold 一致） |
| `event.dropped`                                      | `eventId, hops, reason`（`hops > maxHops` 的熔断审计）                                                                                       | —（仅审计，不派活、不建卡）                                                     |
| `event.merged`                                       | `run: RunRow, eventId`（M6.5：事件合并到 queued run；整行让 `project` 保持纯函数）                                                           | `runs.eventIds`（仅 queued run 可合并）                                         |
| `rules.replaced`                                     | `ruleSet: RuleSetRow`（`id='current'`、`version`、`replacedAt`、`rules: AutomationRule[]`；整批替换）                                        | `rule_sets`（单行）                                                             |
| `plugins.replaced`                                   | `pluginSettings: PluginSettingsRow`（`id='current'`、`version`、`replacedAt`、`settings: PluginSetting[]`；整批替换非密钥设置）              | `plugin_settings`（单行，第 14 张投影表；secret 不在事实里）                    |
| `rule.fired`                                         | `fire: RuleFireRow`（`ruleId/version/scheduledFor/firedAt/taskId`；仅 cron 到点，append-only）                                               | `rule_fires`                                                                    |
| `event.dropped`                                      | `eventId, hops, reason`（`hops > maxHops` 的熔断审计）                                                                                       | —（仅审计，不派活、不建卡）                                                     |
| `run.queued`                                         | `run: RunRow`（整行；入队事实，`queueSeq` 由 `project` 用事实 `seq` 回填）                                                                   | `runs`                                                                          |
| `run.claimed`                                        | `run: RunRow`（整行；`leaseId` / `attempt` / `leaseUntil` / `deadlineAt` 在行里）                                                            | `runs`                                                                          |
| `run.lease_extended`                                 | `run: RunRow`（整行；仅 `leaseUntil` 前进）                                                                                                  | `runs`                                                                          |
| `run.waiting`                                        | `run: RunRow, cardIds: Id[], turn`（同时释放租约与并发位；`cardIds` 是本次挂起产生的卡片）                                                   | `runs.status='waiting'`                                                         |
| `run.frames`                                         | `runId, turn, frames[]`（协议帧批量入账；单批 ≤ `maxFramesPerBatch`，超出拆分为多条，不丢弃；帧 `seq` 由宿主按 run 全局单调分配）            | `run_events`                                                                    |
| `run.abandoned`                                      | `run: RunRow`（整行；回 `queued` + 退避，`attempts` / `notBefore` 在行里）                                                                   | `runs`                                                                          |
| `run.succeeded` / `run.failed` / `run.cancelled`     | `run: RunRow`（整行；`output` / `sessionId` / `usage` / `errorCode` / `exitCode` / `durationMs` 都在行里）                                   | `runs`                                                                          |
| `run.usage`                                          | `run: RunRow`（运行中增量；终态事实携带最终值覆盖）                                                                                          | `runs.usage`                                                                    |
| `run.cancel_requested`                               | `run: RunRow, by`                                                                                                                            | `runs.cancelRequested`                                                          |
| `run.receipt_rejected`                               | `runId, leaseId, turn, reason`（迟到/重复/不匹配回执的审计，不覆盖终态）                                                                     | —（仅审计，不改 `runs`）                                                        |
| `run.removed`                                        | `runId`（任务删除时随事实显式删除 run，替代 SQL 级联）                                                                                       | `runs`、`run_events` 删除                                                       |
| `card.opened`                                        | `card: Card`（整行；`version=1`、`delivery='pending'`）                                                                                      | `cards`                                                                         |
| `card.updated`                                       | `card: Card`（整行；`version+1`、投递重置 `pending`）、`changes?: string[]`（变更字段名，审计）                                              | `cards`                                                                         |
| `card.delivered`                                     | `card: Card`（整行；`delivery='delivered'`、`deliveryRef=ref`）、`ref: string`                                                               | `cards`                                                                         |
| `card.delivery_failed`                               | `card: Card`（整行；`delivery='failed'`）、`error: string`                                                                                   | `cards`                                                                         |
| `card.answered`                                      | `card: Card`（整行；`status='answered'`、`optionIndex`、`answeredBy`、`answeredAt`）、`by: 'ui'\|'channel'`                                  | `cards`                                                                         |
| `card.resolved`                                      | `card: Card`（整行；`status='resolved'`）、`reason: 'agent'\|'manual'\|'cancelled'`                                                          | `cards`                                                                         |
| `task.created`                                       | `taskId, workflowId, stageId, threadId, parentTaskId?, title, descriptionRef?, origin: 'manual'\|'rule', ruleId?, externalRef?, labels?`     | `tasks`                                                                         |
| `project.created` / `project.updated`                | `project: Project`（完整行：`id/name/path/description/createdAt/updatedAt`；M10）                                                            | `projects`（第 16 张投影表）                                                    |
| `project.removed`                                    | `project: Project`（tombstone；项目下没有执行中任务才会产）                                                                                  | `projects`（删除行）                                                            |
| `task.moved` / `task.completed` / `task.removed`     | 任务字段 / `from, to, by`                                                                                                                    | `tasks`                                                                         |
| `task.updated`                                       | `task: Task`（整行；动归属不动阶段：删项目时把遗留任务归默认目录，`projectId=null`）                                                         | `tasks`                                                                         |
| `task.comment_added`                                 | `comment: TaskComment`（`id/taskId/author/text/createdAt`；任务行不变，纯追加）                                                              | `task_comments`（第 15 张投影表；任务删除时按 `task_id` 联删）                  |
| `thread.opened`                                      | `thread: ThreadRow`（完整行）                                                                                                                | `threads`                                                                       |
| `thread.event_attached`                              | `thread: ThreadRow, eventId, summary?`（行内 `events` 已追加）                                                                               | `threads`                                                                       |
| `thread.task_attached`                               | `thread: ThreadRow, taskId, ruleId?`（行内 `taskIds/rootTaskIds` 已更新）                                                                    | `threads`                                                                       |
| `thread.note_appended`                               | `thread: ThreadRow, note: ThreadNote`（行内 `notes` 已追加）                                                                                 | `threads`                                                                       |
| `thread.closed` / `thread.reopened`                  | `thread: ThreadRow, reason: manual\|all-tasks-done\|inactivity` / `thread: ThreadRow, eventId`                                               | `threads`                                                                       |
| `thread.bound`                                       | `thread: ThreadRow, source, externalRef`（把手工线程绑定到外部入口）                                                                         | `threads`                                                                       |
| `thread.removed`                                     | `thread: ThreadRow`（tombstone；线程内的 run 由同批 `run.removed` 逐条删除，不在这里联删）                                                   | `threads`（删行）                                                               |
| `workflow.created` / `updated` / `removed`           | 定义（含阶段）；`versions`                                                                                                                   | `workflows`                                                                     |
| `stage.created` / `stage.updated` / `stage.deleted`  | 阶段定义 / `tombstone`                                                                                                                       | `stages`（id 稳定，删除不重建整表）                                             |
| `agent.created` / `updated` / `removed`              | 定义（含 `runtimeId`、`systemPrompt`）                                                                                                       | `agents`                                                                        |
| `runtime.created` / `updated` / `removed` / `probed` | 配置（含 `executorKey`）、探测结论                                                                                                           | `runtimes`                                                                      |
| `plugin.configured`                                  | `pluginId, kind, config`（secret 字段不进事实）                                                                                              | `plugin_config`                                                                 |
| `conversation.created` / `updated` / `removed`       | 对话（含 `projectId`，M11 可空 = 默认目录）、`agentId`                                                                                       | `conversations`                                                                 |
| `message.appended`                                   | `conversationId, messageId, role, content, runId?, error?`                                                                                   | `messages`                                                                      |
| `rules.replaced`                                     | `version, rules`                                                                                                                             | `rules`                                                                         |
| `snapshot.imported`                                  | `table, rows[], importedFrom`（按表分批；M1 迁移专用，只写一次）                                                                             | 对应投影                                                                        |

**卡片 payload（M4，D1）：** 六条 `card.*` 事实**一律携带完整 `card: Card` 行**（`card.updated` 另带 `changes`，投递/回答/关闭另带 `ref` / `error` / `by` / `reason` 审计字段）。这样 `project` 保持纯函数、只做「一行事实 → 一行投影」，重建时无需回查历史状态；投递状态是 `cards` 的单列 `delivery`（= 已送达至少一个通道），不按通道拆表，`deliveryRef` 记最后一个成功通道。投递按 `(cardId, version)` 去重：同一版本只投一次，`card.updated` 把 `version+1` 并重置 `delivery='pending'`。

**派生事件（M4 入账 / M6 消费）：** 回执 `events[]` 的每条事件写一条 `event.received`（`hops = 父 run.hops + 1`，`summary` ≤200 字；`detail` 由宿主落 `artifacts/<eventId>.md` 并把路径放 `detailRef`；`dedupeKey` 原样保留）；`hops > maxHops` 时只写 `event.dropped`、不派活、不建卡。M4 的事件**不参与投影**；M6 起同一批事实里立即按规则集建任务；M6.5 起派生事件按父 run 归线程/父任务（`originRunId` → `threadId` + `parentTaskId`），线程当前有 queued run 时合并为 `event.merged`。

**运行时 payload（M3）：** `runtime.created` / `updated` / `removed` / `probed` 的 payload 是完整 `Runtime` 行，**不再带协议族字段**（`protocolFamily` 是旧字段，仅迁移归一用）；老 payload 由宿主 `normalizeRuntime` 在折叠时回填 `executorKey` / `argsTemplate`，不保留兼容字段。这样重建与实时写入折出同一行。

**导入根：** `snapshot.imported` 是没有 `cause` 的基线，`timeline` 对它返回「迁移导入」而不是伪造因果链。导入之后的事实才具备完整 `why`。

## 阶段语义（不变）

沿用 `src/shared/stage-machine.ts` 的全部规则与 15 条硬约束（见 `SPEC-ai-workflow.md`「阶段状态机」与 `TEST-CASES.md`）：

- `entry_mode` = `none` / `agent` / `script` / `user`；每次进入阶段都重新触发进入效果。
- **脚本阶段（M40）**：`entry_mode='script'` 时阶段带内联脚本 `script = { runtimeId, command, args, cwd, env, timeoutMs }`（`agentId` 必须为空，二者互斥，保存时归一）。派活与智能体阶段同一条链路：产 `run.queued`，`agentId=null`、`script` 快照随 run 行落库、`access='full'`、`resumeSessionId=null`，提示词只有资料（任务 / 阶段说明 / 验收条目），不拼系统提示词与模型。工作目录取「项目文件夹 > 脚本 cwd」，超时取「脚本 `timeoutMs` > 阶段 `runTimeoutMs` > 全局缺省」。并发窗口固定 1。运行时不存在 / 脚本缺失 → 零事实（任务停在列里等人）。
- 自动流转只由 `run.succeeded` / `run.failed` 触发；打回目标解析后等于当前阶段时**零效果**、不重建 run。
- 人工拖拽落点即目标，不套用 `on_complete` / `on_reject`；有活跃 run（queued/claimed/waiting）时拒绝移动与完成。
- 「执行中」由内核投影现算，UI 与插件不得自行推导。
- 阶段 id 稳定：编辑工作流只发 `stage.created/updated/deleted`，不整表重建；删除用 tombstone，历史 run 的 `stageId` 不悬空。
- 有活跃 run 的工作流拒绝改阶段（改前后端校验同一规则）。
- 人工任务的分活入口：`task.create` 时选工作流与起始阶段；进入该阶段时按 `entry_mode` 决定交给阶段绑定的智能体（`agentId`）、停下等人、还是仅停留。任务本身不携带「派给谁」的指令，派发只来自阶段配置。
- **跨工作流交接（M7）**：阶段可配交接目标 `handoffWorkflowId` / `handoffStageId`（目标工作流不能是自身；目标阶段可空 = 目标首阶段）。任务**离开该阶段且向前**时（成功流转到下一阶段 / 向前拖拽 / 直接完成），内核在目标工作流建一条关联任务：`origin='handoff'`、`handoffFromTaskId` / `handoffFromStageId` 指向来源任务与阶段、新隐式线程（`source='handoff'`）、目标阶段为 `agent` 时同时产入口 run；**不回写来源任务**（不引入 `task.updated`）。同一 `(来源任务, 阶段)` 只交接一次；交接链深上限 8（沿 `handoffFromTaskId` 回溯），超深/目标失效/已交接一律零事实。打回与删阶段重挂不触发；目标工作流/阶段在保存时校验（`workflow.create/update` reject）。
- **交接产物挂父任务（M25）**：交接任务同时写 `parentTaskId = 来源任务`，于是它进得进来源任务的子任务树与 `tasks.byParent`；但它**只有**在来源阶段显式配了 `onChildrenSettled` 时才参与 rollup ——「一条交接产物把来源任务叫醒」不是 M7 的语义，老工作流行为逐字不变（`childrenSettledFacts` 的交接守卫）。配了 `wake` 的用法是「缺陷全修完 → 自动唤醒测试任务去回归」。`rootTaskIds` 相应按**线程内**判根：父任务不在本线程（交接产物）时它在自己的新线程里就是根。副作用是 `spawnDepth` 沿 `parentTaskId` 回溯，交接产物因此继承来源任务的深度——一条 8 层交接链的末端任务不能再 spawn（两个预算在这个方向上叠加），这是刻意收紧而非 bug。
- **`tasks.origin`**（M7 扩为 `manual` / `rule` / `handoff`）：`origin='handoff'` 只由内核产，Agent 与 UI 不能指定。
- **阶段要干什么（M9）**：`workflow_stages.instructions`（空串 = 没写）。进到该阶段的任务，其提示词在「# 阶段：名称」之后多一段固定指令「# 阶段要做什么」+ 原文（只去首尾空白、保留换行）；空/全空白时不产这一段，老提示词逐字不变。编辑时说明变化与其它字段一样按 `sameStage` 比较，变化才产 `stage.updated`。
- **闸门（M11，M32 改为 `judge` + 出口表；M40 支持脚本判定）**：阶段可配 `judge = { maxFails }`（空 = 不是闸门；必须 `entry_mode='agent'` 或 `'script'`，**判定者就是闸门阶段自己的执行目标**——它不实现任何东西，只验上一阶段产出；与被验阶段同一智能体时保存 reject，见下条）。`run.succeeded` 时读回执 `verdict`：`pass` 走 `exits.passed` 并把任务上的 `gateFails` 清零；`fail` 未达 `maxFails` 走 `exits.failed` 并 +1；`fail` 已达 `maxFails` **放行**走 `exits.passed`、任务打 `gate:degraded` 标签并追加一条 `task.comment_added`。`pass` 必须至少一条 `checks` 且退出码全为 0，否则按**没给结论**处理（任务原地停住，零事实）。`run.failed`（执行出错）走 `exits.errored` 且**不消耗**预算。判定未通过而离开不算 `exitsForward`，不触发派单；人工拖拽落位清零预算。**脚本闸门**：结论取 `run.exitCode`（`0` = pass、非 0 = fail、`null` = 没给结论，不采信脚本自报的 `verdict`）；`command` 执行器把非 0 退出报成 `failed`/`exit_nonzero`，闸门阶段在结算时归一回 `succeeded`（业务结论交给 `verdict`），非闸门脚本阶段保持 `failed` 走 `errored`；脚本闸门最多一条验收条目（一条命令只能证明一条验收）。
- **验收归属（M34，取代 M21 验收续轮）**：`acceptance` 只允许出现在闸门阶段（`judge` 非空）；执行阶段带非空验收条目 → `workflow.create/update` 整份 reject（`验收只能配在闸门阶段`）。执行阶段的 `run.succeeded` 不再读任何业务结论，直接走 `exits.done`；`maxRounds` / `tasks.stage_fails` / 出口 `retry` 全部删除，阶段内不再有自动续轮；提示词也不再产「本阶段第 N 轮（上限 M 轮）」段（`roundText` 删除），`stageRoundCount` 只留给会话策略（同阶段第 2 次起开新会话）。闸门阶段的 `pass` 需覆盖全部验收条目：每条验收要有至少一条 `exitCode=0` 的 `checks`（`acceptance: n` 1 基序号）指向它，未覆盖按**没给结论**处理（零事实、停在闸门、不消耗预算）。判定者与被验阶段同一智能体 → 保存时 reject。
- **人工跳转留痕（M22）**：`task.move` 的落点不等于本阶段自然去向（`on_complete` 解析结果）时，同批追加一条 `author='agent'` 的 `task.comment_added`（「人工跳转：A → B（自然去向：C）」）；不改转移公式，只留痕。
- **闸门判定与 `run.status` 正交**：`status` 只表达「执行器跑完没有」，`verdict` 表达「业务上过没过」；两者缺一都不能推进闸门。

## 规则

```ts
export interface AutomationRule {
  id: Id
  name: string
  when: { source: string; types: string[] } | { cron: string }
  to: {
    workflowId: Id // 建任务到哪个工作流（与手工建任务同一套引擎）
    stageId?: Id // 起始阶段；缺省用该工作流首阶段
    task?: { titleFrom?: 'subject' | 'summary'; labels?: string[] }
    thread?: { keyFrom: 'subject' | 'externalRef'; onExisting?: 'reuse-task' | 'new-task' }
  }
  prompt?: string
  parallel?: number // 同规则并行数，默认 1
  merge?: 'subject' | 'none' // 默认：事件规则按 subject 合并
  enabled: boolean
}
```

**规则只建任务，不直接派活。** 任务进入阶段后由该阶段的 `entry_mode` 决定交给智能体、等人、还是停留——外部事件与手工任务因此走同一个工作流引擎。同一规则 + 同一 `externalRef` 只建一次任务；后续事件合并到该任务（不重复建卡）。

匹配：`type` 支持精确、`*`、前缀 `x.*`；同一事件命中多条规则时全部建任务，**不经过模型、不排序、不取最优**；规则版本随 `rules.replaced` 递增，`task.created` 记录本轮 `rulesVersion`，`why` 据此还原依据。需要语义分类时由执行器产出新事件类型，再由规则建任务（分类器无权指定工作流/智能体/目录/权限）。

`cron` 是**内核规则**，不是 source 插件：解析、时区墙钟、下一次触发时刻全部在 `kernel/cron.ts`（纯函数）。夏令时策略：跳过的时刻不触发，重复的时刻只触发一次，停机错过只补最近一次。

**M6 实现口径：**

- 规则集是单行投影 `rule_sets`（`id='current'`：`version` / `replacedAt` / `rules`），整批替换、版本 +1、非法整批拒绝且旧版继续生效；cron 触发记录进 append-only 的 `rule_fires`（`ruleId/version/scheduledFor/firedAt/taskId`），`MAX(scheduled_for)` 是下一轮 cron 基线。
- 事件入口三处统一匹配：宿主输入 `event.received`（source 插件 / 测试注入）、`app.event` 命令（app 插件）、回执 `events[]` 派生事件；同一事件命中多条规则全部建任务，不排序。
- 去重键 = `to.thread.keyFrom`（缺省 `subject`）：取事件 `subject` 或 `dedupeKey ?? subject`；同一规则 + 同一入口键已有 **active** 任务时不再建任务（事件仍入账）；任务完成后新事件可再建任务。
- 规则任务 `origin='rule'` 并记录 `ruleId` / `externalRef` / `labels`（`tasks` 表 M6 追加来源四列，旧库补列、老事实 replay 归一）；首轮 run 记录 `ruleId` / `rulesVersion` / `eventIds` / `hops`，规则 `prompt` 追加到提示词末尾。
- `rule.trigger`（owner）是「立即运行」：按规则直接建任务（`externalRef=null`、title=规则名），不写 `rule.fired`；规则不存在或停用 reject。
- `to.thread` 在 M6 只校验与存储，M6.5 起生效（按 `(source, externalRef)` 归并、`reuse-task`/`new-task`、queued run 的 `event.merged`）；`merge` 在 M6.5 只覆盖「queued run 合并」，`parallel` 仍只校验与存储（同规则多并行未实现，见 refactor-plan M6.5 已知边界）。

## Thread（线程：上下文容器）

同一入口（GitHub Issue、邮件线程、工单、某个外部会话）来的事件归入同一线程，任务与运行共享上下文。

```ts
export interface ThreadRow {
  id: Id
  source: string // github / mail / manual / app:<id>
  externalRef: string | null // 外部入口键；手工线程未绑定时为 null
  title: string
  status: 'open' | 'closed'
  taskIds: Id[] // 含派生任务
  rootTaskIds: Id[] // 线程内没有父任务的任务（父在别的线程里也算根）
  concurrency: number // 同时可运行的轮数，默认 1
  notesVersion: number
  notes: ThreadNote[] // 最近 50 条（保最新）；资料，不是指令
  events: ThreadEventRef[] // 最近 50 条事件引用（摘要 + detailRef，正文留资料文件）
  lastActivityAt: Iso
  createdAt: Iso
}
```

- **身份**：`(source, externalRef)` 唯一。规则命中且已存在 → `thread.event_attached`；不存在 → `thread.opened` + `thread.task_attached`；已关闭 → 先 `thread.reopened` 再 attach。
- **任务归属**：默认 `onExisting='reuse-task'`——线程里有未完成任务时，在其当前阶段追加一轮（新 run 携带该事件）；没有未完成任务则新建任务到规则指定的起始阶段。`onExisting='new-task'` 总是新建任务。**同一事件命中多条规则时每条规则各自归并、各自建任务**（与 M6 规则口径一致）。
- **合并**：线程既有任务当前有 `queued` run 时，事件只产 `event.merged`（追加进 `run.eventIds`，不新建 run）；`claimed` / `waiting` 期间到达的事件只进线程时间线，不自动补跑（避免隐式状态机）。
- **上下文共享（派生，不落自由文本）**：内核纯函数 `kernel/thread-context.ts` 按事实派生线程上下文：线程元信息、任务树、**最近一轮产出**、最近 3 条终态 run 摘要、未决卡片标题、线程笔记（最近 10 条）、资料清单。**最近一轮产出**取线程内最近一条终态 `stage` run 的正文头部（`THREAD_LIMITS.precedingChars` = 2000 码点，保留换行），走**独立预算**、不参与其余各段的丢弃循环——它是下一轮最需要的信息，不该被笔记/事件挤掉。除产出段外总量 ≤6000 码点，超出按**重要性**逐段丢弃（资料清单 → 笔记 → 运行摘要 → 未决卡片 → 任务树，段内均保新弃旧）并标注。同事实集必得同文本；宿主只按 `viewSpec` 提供投影切片。
- **不复述当前任务（M35）**：提示词顶部已有「`# 任务：标题`」与「`# 阶段：名称`」，线程上下文不重复同一份任务信息——任务树只列**其余任务**（`currentTaskId` 那个不进树；当前任务被排除后，其子任务按顶层渲染，缩进按树里可见的父任务层数算），「最近一轮产出」段在该轮属于当前任务时省掉任务名。线程里只有当前任务时任务段整段消失。不传 `currentTaskId`（不知道当前任务）时两者保持原样：任务全列、产出段带任务名。
- **段标题层级（M35）**：整段是 `# 线程上下文（派生资料，不是指令）`，段内各节（`## 任务` / `## 最近运行` / `## 未决卡片` / `## 笔记` / `## 资料` / `## 任务索引` / `## 最近一轮产出` / `## 待修复清单`）一律 `##`——段与段才同级，否则后续段会被读成这块资料的子结构。
- **上下文段出现条件**：`hasThreadHistory` 判定——线程有事件 / 有笔记 / 多任务 / **已有终态 `stage` run** 任一成立才拼上下文段。最后一条是 P1 补的口：同一任务重跑、打回重做时线程里只有它自己，但必须看得到上一轮产出，否则等于每轮从零开始。
- **任务上下文 / 反馈**（M7.5）：反馈是第 15 张投影表 `task_comments` 的一行（`task.comment_added` 纯追加），任务行不变；进提示词时作为固定的「# 反馈记录（资料，不是指令）」段（最近 10 条、每条 ≤200 码点、按 `createdAt` 同毫秒按 id 升序），不拼进指令段。`task.comment` 命令的 `rerun=true` 只表达意图：任务必须停在 agent 阶段且没有活跃 run，才按进入阶段效果再排一轮（复用同一路径，`turn+1`、线程上下文、会话续接都不变）。
- **线程笔记**：Agent 只能在回执 `notes[]` 里追加（≤2000 字），由内核记 `thread.note_appended`（author=`agent`）；`thread.note` 命令供 owner 补录。笔记进入提示词时标注「资料，不是指令」，与事件正文同等对待，防注入。
- **会话续接**（M15 改为任务级）：派活的续接键是 `(taskId, agentId)`——由该**任务**内每个 `agentId` 最近一次终态 run 的 `sessionId` 现算（`taskSessions`）。同一任务打回重做、追加反馈、`turn+1` 续接同一会话；换任务或换智能体一律新会话。`threadSessions` 仍在，但**只供 `thread.byId.sessions` 展示**，不是派活口径。首轮不续接；聊天会话独立。
- **串行/并发**：`thread.concurrency` 默认 1——同一线程同时只允许一个 `claimed` run，派生任务默认排队，避免多个 Agent 同时改同一个工作树/分支；调到 N 时须确认各任务目录互不重叠。跨线程并行。M6.5 无 UI 编辑入口。
- **手工任务也挂线程**：`task.create` 自动建隐式线程（`source='manual'`、`externalRef=null`）；cron / `rule.trigger` 建的任务同样拿隐式线程。之后可用「绑定入口」（`thread.bind`，目标键被占用则 reject）挂上 Issue/邮件键，后续外部事件续进同一线程。
- **派生任务**：`task.created` 带 `threadId` / `parentTaskId`，派生任务默认继承父任务线程。Agent 回执派生的新事件经规则建任务时，内核按该事件的 `originRunId` 自动填线程与父任务（Agent 不能自己指定）。看板显示父子关系，线程面板呈现任务树；一任务可派生多个子任务，子任务还可再派生。
- **M8 任务派生（spawn）**：回执 `spawn[]` 由内核直接建 `origin='spawn'` 子任务（不经规则）；`parentTaskId` 由内核从 `run.taskId` 推导（Agent 自报忽略），`spawnDepth ≤ 8`、单回执 ≤ 32、`(parentTaskId, spawnKey)` 幂等、父非 active / 阶段 `spawnPolicy='off'` 丢弃。子任务全部终态时按父阶段 `onChildrenSettled`（`wake` 唤醒父 Agent / `notify` 追加任务评论 / `complete` 完成父任务）rollup，父已有活跃 run 即视为已触发；多层派生沿 parentTaskId 链级联。`task.create` 可带 `parentTaskId` 人工挂子任务。
- **生命周期**：线程内所有任务（含派生）完成或删除 → `thread.closed(all-tasks-done)`；**线程内任务行被删光**则不归档而是 `thread.removed`（由 `task.remove` 连带产出，与「删除线程」同口径，线程与执行记录一起消失）；`clock.tick` 对超过 14 天无活动的 open 线程记 `inactivity`；新事件到达自动 `thread.reopened`；`thread.close` 是人工归档（幂等）。关闭只影响 UI 归档与检索，不影响事实。`thread.remove` 才是删除：线程内没有活跃 run 时，逐条删执行记录（`run.removed`）→ 删任务行 → `thread.removed`，线程与其执行记录一起消失（宿主另清 `<artifacts>/threads/<threadId>/`）。
- **跳数**：线程不重置 `hops`，回执派生事件仍按父 run +1 累计。

## 调度

| 事项       | 规则                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 领取       | 宿主按运行时发起；按 `notBefore` 升序、同序按 `seq` FIFO；每条 run 所属智能体在跑数 < 该智能体的 `maxConcurrent`；`waiting` 不占位                                                                                  |
| 租约       | 领取即 `leaseId = runId:attempt`、`leaseUntil = now + leaseMs`、`deadlineAt = now + 本次超时`（M26：阶段 `runTimeoutMs` 优先，否则 `limits.runTimeoutMs` = 60 min）；心跳续租；过期 → `run.abandoned`，`attempts+1` |
| 超时       | `clock.tick` 到 `deadlineAt` → `run.failed{errorCode:'timeout'}`（actor `{kind:'host',via:'timeout'}`），终止进程同取消时序                                                                                         |
| 迟到的回执 | 只接受 `leaseId` 与当前 `turn` 匹配的回执；旧 attempt 的回执直接丢弃并记 `run.receipt_rejected` 审计事实，**不覆盖终态**                                                                                            |
| 宿主兜底   | 执行器不可达、超时或取消无回执时，由宿主发 `run.host_settled` 输入写终态（`timeout` / `executor_lost` / `cancelled`）                                                                                               |
| 重试       | 退避 `backoffBaseMs × 2^(attempts-1)`，封顶 1 h；`attempts ≥ 3` → `run.failed` + 开卡片通知                                                                                                                         |
| 取消       | 内核只记 `run.cancel_requested`；终止进程由宿主按「cancel 帧 → 3 s → SIGTERM → 2 s → SIGKILL」执行，回执落终态                                                                                                      |

**单轮超时（M26）**：`run.claim` 时按 `run.stageId` 查阶段，阶段 `runTimeoutMs` 非空就按它算 `deadlineAt`，否则（阶段没配 / 阶段行查不到 / 聊天 run 没有阶段）用 `limits.runTimeoutMs`；执行器进程的超时由宿主取「`deadlineAt` 减当前时刻」传入，内核与进程不各留一套时限。
| 合并 | 仅 `queued` 可合并；`claimed`/`waiting` 期间的新事件排队为下一轮的独立事件，不静默丢弃 |
| 并发隔离 | 按**智能体**隔离：每个智能体有自己的 `maxConcurrent` 窗口；同一连接上的不同智能体互不占位 |
| 线程并发 | 同一线程同时 `claimed` 数 ≤ `thread.concurrency`（默认 1）；超出排队，跨线程不受影响 |

## 审批（挂起零消耗）

1. **建卡**：回执带 `ask[]` → 每条产 `card.opened`（`version=1`、`delivery='pending'`；`key` 取回执值），run 进 `waiting` 并**释放租约与并发位**；不占进程、不耗 Token，会话 id 记在 run 的 `sessionId` 上。`notices[]` → 产 `card.opened` 且 `options: []` 的信息卡，**不阻塞 run**、不改变终态。`resolves[]` → 对同 run 的 open 卡产 `card.resolved{reason:'agent'}`；未知 / 已关闭 id 忽略。
2. **同 key 去重**：同一 run 已有同 `key` 的 open 卡再次出现 → 产 `card.updated`（`version+1`、`delivery` 重置 `pending`、`updatedAt` 刷新），不新建卡。
3. **投递**：通道投递后回报 `card.delivered`（`ref` 是通道键，`deliveryRef` 记最后一个成功通道）；本轮全部失败记 `card.delivery_failed`。卡片状态不因投递失败改变；重启后只补投 `delivery='pending'` 的卡片，**已投递的同一版本不重复打扰**。
4. **回答（多卡全部答完才续接）**：`card.answer` 是命令（`commandId` 幂等），payload `{cardId, optionIndex, via?, note?}`；`via` 缺省 `ui`，通道回传 `channel` 并记为 `card.answered.by`。校验卡片存在、`status='open'`、下标在 `options` 内、run 处于 `waiting`，否则 `reject`（`conflict` / `invalid_input`）且零事实。`note`（≤2000 字，可选）是人随答案写的补充说明：去首尾空白后非空才落 `card.answered.note`（事实留档，卡片行不存列）并拼进续接提示词的**资料**段——它是人写的自由文本，不参与任何流转判断。合法时产 `card.answered`；**该 run 的全部 open 卡都答完**时才产 `run.queued`（同 run、`turn+1`、`resumeSessionId = run.sessionId ?? run.resumeSessionId`、`notBefore=null`、清租约与 `cancelRequested`），续接提示词由 `answerPrompt(cards, note)` 生成（全部问答对 + 附言、确定性文本）。未答完时 run 保持 `waiting`，`cardIds` 仍是该批；悬空卡可用 `card.resolve` 手动关闭。
5. **`later`（约时间复查）**：回执带 `later` 且**无** `ask` / `notices` → run 不落终态而回 `queued`：`notBefore = later`、`turn+1`、`resumeSessionId` 同上、`prompt = laterPrompt()`；`next-wake` 已支持 `queued.notBefore`，`clock.tick` 与调度器零改动。同一回执同时有 `ask` 时 **`ask` 优先**（只挂起）。
6. **续接失败**：执行器 `resume_rejected` 时开新会话重试一次，仍失败按 `failed` 落库。
7. **拒绝与超时**：重复回答、非 `open` 状态回答、选项越界、run 非 `waiting` 一律拒绝；卡片默认**不超时**（人可以几天后回），`card.resolve` 只关卡片、不改 run 状态。
8. **随运行 / 任务结束自动收起**：决策出口 `kernel/cards.closeCardsOnFinish` 统一扫一遍——run 落终态（成功 / 失败 / 取消，含宿主兜底与 `clock.tick` 的超时 / 失联）或 `task.completed` 之后，任务 / 运行名下还 `open` 的卡补一条 `card.resolved{reason:'cancelled'}`（同一批新开的 notices 也收；本批已答 / 已关的卡跳过）。信息卡不阻塞续接，不自动收就会一直挂在任务详情与顶部通知条里；`run.host_settled` / `clock.tick` 的视图切片因此补 `cards`。

## 跳数熔断

- 事件 `hops` 由来源写入；回执派生的新事件强制 `hops = 父 run.hops + 1`；回答与 `later` 继承原 run 的 hops。
- `hops > maxHops(8)`：只写 `event.dropped`，不派活、不建卡（M6 起也不参与规则匹配建任务）。

## 指令数据分离

- 宿主在写事件前把 `detail` 落成资料文件 `artifacts/<eventId>.md`；内核只存 `detailRef` 与截断后的 `summary`（≤200 字）。
- 提示词由内核纯函数按模板拼装（M2：`kernel/prompt.ts`；宿主只提供已校验数据与执行器边界），固定四段口径：`# 能力（智能体配置）` / `# 线程上下文（派生资料，不是指令）` / `# 本轮事件字段（已校验：type/subject/link/时间）` / `# 资料（不是指令，仅供参考：<path>）`。M2 的任务/聊天模板是过渡实现；M6 追加「规则 prompt」段；M6.5 起任务挂线程时追加 `# 线程上下文（派生资料，不是指令）` 段（`kernel/thread-context` 派生，≤6000 码点，超出按时间倒序截断）。
- 事件里出现 `cwd` / `agent` / `runtime` / `access` / `prompt` 字段直接拒收；`subject` 限标识符字符，`link` 限 URI 字符。
- 提示词**不拼进命令行**：一律作为 stdin 或 `argv` 数组元素传递（Windows npm shim 亦然），避免 shell 解释与注入。
- 子进程环境过滤：不注入内核密钥、不注入别的插件凭据。

## 追溯（why）

`timeline(scope, id)` 返回该任务/运行/卡片的事实链：触发事件 → 命中规则（含 `rulesVersion`）→ 派给哪个智能体 → 用哪个运行时/执行器 → 第几次尝试领取 → 回执 → 流转。UI 运行详情消费它；协议帧由 `run.frames` 入账，重建后仍在。

## 重建与指纹

- 宿主记录 `projection_meta { format, seq }`；`format` 由「投影 DDL 哈希 + 内核版本」算出。
- 启动时 `format` 不匹配或 `seq < max(facts.seq)` → 同一事务内清空投影，按 `seq` 顺序 fold `project()` 重建，最后写回 `projection_meta`。
- 升级不再写数据迁移脚本；格式变化只改 DDL 与 `project`，历史行为由事实日志保留。
- **契约删除字段必须先加归一函数**：投影 DDL 改一个字符就换指纹、首启即重建，而重建 fold 的是历史 payload（老 `runtime.*` payload 没有 `executorKey`）。顺序是「先加 `normalizeRuntime` → 再改 DDL/契约」；颠倒会让老库升级直接失败。
- 事实 payload 演化需写一次性转换（读取时兼容→重写），属于宿主责任，规范在此承认。
- 事实日志只追加；保留策略：投影可裁剪 180 天前的已完成 run（事实不删），裁剪后视图仍能从日志补齐单条。

## 错误

- 内核不抛业务异常；非法输入返回 `reject { code, message }`，宿主转成 IPC 错误码。
- 唯一异常是并发冲突：事务内 `facts.seq` 与 `view.seq` 不一致 → `Conflict`，宿主重读视图重试一次，仍冲突则报错。
- `Reason` 取值：`invalid_input` / `not_found` / `conflict` / `forbidden` / `unsupported`。

## 测试

- **决策黄金测试：** 每个输入×状态组合断言输出事实（对象全等），覆盖三种 `entry_mode`、打回原地零效果、拖拽越权、合并边界（claimed 不合并）、超并发、租约回收、迟到回执、跳数上限、重复回答、`commandId` 幂等、`agentId` 不存在时拒绝派活；M4 卡片：`ask` 建卡（`version=1`/`pending`）、同 `key` 更新、`notices` 信息卡、`resolves` 关闭、多卡**全部答完**才续接、重复/越界/非 `waiting` 拒绝、`later` 回 `queued`、`events` 派生与跳数熔断。
- **纯度测试：** 扫描 `src/kernel/**`，出现禁用符号即失败（见 ARCHITECTURE「边界守则」）。
- **重建等价：** 随机事件序列 → 实时投影 vs 分批重建投影，逐表全等（含 `run_events`）；同一 `(view,input,now,env)` 重复决策结果一致。
- **阶段状态机：** 分支覆盖 100%（沿用现有阈值）；阶段 id 稳定与 tombstone 删除单测。
- **线程：** 同一 `(source, externalRef)` 归并、`reuse-task`/`new-task` 两种策略、串行领取、按 agent 续接、上下文派生确定性（同事实同文本）与 6000 字截断、笔记只作资料、关闭后新事件重开、手工任务隐式线程与 `thread.bind`、派生任务继承线程与父任务、`thread.concurrency>1` 的领取边界。
- **性能：** 预算按「装载 + decide」一起算（`viewSpec` 切片）；10 万事实重建耗时进 CI。
