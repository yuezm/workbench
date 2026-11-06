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
      // 阶段绑定的智能体必须存在（旧实现靠外键，M1 由内核校验）；
      // M7：阶段的交接目标工作流 / 目标阶段也要校验存在与从属
      return ['agents', 'workflows', 'workflow_stages']
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
    case 'runtime.probe':
      // 编排命令：宿主探测后落 runtime.probed；探测前不读投影（保留切片便于直接 dispatch 时的校验）
      return ['runtimes']
    case 'runtime.probed':
      return ['runtimes']
    case 'task.create':
      // 进入效果要判定落点是否 agent 入口并拼提示词 → 需要智能体与运行时配置；
      // M6.5：隐式线程在决策里本地构造（不读 threads），首轮无续接、无线程上下文历史
      // M7.5：提示词要带任务上下文 / 反馈（新任务还没有评论，仍按切片装载）
      return ['workflows', 'workflow_stages', 'agents', 'runtimes', 'task_comments']
    case 'task.move':
      // 进入效果（每次进入都重新建 run）要拼线程上下文与按线程续接会话
      return [
        'tasks',
        'workflows',
        'workflow_stages',
        'agents',
        'runtimes',
        'threads',
        'runs',
        'cards',
        'task_comments',
      ]
    case 'task.complete':
      // 完成后若线程内无 active 任务 → thread.closed{all-tasks-done}；交接产出的新任务
      // 首轮提示词要带上下文（新任务没有评论，按切片装载）
      return [
        'tasks',
        'workflows',
        'workflow_stages',
        'agents',
        'runtimes',
        'threads',
        'task_comments',
      ]
    case 'task.remove':
      // 删除任务前要对其 run 逐条产 run.removed（D13），重建才与增量等价；
      // M6.5：删除后同样判定线程是否可归档（任务上下文由投影层按 task_id 联删）
      return ['tasks', 'runs', 'threads']
    case 'task.comment':
      // M7.5：追加一条上下文 / 反馈；rerun 时复用进入阶段效果（拼反馈段 + 线程上下文、
      // 按线程续接会话、判定是否已有活跃 run）
      return [
        'tasks',
        'workflows',
        'workflow_stages',
        'agents',
        'runtimes',
        'threads',
        'runs',
        'cards',
        'task_comments',
      ]
    case 'card.answer':
      // 校验卡片 open / 下标合法（cards）、run 仍 waiting（runs）；续接读同 run 的其余 open 卡（cards）
      return ['runs', 'cards']
    case 'card.resolve':
      // 只改卡片状态；run 状态不动
      return ['cards']
    case 'run.claim':
      // 候选 run 来自 runs 投影；运行时配置（启用 / 并发上限）来自 runtimes；
      // M6.5：同一线程的并发闸门要读 threads（concurrency 默认 1）
      return ['runs', 'runtimes', 'threads']
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
        // M6：回执 events[] 派生的 event.received 也要命中规则建任务
        'rule_sets',
        // M6.5：派生事件按父 run 归线程/父任务；回执 notes[] 写线程；完成后归档线程
        'threads',
        // M7.5：流转到下一阶段时提示词带任务上下文 / 反馈
        'task_comments',
      ]
    case 'run.host_settled':
      // 兜底终态；聊天 run 还要补一条 assistant 消息（读对话判断是否已删）
      return ['runs', 'conversations']
    case 'run.cancel':
      return ['runs']
    case 'clock.tick':
      // M6：除运行到期外，还要为 cron 规则到点建任务（读规则集与触发基线，
      // 建任务要工作流/阶段/智能体/运行时与既有任务做 externalRef 去重）；
      // M6.5：14 天无活动的 open 线程归档（读 threads）
      return [
        'runs',
        'rule_sets',
        'rule_fires',
        'tasks',
        'workflows',
        'workflow_stages',
        'agents',
        'runtimes',
        'threads',
        // M7.5：cron 规则建的任务首轮提示词要带上下文（新任务没有评论，按切片装载）
        'task_comments',
      ]
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
    case 'event.received':
      // M6：事件命中规则建任务；M6.5：归并到 (source, externalRef) 线程、复用任务、
      // 合并 queued run，并为新 run 拼线程上下文（读 threads / runs / cards）
      return [
        'rule_sets',
        'tasks',
        'workflows',
        'workflow_stages',
        'agents',
        'runtimes',
        'threads',
        'runs',
        'cards',
        // M7.5：复用任务追加一轮时提示词带任务上下文 / 反馈
        'task_comments',
      ]
    case 'rules.replace':
      // 整批校验：当前版本（+1）、规则引用的工作流与阶段必须存在且从属
      return ['rule_sets', 'workflows', 'workflow_stages']
    case 'plugins.replace':
    case 'plugin.set':
      // 插件设置整批替换：当前版本（+1）与整批形状；授权与声明能力的匹配由宿主视图判
      return ['plugin_settings']
    case 'rule.trigger':
      // 手动运行：读规则集与目标工作流/阶段/智能体/运行时，并做 externalRef 去重（tasks）；
      // M6.5：给规则任务建隐式线程（本地构造，不读 threads）；M7.5：首轮提示词带上下文
      return [
        'rule_sets',
        'tasks',
        'workflows',
        'workflow_stages',
        'agents',
        'runtimes',
        'task_comments',
      ]
    case 'thread.note':
    case 'thread.close':
    case 'thread.bind':
      // 线程命令只读线程行（bind 还要校验目标键唯一）
      return ['threads']
    case 'card.delivered':
    case 'card.delivery_failed':
      // 投递回写只读卡片当前行（校验版本 / 幂等：迟到与重复投递零事实）
      return ['cards']
  }
}
