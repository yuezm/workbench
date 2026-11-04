/**
 * 命令 → 需要装载的投影切片。
 *
 * 宿主按这张表装 `View`，内核不查库、也不要求全量装载；M1 先按表粒度切
 * （`ProjectionTable`），M5 需要更细时再收窄到按 id。
 *
 * 约定：返回 `tasks` 的命令同时要装 `View.activeTaskIds`（宿主按 `runs` 现算的
 * queued/running 任务集合），「执行中」只认它。
 */
import type { Command } from '../protocol/commands'
import type { ProjectionTable } from './types'

export function viewSpec(input: Command): ProjectionTable[] {
  switch (input.type) {
    case 'workflow.create':
      // 阶段绑定的智能体必须存在（旧实现靠外键，M1 由内核校验）
      return ['agents']
    case 'workflow.update':
      // 改阶段：既有阶段做差量、任务的当前阶段可能因删阶段而重挂、活跃 run 守卫
      return ['workflows', 'workflow_stages', 'agents', 'tasks']
    case 'workflow.remove':
      // 级联删阶段与任务，tombstone 要逐个回查
      return ['workflows', 'workflow_stages', 'tasks']
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
      return ['workflows', 'workflow_stages']
    case 'task.move':
    case 'task.complete':
      return ['tasks', 'workflows', 'workflow_stages']
    case 'task.remove':
      return ['tasks']
  }
}
