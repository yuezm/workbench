import type { StageInput } from '../../protocol/entities'

/**
 * 纯函数：校验一条工作流的阶段配置。
 * 返回第一条错误文案；全部合法时返回 null。调用方决定如何落地（抛异常 / 回给 IPC）。
 *
 * 判定顺序与文案是行为基线：阶段数量 → 名称 → agent 阶段必选智能体 → 闸门形态 →
 * 目标下标越界 / 自指。M11 起 `onReject` 的文案改为「出错时进入」——闸门接走业务失败后，
 * 这条边只表示执行出错（CLI 崩 / 超时）。
 */
export function validateStageSet(stages: StageInput[]): string | null {
  if (!stages.length) return '工作流至少需要一个阶段'
  const n = stages.length
  for (let i = 0; i < stages.length; i += 1) {
    const s = stages[i]
    if (!s.name?.trim()) return `第 ${i + 1} 个阶段名称必填`
    if (s.entryMode === 'agent' && !s.agentId) {
      return `阶段「${s.name}」设为交给智能体时必须选择智能体`
    }
    // 闸门必须有判定者：判定来自回执，只有 agent 阶段才会产出回执
    if (s.gate) {
      if (s.entryMode !== 'agent') {
        return `阶段「${s.name}」设为闸门时必须交给智能体`
      }
      if (!Number.isInteger(s.gate.maxFails) || s.gate.maxFails < 1) {
        return `阶段「${s.name}」的闸门次数必须是 ≥1 的整数`
      }
    }
    for (const [label, idx] of [
      ['完成后进入', s.onCompleteIndex],
      ['出错时进入', s.onRejectIndex],
      ['闸门通过时进入', s.gate?.onPassIndex],
      ['闸门未通过时进入', s.gate?.onFailIndex],
    ] as const) {
      if (idx === null || idx === undefined) continue
      if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
        return `阶段「${s.name}」的${label}目标越界`
      }
      if (idx === i) return `阶段「${s.name}」的${label}不能指向自己`
    }
  }
  return null
}
