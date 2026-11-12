import type { StageExitGuard, StageInput } from '../../protocol/entities'

/**
 * 纯函数：校验一条工作流的阶段配置。
 * 返回第一条错误文案；全部合法时返回 null。调用方决定如何落地（抛异常 / 回给 IPC）。
 *
 * 判定顺序与文案是行为基线：阶段数量 → 名称 → agent 阶段必选智能体 → 判定形态 →
 * 出口表（每组一条、判定与非判定互斥、goto 目标越界 / 自指）。
 *
 * `errored` 这条边只表示**执行出错**（CLI 崩 / 超时）；业务上没过是判定的 `failed`。
 */
const EXIT_LABELS: Record<StageExitGuard, string> = {
  done: '完成后进入',
  errored: '出错时进入',
  passed: '闸门通过时进入',
  failed: '闸门未通过时进入',
}

export function validateStageSet(stages: StageInput[]): string | null {
  if (!stages.length) return '工作流至少需要一个阶段'
  const n = stages.length
  for (let i = 0; i < stages.length; i += 1) {
    const s = stages[i]
    if (!s.name?.trim()) return `第 ${i + 1} 个阶段名称必填`
    if (s.entryMode === 'agent' && !s.agentId) {
      return `阶段「${s.name}」设为交给智能体时必须选择智能体`
    }
    // 判定必须有判定者：结论来自回执，只有 agent 阶段才会产出回执
    if (s.judge) {
      if (s.entryMode !== 'agent') {
        return `阶段「${s.name}」设为判定时必须交给智能体`
      }
      const maxFails = s.judge.maxFails ?? null
      if (maxFails !== null && (!Number.isInteger(maxFails) || maxFails < 1)) {
        return `阶段「${s.name}」的放行护栏必须是不设或 ≥1 的整数`
      }
    }
    const error = validateExits(s, i, n)
    if (error) return error
  }
  return null
}

/** 单个阶段的出口表：每组的唯一性、判定互斥、`goto` 目标合法性。 */
function validateExits(stage: StageInput, index: number, count: number): string | null {
  const seen = new Set<StageExitGuard>()
  for (const exit of stage.exits ?? []) {
    const label = EXIT_LABELS[exit.on]
    if (seen.has(exit.on)) return `阶段「${stage.name}」的${label}只能配一条去向`
    seen.add(exit.on)
    // 判定阶段跑完没结论不构成去向；非判定阶段没有「通过 / 未通过」
    if (stage.judge && exit.on === 'done') {
      return `阶段「${stage.name}」是判定阶段，没有「完成后进入」`
    }
    if (!stage.judge && (exit.on === 'passed' || exit.on === 'failed')) {
      return `阶段「${stage.name}」不是判定阶段，没有「${label}」`
    }
    if (exit.do !== 'goto') continue
    const target = exit.stageIndex
    if (target === null || target === undefined) {
      return `阶段「${stage.name}」的${label}必须指定目标阶段`
    }
    if (!Number.isInteger(target) || target < 0 || target >= count) {
      return `阶段「${stage.name}」的${label}目标越界`
    }
    if (target === index) return `阶段「${stage.name}」的${label}不能指向自己`
  }
  return null
}
