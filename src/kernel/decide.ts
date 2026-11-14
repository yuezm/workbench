/**
 * 唯一决策入口：命令 + 视图切片 → 事实草稿（或 `reject`）。
 *
 * 纯函数：不读时钟/随机数/文件/DB——`now`、id 生成器、视图切片都由宿主在边界注入。
 * 非法输入一律返回 `reject { code, message }`，不抛异常。
 *
 * M37：分派是**表**不是 switch。表用 `satisfies` 逐键校验 handler 签名（哪个命令的输入
 * 类型对不上，编译期就报在那一行），少一条多一条也报错；分派本身上下只有一次转型（键是
 * 联合类型，查表后 TS 不能自动收窄到对应成员）。业务分支一律在 `scopes/commands/*`。
 */
import type { Input } from '../protocol/inputs'
import type { Decision, Environment, Iso, View } from './core/types'
import * as agent from './scopes/commands/agent'
import * as automation from './scopes/commands/automation'
import * as card from './scopes/commands/card'
import * as chat from './scopes/commands/chat'
import * as runtime from './scopes/commands/runtime'
import * as run from './scopes/commands/run'
import * as review from './scopes/commands/review'
import * as task from './scopes/commands/task'
import * as thread from './scopes/commands/thread'
import * as workflow from './scopes/commands/workflow'
import { closeCardsOnFinish } from './scopes/cards'

/** 某个命令的 handler 签名：输入被收窄成该命令自己的形状。 */
type HandlerOf<T extends Input['type']> = (
  view: View,
  input: Extract<Input, { type: T }>,
  now: Iso,
  env: Environment,
) => Decision

/** 命令 → handler。少一条、多一条、签名对不上都会在编译期报错。 */
const HANDLERS = {
  'runtime.create': runtime.createRuntime,
  'runtime.update': runtime.updateRuntime,
  'runtime.probe': runtime.probeRuntimeUnsupported,
  'runtime.probed': runtime.probedRuntime,
  'runtime.remove': runtime.removeRuntime,
  'project.create': runtime.createProject,
  'project.update': runtime.updateProject,
  'project.remove': runtime.removeProject,
  'agent.create': agent.createAgent,
  'agent.update': agent.updateAgent,
  'agent.remove': agent.removeAgent,
  'workflow.create': workflow.createWorkflow,
  'workflow.update': workflow.updateWorkflow,
  'workflow.remove': workflow.removeWorkflow,
  'task.create': task.createTask,
  'task.move': task.moveTaskCommand,
  'task.complete': task.completeTaskCommand,
  'task.stop': task.stopTask,
  'task.remove': task.removeTask,
  'task.comment': task.commentTask,
  'task.rerun': task.rerunTask,
  'card.answer': card.answerCard,
  'card.resolve': card.resolveCard,
  'card.delivered': card.deliveredCard,
  'card.delivery_failed': card.failedCardDelivery,
  'run.claim': run.claimRun,
  'run.heartbeat': run.heartbeatRun,
  'run.frames': run.recordRunFrames,
  'run.receipt': run.receiveRun,
  'run.cancel': run.cancelRun,
  'run.host_settled': run.settleRunByHost,
  // clock.tick 的 handler 不收 input（时钟没有命令载荷）：补一个忽略位保持表形状统一
  'clock.tick': (_view, _input, now, env) => run.tickClock(_view, now, env),
  'chat.create': chat.createConversation,
  'chat.send': chat.sendChat,
  'chat.remove': chat.removeConversation,
  'chat.cancel': chat.cancelChat,
  'chat.archive': chat.archiveChat,
  'app.event': automation.receiveAppEvent,
  'event.received': automation.receiveExternalEvent,
  'rules.replace': automation.replaceRules,
  'rule.trigger': automation.triggerRule,
  'rule.replay': automation.replayRuleCommand,
  'plugins.replace': automation.replacePluginSettings,
  'plugin.set': automation.setPluginUnsupported,
  'thread.note': thread.noteThread,
  'thread.close': thread.closeThread,
  'thread.remove': thread.removeThread,
  'thread.bind': thread.bindThread,
  'review.export': review.exportReview,
} satisfies { [T in Input['type']]: HandlerOf<T> }

/**
 * 决策出口：命令分派之后统一收起「随运行/任务结束该消失」的卡片（见 closeCardsOnFinish）。
 * 放在这里而不是每个 handler 里，是为了覆盖回执、宿主兜底、取消、任务完成等所有路径。
 */
export function decide(view: View, input: Input, now: Iso, env: Environment): Decision {
  const handler = HANDLERS[input.type] as HandlerOf<typeof input.type>
  return closeCardsOnFinish(view, handler(view, input, now, env), now)
}
