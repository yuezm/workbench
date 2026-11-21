// @vitest-environment node
/**
 * 评审严重度的阻断口径（2026-11-21）：`blocker` / `high` 阻断推进；`medium` / `low`
 * 只留痕。判定收在 protocol 一处，内核、UI 与提示词都读它，避免各层各写一套。
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCKING_SEVERITIES,
  isBlockingSeverity,
  REVIEW_SEVERITIES,
  type ReviewSeverity,
} from '@workbench/protocol/review'

describe('protocol/review 阻断严重度', () => {
  it('阻断集合就是 blocker / high（P0 / P1）', () => {
    expect([...BLOCKING_SEVERITIES]).toEqual(['blocker', 'high'])
  })

  it('按严重度判定阻断；建议项不阻断', () => {
    expect(isBlockingSeverity('blocker')).toBe(true)
    expect(isBlockingSeverity('high')).toBe(true)
    expect(isBlockingSeverity('medium')).toBe(false)
    expect(isBlockingSeverity('low')).toBe(false)
  })

  it('每个已知严重度都有确定的判定（不会漏掉新加的档）', () => {
    for (const severity of REVIEW_SEVERITIES) {
      expect(typeof isBlockingSeverity(severity as ReviewSeverity)).toBe('boolean')
    }
  })
})
