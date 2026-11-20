/**
 * 三动词契约（M5）：Web 客户端与服务端之间只剩三个动词。
 *
 * - `dispatch(command)`：唯一写入口，命令带 `commandId` 幂等；
 * - `query(view, params)`：唯一读入口，一次取一个视图切片；
 * - `subscribe(handler)`：变更推送（事实批次 + 聊天流旁路），只推「发生了什么」。
 *
 * 传输在服务器部署里是 HTTP + SSE（路由见 `protocol/http.ts`），但这一层的类型与
 * Electron 时期完全一致：换传输不该动契约。
 *
 * 事实以摘要形式回给客户端（`FactSummary`）：客户端只做失效，不消费 payload；
 * 命令结果里的新建/更新实体放在 `value`，避免组件再从事实里猜 id。
 */
import type { Command } from './commands'
import type {
  Agent,
  Card,
  Conversation,
  Project,
  RunEvent,
  Runtime,
  RuntimeProbe,
  Task,
  WorkflowWithStages,
} from './entities'
import type { FactType } from './facts'
import type { RuleSetView } from './rules'
import type { PluginSettingsView, PluginView } from './plugins'
import type { TaskComment } from './task-comment'

/** 提交后回给 renderer 的事实摘要（不带 payload；顺序即 seq 顺序）。 */
export interface FactSummary {
  seq: number
  type: FactType
  at: string
}

/** 命令结果：本次提交的事实 + 命令对应的实体值（无实体时为 null）。 */
export interface DispatchResult<T = unknown> {
  facts: FactSummary[]
  value: T | null
}

/**
 * 命令 → `value` 类型。只有「创建 / 更新 / 回答 / 探测」这类调用方会用到返回值的命令
 * 有实体；删除类与批量动作为 `null`。
 */
export interface CommandResults {
  'workflow.create': WorkflowWithStages
  'workflow.update': WorkflowWithStages
  'workflow.remove': null
  'agent.create': Agent
  'agent.update': Agent
  'agent.remove': null
  'runtime.create': Runtime
  'runtime.update': Runtime
  'runtime.remove': null
  'runtime.probe': RuntimeProbe
  'runtime.probed': RuntimeProbe
  /** M10：新建 / 更新项目后返回整行（UI 用来选中新项目） */
  'project.create': Project
  'project.update': Project
  'project.remove': null
  'task.create': Task
  'task.move': Task
  'task.complete': Task
  'task.stop': null
  'task.remove': null
  /** M7.5：返回追加后的评论行（UI 仍重取 `comments.byTask`） */
  'task.comment': TaskComment
  /** 失败重跑只产一条 `run.queued`；任务行不动，返回值由 UI 重取视图 */
  'task.rerun': null
  /** 闸门补回执：同样只产一条 `run.queued`，返回值由 UI 重取视图 */
  'task.reask': null
  'card.answer': Card
  'card.resolve': Card
  'chat.create': Conversation
  'chat.send': null
  'chat.remove': null
  'chat.cancel': null
  'chat.archive': null
  'app.event': null
  /** M6：整批替换后的规则集（版本 + 规则清单） */
  'rules.replace': RuleSetView
  /** M6：立即运行一条规则后新建的任务 */
  'rule.trigger': Task
  /** M42：补跑结果（补了几条、建了几个任务），零事实命令由宿主回填 */
  'rule.replay': { replayed: number; created: number }
  /** M7：整批替换后的插件设置快照 */
  'plugins.replace': PluginSettingsView
  /** M7：改一条插件设置后该插件的视图行（含状态与 config；secret 只回键名） */
  'plugin.set': PluginView
  /** M6.5：线程命令只改线程行，返回值由 UI 重取视图 */
  /** M47：开话题的 id 由调用方从 `thread.opened` 事实里取，不走返回值 */
  'thread.open': null
  'thread.note': null
  'thread.close': null
  'thread.bind': null
  /** M17：删除线程（连带任务与执行记录），返回值由 UI 出栈后重取视图 */
  'thread.remove': null
  /** M14：提升为文档后返回落盘路径（`<项目>/docs/reviews/<文件名>`） */
  'review.export': { path: string }
}

export type CommandValue<T extends Command['type']> = CommandResults[T]

/** 某条命令的 dispatch 返回值类型（按 `type` 判别）。 */
export type CommandDispatchResult<C extends Command> = DispatchResult<CommandValue<C['type']>>

/** 事实批次：`seq` = 批内最后一条事实的 seq，`types` 去重（renderer 按它失效视图）。 */
export interface FactsEvent {
  kind: 'facts'
  seq: number
  types: FactType[]
}

/** 聊天流旁路：实时显示用，事实仍是数据源；`conversationId` 供 UI 过滤当前会话。 */
export interface StreamEvent {
  kind: 'stream'
  runId: string
  conversationId: string | null
  event: RunEvent
}

export interface StreamEndEvent {
  kind: 'stream-end'
  runId: string
  conversationId: string | null
}

/** main → renderer 的推送（subscribe 动词的唯一载荷）。 */
export type KernelEvent = FactsEvent | StreamEvent | StreamEndEvent

/**
 * 应用内深链（知会与顶部通知条共用）：点一条知会把人送到「哪张卡 / 哪个任务 / 哪个会话」。
 *
 * 只描述落点，不描述动作：怎么打开由渲染层决定（`appId` 与 `AppPlugin.id` 同名）。
 * `cardId` 有值时渲染层要**滚到那张卡并高亮**——这正是「点了通知却还要自己翻找」的修法。
 */
export interface OpenTarget {
  /** 目标 app id（渲染层注册表里的 `AppPlugin.id`） */
  appId: string
  /** 卡片 id：定位并高亮这一张（没有则只进任务 / 会话） */
  cardId?: string
  taskId?: string
  conversationId?: string
}

/**
 * 通知调用方给的落点：**不含 `appId`**。
 *
 * 知会只落到发通知的那个 app（当前唯一会发通知的是 AI 工作流），所以 app 身份由装配根
 * 统一补一次；host 与插件因此不必知道产品名，也不需要互相同步 app id。
 */
export type NotifyTarget = Omit<OpenTarget, 'appId'>

/** 错误载荷（只传 code + message；前端按 message 展示，按 code 分支）。 */
export interface IpcError {
  code: string
  message: string
}

/** 应答信封：成功带 value，失败带可读错误（不把异常栈发给浏览器）。 */
export type IpcResponse<T> = { ok: true; value: T } | { ok: false; error: IpcError }

/**
 * 传输层入口在 `protocol/http.ts`（`API_PATHS`）：服务器形态下不再有 IPC 通道名。
 *
 * 这里只保留跨层共用的数据结构，它们与传输无关：
 * - `IpcResponse`：应答信封（HTTP 与单测都按它判成败）；
 * - `OpenTarget` / `NotifyTarget`：知会与深链的落点；
 * - 飞书连接管理的载荷形状（`/api/lark`）。
 */

/**
 * 飞书连接管理的载荷形状（M45）：设置页 ↔ 主进程。
 *
 * 安全口径：
 * - app secret 只在 `add-profile` 动作里单向传入，**不经任何返回值 / 日志 / 视图回传**；
 * - 返回值只有 profile 名、appId、身份与状态这类「可以给人看」的字段。
 */

/** 一条 lark-cli profile 的可见信息（不含 secret）。 */
export interface LarkProfileView {
  name: string
  appId: string
  brand: string
  active: boolean
  user: string | null
  tokenStatus: string | null
}

/** 探测结果：工作台会用哪套凭据、本机还有哪些 profile、是否和别的 agent 撞车。 */
export interface LarkStatusView {
  ok: boolean
  /** 解析到的 lark-cli 可执行文件（找不到为 null） */
  program: string | null
  /** 探测失败原因（`ok=false` 时给） */
  error: string | null
  /** 本程序（剔除别的 agent 变量后）落到的 CLI 工作区 */
  workspace: string | null
  /** 本程序实际用的应用 appId */
  appId: string | null
  /** bot / user 身份与可用性 */
  identity: string | null
  available: boolean
  tokenStatus: string | null
  /** 本机全部 profile（同一工作区） */
  profiles: LarkProfileView[]
  /** 宿主环境里别的 agent 绑定的工作区与应用（没有就是 null） */
  foreign: { workspace: string | null; appId: string | null } | null
  /** 本程序目前用的 appId 与别的 agent 相同：两边会抢同一个应用的事件长连接 */
  conflict: boolean
  /** 给人看的一句话建议（没有为 null） */
  hint: string | null
}

/** 登录启动结果：`verificationUrl` 要原样展示（二维码也由调用方据此生成）。 */
export interface LarkLoginStart {
  ok: boolean
  verificationUrl?: string
  deviceCode?: string
  expiresIn?: number
  error?: string
}

/** 不带数据的动作结果。 */
export interface LarkActionResult {
  ok: boolean
  error?: string
}

/** 设置页能发起的动作（一次一个，参数都来自本机表单）。 */
export type LarkAdminAction =
  | { action: 'status' }
  | {
      action: 'add-profile'
      name: string
      appId: string
      secret: string
      brand?: string
    }
  | { action: 'login-start'; profile?: string; domain?: string }
  | { action: 'login-poll'; profile?: string; deviceCode: string }
  | { action: 'logout'; profile?: string }
  /** 删掉本机的 profile（连带它的 app secret 与登录 token，不可撤销） */
  | { action: 'remove-profile'; name: string }

/** 动作 → 返回值。 */
export interface LarkAdminResults {
  status: LarkStatusView
  'add-profile': LarkActionResult
  'login-start': LarkLoginStart
  'login-poll': LarkActionResult
  logout: LarkActionResult
  'remove-profile': LarkActionResult
}

export type LarkAdminResult<A extends LarkAdminAction> = LarkAdminResults[A['action']]
