/**
 * 唯一决策入口：命令 + 视图切片 → 事实草稿（或 `reject`）。
 *
 * 纯函数：不读时钟/随机数/文件/DB——`now`、id 生成器、视图切片都由宿主在边界注入。
 * 非法输入一律返回 `reject { code, message }`，不抛异常。
 *
 * R2：命令处理按域拆到 `kernel/commands/**`，本文件只保留类型分派与公共契约；
 * 每个 handler 仍是纯函数，行为与拆分前一致。
 */
import type { Input } from '../protocol/inputs'
import type { Decision, Environment, Iso, View } from './types'
import * as agent from './commands/agent'
import * as automation from './commands/automation'
import * as card from './commands/card'
import * as chat from './commands/chat'
import * as runtime from './commands/runtime'
import * as run from './commands/run'
import * as task from './commands/task'
import * as thread from './commands/thread'
import * as workflow from './commands/workflow'

export function decide(view: View, input: Input, now: Iso, env: Environment): Decision {
  switch (input.type) {
    // ---------- 运行时 ----------
    case 'runtime.create':
      return runtime.createRuntime(view, input, now, env)
    case 'runtime.update':
      return runtime.updateRuntime(view, input, now)
    case 'runtime.probe':
      return runtime.probeRuntimeUnsupported()
    case 'runtime.probed':
      return runtime.probedRuntime(view, input, now)
    case 'runtime.remove':
      return runtime.removeRuntime(view, input, now)

    // ---------- 项目（M10） ----------
    case 'project.create':
      return runtime.createProject(view, input, now, env)
    case 'project.update':
      return runtime.updateProject(view, input, now)
    case 'project.remove':
      return runtime.removeProject(view, input, now)

    // ---------- 智能体 ----------
    case 'agent.create':
      return agent.createAgent(view, input, now, env)
    case 'agent.update':
      return agent.updateAgent(view, input, now)
    case 'agent.remove':
      return agent.removeAgent(view, input, now)

    // ---------- 工作流 ----------
    case 'workflow.create':
      return workflow.createWorkflow(view, input, now, env)
    case 'workflow.update':
      return workflow.updateWorkflow(view, input, now, env)
    case 'workflow.remove':
      return workflow.removeWorkflow(view, input, now)

    // ---------- 任务 ----------
    case 'task.create':
      return task.createTask(view, input, now, env)
    case 'task.move':
      return task.moveTaskCommand(view, input, now, env)
    case 'task.complete':
      return task.completeTaskCommand(view, input, now, env)
    case 'task.remove':
      return task.removeTask(view, input, now, env)
    case 'task.comment':
      return task.commentTask(view, input, now, env)

    // ---------- 卡片（M4 审批） ----------
    case 'card.answer':
      return card.answerCard(view, input, now, env)
    case 'card.resolve':
      return card.resolveCard(view, input, now)
    case 'card.delivered':
      return card.deliveredCard(view, input, now)
    case 'card.delivery_failed':
      return card.failedCardDelivery(view, input, now)

    // ---------- 运行（宿主内部输入） ----------
    case 'run.claim':
      return run.claimRun(view, input, now, env)
    case 'run.heartbeat':
      return run.heartbeatRun(view, input, now, env)
    case 'run.frames':
      return run.recordRunFrames(view, input, now)
    case 'run.receipt':
      return run.receiveRun(view, input, now, env)
    case 'run.cancel':
      return run.cancelRun(view, input, now)
    case 'run.host_settled':
      return run.settleRunByHost(view, input, now, env)
    case 'clock.tick':
      return run.tickClock(view, now, env)

    // ---------- 对话（聊天并入 purpose='chat' 的统一执行路径） ----------
    case 'chat.create':
      return chat.createConversation(view, input, now, env)
    case 'chat.send':
      return chat.sendChat(view, input, now, env)
    case 'chat.remove':
      return chat.removeConversation(view, input, now)
    case 'chat.cancel':
      return chat.cancelChat(view, input, now)
    case 'chat.archive':
      return chat.archiveChat(view, input, now)

    // ---------- 外部事件 / 自动化规则 / 插件设置 ----------
    case 'app.event':
      return automation.receiveAppEvent(view, input, now, env)
    case 'event.received':
      return automation.receiveExternalEvent(view, input, now, env)
    case 'rules.replace':
      return automation.replaceRules(view, input, now)
    case 'rule.trigger':
      return automation.triggerRule(view, input, now, env)
    case 'plugins.replace':
      return automation.replacePluginSettings(view, input, now)
    case 'plugin.set':
      return automation.setPluginUnsupported()

    // ---------- 线程（M6.5） ----------
    case 'thread.note':
      return thread.noteThread(view, input, now, env)
    case 'thread.close':
      return thread.closeThread(view, input, now)
    case 'thread.bind':
      return thread.bindThread(view, input, now)
  }
}
