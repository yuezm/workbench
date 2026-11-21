/**
 * 派单落点提示（M53）：目标阶段不派活时，链条会停在那里等人，界面上要提前说清楚。
 *
 * 这不是校验错误：把单投到「待办」让人先认领是合法用法。只有「以为它会自己跑」才是坑，
 * 所以是提示而不是拦截（内核照旧允许保存）。
 */
import { terminalOutcomeOf, type WorkflowStage } from '@workbench/protocol/entities'

export function handoffLandingWarning(
  stages: readonly WorkflowStage[],
  stageId: string | null,
): string | null {
  if (stageId === null) return null
  const stage = stages.find((item) => item.id === stageId)
  if (stage === undefined) return null
  // 终态口径与内核共用 `terminalOutcomeOf`：别在这里重写 `builtin === 'done'` 的字面量
  const outcome = terminalOutcomeOf(stage)
  if (outcome !== null) {
    const landed = outcome === 'cancelled' ? '已取消' : '已完成'
    return `目标阶段「${stage.name}」是终态：派出的单建出来就是${landed}，不会再派活。`
  }
  if (stage.entryMode !== 'none') return null
  return `目标阶段「${stage.name}」不派活，链条会停在这里等人来拖。`
}
