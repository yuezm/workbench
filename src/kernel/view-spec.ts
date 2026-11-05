/**
 * 输入 → 需要装载的投影切片。
 *
 * 宿主按这张表装 `View`，内核不查库、也不要求全量装载；M2 起输入是
 * `Command | HostInput`（`protocol/inputs`），命令的切片与 M1 保持一致，
 * 运行/对话输入只声明自己真正需要的那几张表。
 *
 * 约定：返回 `tasks` 的输入同时要装 `View.activeTaskIds`（宿主按 `runs` 现算的
 * queued/running/waiting 任务集合），「执行中」只认它。
 */
import type { Input } from '../protocol/inputs'
import type { ProjectionTable } from './types'

export function viewSpec(input: Input): ProjectionTable[] {
  switch (input.type) {
    case 'workflow.create':
      // 阶段绑定的智能体必须存在（旧实现靠外键，M1 由内核校验）
      return ['agents']
    case 'workflow.update':
      // 改阶段：既有阶段做差量、任务的当前阶段可能因删阶段而重挂、活跃 run 守卫
      return ['workflows', 'workflow_stages', 'agents', 'tasks']
    case 'workflow.remove':
      // 级联删阶段、任务与运行；run 要先逐条产 run.removed（D13），不能靠 SQL 级联
      return ['workflows', 'workflow_stages', 'tasks', 'runs']
    case 'agent.create':
      return ['runtimes']
    case 'agent.update':
      return ['agents', 'runtimes']
    case 'agent.remove':
      // 被阶段引用时拒绝删除
      return ['agents', 'workflow_stages']
    case 'runtime.create':
    case 'runtime.update':
      // 名称唯一（含改名时与其它运行时比较）
      return ['runtimes']
    case 'runtime.remove':
      // 被智能体引用时拒绝删除
      return ['runtimes', 'agents']
    case 'runtime.probed':
      return ['runtimes']
    case 'task.create':
      // 进入效果要判定落点是否 agent 入口并拼提示词 → 需要智能体与运行时配置
      return ['workflows', 'workflow_stages', 'agents', 'runtimes']
    case 'task.move':
    case 'task.complete':
      return ['tasks', 'workflows', 'workflow_stages', 'agents', 'runtimes']
    case 'task.remove':
      // 删除任务前要对其 run 逐条产 run.removed（D13），重建才与增量等价
      return ['tasks', 'runs']
    case 'card.answer':
      // 校验卡片 open / 下标合法（cards）、run 仍 waiting（runs）；续接读同 run 的其余 open 卡（cards）
      return ['runs', 'cards']
    case 'card.resolve':
      // 只改卡片状态；run 状态不动
      return ['cards']
    case 'run.claim':
      // 候选 run 来自 runs 投影；运行时配置（启用 / 并发上限）来自 runtimes
      return ['runs', 'runtimes']
    case 'run.heartbeat':
      // 只校验租约是否匹配，不改其它表
      return ['runs']
    case 'run.frames':
      // 帧入账要确认 run 仍在执行且轮次匹配；帧本身只写 run_events
      return ['runs']
    case 'run.receipt':
      // 终态写 runs；回执带 ask/notices/resolves 时要按 cards 现算建卡/更新/关闭；
      // 阶段 run 还要判定阶段流转与下一轮进入效果（任务 / 阶段 / 智能体 / 运行时）；
      // 聊天 run 终态要把续接会话 id 落回对话
      return [
        'runs',
        'tasks',
        'workflows',
        'workflow_stages',
        'agents',
        'runtimes',
        'conversations',
        'cards',
      ]
    case 'run.host_settled':
      // 兜底终态；聊天 run 还要补一条 assistant 消息（读对话判断是否已删）
      return ['runs', 'conversations']
    case 'run.cancel':
      return ['runs']
    case 'clock.tick':
      // M2 只处理运行到期（租约 / 退避 / 超时）；cron 与卡片超时后续里程碑再补
      return ['runs']
    case 'chat.create':
      // 对话绑定的智能体必须存在（M5 命令化后沿用原 conversation.create 语义）
      return ['agents']
    case 'chat.send':
      // 同一对话同时只跑一轮（runs）+ 智能体/运行时决定 execution 配置
      return ['conversations', 'messages', 'runs', 'agents', 'runtimes']
    case 'chat.remove':
      // 消息随对话一并删除，删除前要能解释历史
      return ['conversations', 'messages']
    case 'chat.cancel':
      // 按对话取活跃 run 逐条产取消请求
      return ['conversations', 'runs']
    case 'app.event':
      // app 事件只入账，不读任何投影
      return []
    case 'card.delivered':
    case 'card.delivery_failed':
      // 投递回写只读卡片当前行（校验版本 / 幂等：迟到与重复投递零事实）
      return ['cards']
  }
}
