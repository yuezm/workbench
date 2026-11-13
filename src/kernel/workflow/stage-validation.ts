import type { StageExitGuard, StageInput } from '../../protocol/entities'

/**
 * 纯函数：校验一条工作流的阶段配置。
 * 返回第一条错误文案；全部合法时返回 null。调用方决定如何落地（抛异常 / 回给 IPC）。
 *
 * 判定顺序与文案是行为基线：阶段数量 → 名称 → agent 阶段必选智能体 → 判定形态 →
 * 验收归属（M34：只许闸门）→ 判定者独立（不与被验阶段同一智能体）→
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
    // M40：脚本阶段必须带脚本；非脚本阶段上残留的脚本由内核归一清空（不报错）
    if (s.entryMode === 'script' && (s.script === undefined || s.script === null)) {
      return `阶段「${s.name}」设为执行脚本时必须填写命令`
    }
    // 判定必须有判定者：结论来自回执（智能体）或退出码（脚本）
    if (s.judge) {
      if (s.entryMode !== 'agent' && s.entryMode !== 'script') {
        return `阶段「${s.name}」设为判定时必须交给智能体或脚本`
      }
      const maxFails = s.judge.maxFails ?? null
      if (maxFails !== null && (!Number.isInteger(maxFails) || maxFails < 1)) {
        return `阶段「${s.name}」的放行护栏必须是不设或 ≥1 的整数`
      }
    }
    // M34：验收只属于闸门阶段——执行阶段不给自己判分
    if (!s.judge && (s.acceptance?.length ?? 0) > 0) {
      return `阶段「${s.name}」不是判定阶段：验收条目只能配在闸门阶段`
    }
    // M40：一条脚本只能证明一条验收（退出码是一个值，不是逐条证据）
    if (s.entryMode === 'script' && (s.acceptance?.length ?? 0) > 1) {
      return `阶段「${s.name}」的脚本闸门最多一条验收条目`
    }
    // M34：判定者不能同时是被验阶段的执行者，否则又变成自己判自己
    if (s.judge) {
      const reviewed = reviewedStage(stages, i)
      if (reviewed !== null && reviewed.agentId !== null && reviewed.agentId === s.agentId) {
        return `阶段「${s.name}」的判定者不能与被验阶段「${reviewed.name}」是同一个智能体`
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

/**
 * 闸门阶段的被验阶段（M34）：往前找最近的**执行**阶段（`entry_mode='agent'` 且自身不是闸门）。
 *
 * 跳过闸门是为了「A → 判定1 → 判定2」这种链：判定2 验的仍是 A 的产出，不是判定1 的结论。
 * 找不到（例如工作流以闸门开头）时返回 null——没有可比的执行者，不拦。
 */
function reviewedStage(stages: StageInput[], index: number): StageInput | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = stages[i]
    if (candidate.entryMode === 'agent' && !candidate.judge) return candidate
  }
  return null
}
