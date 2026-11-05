/**
 * 命令契约：配置三组（workflow / agent / runtime）+ 任务四动作（M1）+ 卡片两条（M4）。
 *
 * 命令是宿主入口的输入（renderer → dispatch），不是 IPC 方法名本身：
 * 带 `commandId` 做幂等，形状由 `protocol/validate` 在写入前校验。
 * run / chat / rules / clock 等输入 M2 之后再迁入；`card.answer` 来自 owner（ui 或通道），
 * `card.resolve` 只来自 owner。
 */
import type {
  AgentInput,
  CardAnswerVia,
  RuntimeInput,
  RuntimeProbe,
  TaskInput,
  WorkflowInput,
} from './entities'
import type { AutomationRule } from './rules'
import type { PluginSetCommandPayload, PluginSetting } from './plugins'

/**
 * 命令名全集；决定面见 tasks/m1-plan.md「决策面」、m4-plan「架构决议 D6」
 * 与 m5-plan「架构决议 D5/D6」。
 *
 * M5：聊天四个动作从宿主输入升为命令（带 `commandId` 幂等），命名与 UI 一致；
 * `app.event` 是 app 插件的事件出口（白名单在 `src/shared/apps.ts`）。
 */
export const COMMAND_NAMES = [
  'workflow.create',
  'workflow.update',
  'workflow.remove',
  'agent.create',
  'agent.update',
  'agent.remove',
  'runtime.create',
  'runtime.update',
  'runtime.remove',
  'runtime.probe',
  'runtime.probed',
  'task.create',
  'task.move',
  'task.complete',
  'task.remove',
  'card.answer',
  'card.resolve',
  'chat.create',
  'chat.send',
  'chat.remove',
  'chat.cancel',
  'app.event',
  'rules.replace',
  'rule.trigger',
  'plugins.replace',
  'plugin.set',
  'thread.note',
  'thread.close',
  'thread.bind',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

interface CommandBase {
  /** 幂等键：重复提交返回原结果，不重复产事实 */
  commandId: string
}

// ---------- 工作流 ----------

export interface WorkflowCreateCommand extends CommandBase {
  type: 'workflow.create'
  input: WorkflowInput
}

export interface WorkflowUpdateCommand extends CommandBase {
  type: 'workflow.update'
  id: string
  /** 整份定义：阶段 id 稳定，按 id 差异发 stage.created / updated / deleted */
  input: WorkflowInput
}

export interface WorkflowRemoveCommand extends CommandBase {
  type: 'workflow.remove'
  id: string
}

// ---------- 智能体 ----------

export interface AgentCreateCommand extends CommandBase {
  type: 'agent.create'
  input: AgentInput
}

export interface AgentUpdateCommand extends CommandBase {
  type: 'agent.update'
  id: string
  patch: Partial<AgentInput>
}

export interface AgentRemoveCommand extends CommandBase {
  type: 'agent.remove'
  id: string
}

// ---------- 运行时 ----------

export interface RuntimeCreateCommand extends CommandBase {
  type: 'runtime.create'
  input: RuntimeInput
}

export interface RuntimeUpdateCommand extends CommandBase {
  type: 'runtime.update'
  id: string
  patch: Partial<RuntimeInput>
}

export interface RuntimeRemoveCommand extends CommandBase {
  type: 'runtime.remove'
  id: string
}

/**
 * 探测一次运行时（M5 D3 编排命令）：只传 id，宿主用执行器端口探测 → 落 `runtime.probed`
 * 事实 → 返回探测结论。前端不再自己拼 `probe` 载荷（也不可信）。
 */
export interface RuntimeProbeCommand extends CommandBase {
  type: 'runtime.probe'
  id: string
}

/** 探测结论单独入账（配置事实不携带探测结论） */
export interface RuntimeProbedCommand extends CommandBase {
  type: 'runtime.probed'
  id: string
  probe: RuntimeProbe
}

// ---------- 任务 ----------

export interface TaskCreateCommand extends CommandBase {
  type: 'task.create'
  input: TaskInput
}

export interface TaskMoveCommand extends CommandBase {
  type: 'task.move'
  id: string
  /** 人工拖拽落点即目标，不套用 on_complete / on_reject */
  stageId: string
}

export interface TaskCompleteCommand extends CommandBase {
  type: 'task.complete'
  id: string
}

export interface TaskRemoveCommand extends CommandBase {
  type: 'task.remove'
  id: string
}

// ---------- 卡片 ----------

/**
 * 回答一张 open 卡（M4）：宿主入口 / 通道插件提交，内核校验卡片存在、`status='open'`、
 * 选项下标合法、run 处于 `waiting`；重复/越界/已关闭一律 reject。
 * `via` 缺省 `ui`；通道回传时写 `channel`，记为 `card.answered.by`。
 */
export interface CardAnswerCommand extends CommandBase {
  type: 'card.answer'
  cardId: string
  /** 选项下标（0 基，须在卡片 `options` 范围内） */
  optionIndex: number
  via?: CardAnswerVia
}

/** 手动关闭一张卡片（悬空卡兜底）；不改变 run 状态。 */
export interface CardResolveCommand extends CommandBase {
  type: 'card.resolve'
  cardId: string
}

// ---------- 聊天（M5：从宿主输入升为命令） ----------

/** 新建一轮主动对话；`agentId` 必须存在（内核校验）。 */
export interface ChatCreateCommand extends CommandBase {
  type: 'chat.create'
  agentId: string
  /** 首条消息可顺带给标题；缺省用「新对话」 */
  title?: string
}

/** 发一轮：先落用户消息再入队 `purpose='chat'` 的 run；被拒绝时不落消息。 */
export interface ChatSendCommand extends CommandBase {
  type: 'chat.send'
  conversationId: string
  content: string
}

/** 删除对话（消息级联删除；活跃 run 由宿主路由先行取消）。 */
export interface ChatRemoveCommand extends CommandBase {
  type: 'chat.remove'
  conversationId: string
}

/** 中止该对话进行中的一轮：内核按活跃 run 逐条产 `run.cancel_requested`。 */
export interface ChatCancelCommand extends CommandBase {
  type: 'chat.cancel'
  conversationId: string
}

// ---------- app 事件（M5） ----------

/**
 * app 插件发出的事件（如番茄结束）：宿主先按 `src/shared/apps.ts` 的
 * `APP_EVENTS` 白名单校验 `appId` 与 `eventType`，内核产一条 `event.received`
 * （`source='app'`、`hops=1`、`originRunId=null`）。M6 才消费事件建任务。
 */
export interface AppEventCommand extends CommandBase {
  type: 'app.event'
  /** app 插件 id（kebab-case），必须在白名单内 */
  appId: string
  /** 事件类型，如 pomodoro.completed；必须在白名单内 */
  eventType: string
  /** 事项标识（用于合并/去重） */
  subject: string
  /** 摘要（内核截断到 200 字） */
  summary?: string
  /** 全文（宿主只入账；不拼进提示词） */
  detail?: string
  /** 关联链接（只入库，不打开） */
  link?: string
  /** 稳定去重键（M6 规则用） */
  dedupeKey?: string
}

/** 全部命令的判别联合（`type` 是命令名）。 */
export type Command =
  | WorkflowCreateCommand
  | WorkflowUpdateCommand
  | WorkflowRemoveCommand
  | AgentCreateCommand
  | AgentUpdateCommand
  | AgentRemoveCommand
  | RuntimeCreateCommand
  | RuntimeUpdateCommand
  | RuntimeRemoveCommand
  | RuntimeProbeCommand
  | RuntimeProbedCommand
  | TaskCreateCommand
  | TaskMoveCommand
  | TaskCompleteCommand
  | TaskRemoveCommand
  | CardAnswerCommand
  | CardResolveCommand
  | ChatCreateCommand
  | ChatSendCommand
  | ChatRemoveCommand
  | ChatCancelCommand
  | AppEventCommand
  | RulesReplaceCommand
  | RuleTriggerCommand
  | PluginsReplaceCommand
  | PluginSetCommand
  | ThreadNoteCommand
  | ThreadCloseCommand
  | ThreadBindCommand

// ---------- 自动化规则（M6） ----------

/**
 * 整批替换规则集：`rules` 是替换后的完整清单，版本由内核 +1（前端不传版本）。
 * 任一条非法 → 整批 reject，旧版继续生效；合法则产一条 `rules.replaced`。
 */
export interface RulesReplaceCommand extends CommandBase {
  type: 'rules.replace'
  rules: AutomationRule[]
}

/**
 * 手动立即运行一条规则（规则页「立即运行」）：直接按规则建一条任务
 * （不依赖事件、`externalRef=null`、title=规则名），不产 `rule.fired`
 * （那是 cron 到点记录；手工触发由 `task.created.ruleId` 追溯）。
 * 规则不存在 / 停用 → reject。
 */
export interface RuleTriggerCommand extends CommandBase {
  type: 'rule.trigger'
  ruleId: string
}

// ---------- 插件设置（M7） ----------

/**
 * 整批替换插件设置：`settings` 是替换后的完整快照，版本由内核 +1（前端不传版本）。
 * 任一条非法 → 整批 reject，旧版继续生效；合法则产一条 `plugins.replaced`。
 * secret 不在本命令里：`plugin.set` 的 `secrets` 由宿主写非投影表，不进事实。
 */
export interface PluginsReplaceCommand extends CommandBase {
  type: 'plugins.replace'
  settings: PluginSetting[]
}

/**
 * 改一条插件设置（设置页唯一入口）：宿主命令路由读当前快照、合并 patch 后转
 * `plugins.replace`（沿用本命令的 `commandId`），并把 `secrets` 写宿主 secret 表。
 * 插件是否存在于磁盘不在这里判断（内核不认识插件目录）；未知 id 由宿主视图过滤展示。
 */
export interface PluginSetCommand extends CommandBase, PluginSetCommandPayload {
  type: 'plugin.set'
}

// ---------- 线程（M6.5） ----------

/** 给线程追加一条笔记（owner 补录；agent 笔记只能经回执 `notes[]`）。 */
export interface ThreadNoteCommand extends CommandBase {
  type: 'thread.note'
  threadId: string
  /** ≤2000 字；正文只作资料，不进指令段 */
  text: string
}

/** 人工归档线程（只改 `status`，不影响任务/运行；新事件到达会自动重开）。 */
export interface ThreadCloseCommand extends CommandBase {
  type: 'thread.close'
  threadId: string
}

/**
 * 把隐式线程绑定到外部入口 `(source, externalRef)`：之后同入口的事件续进该线程。
 * 目标键已被别的线程占用时 reject（身份唯一）。
 */
export interface ThreadBindCommand extends CommandBase {
  type: 'thread.bind'
  threadId: string
  source: string
  externalRef: string
}
