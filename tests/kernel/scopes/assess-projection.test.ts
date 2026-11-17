// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Assessment } from '@workbench/protocol/authority'
import { FACT_TYPES } from '@workbench/protocol/facts'
import type { Fact } from '@workbench/kernel/core/types'
import { project } from '@workbench/kernel/scopes/project'
import { timeline } from '@workbench/kernel/scopes/timeline'

const AT = '2026-11-17T13:00:00.000Z'

const assessment = (over: Partial<Assessment> = {}): Assessment => ({
  id: 'assess-1',
  eventId: 'event-1',
  policyVersion: 6,
  ruleIds: ['rule-1', 'rule-2'],
  verdicts: [
    { ruleId: 'rule-1', match: true, evidence: '正文写明「登录页 500」' },
    { ruleId: 'rule-2', match: false, evidence: null },
  ],
  decision: 'accept',
  wouldAccept: false,
  via: 'assessor',
  ...over,
})

const fact = (payload: unknown): Fact =>
  ({ seq: 1, type: 'assess.decided', actor: { kind: 'kernel' }, at: AT, payload }) as Fact

describe('A3 研判事实', () => {
  it('FACT_TYPES 收录 assess.decided', () => {
    expect(FACT_TYPES).toContain('assess.decided')
  })

  it('一行事实 → assessments 一行投影（整行携带，重建不回查）', () => {
    const row = assessment()
    expect(project(fact({ assessment: row }))).toEqual([
      { table: 'assessments', key: 'assess-1', row },
    ])
  })

  it('同一事件重判：新 id 覆盖同事件的新行（按 event 定位读最新一版）', () => {
    const second = assessment({ id: 'assess-2', policyVersion: 7 })
    expect(project(fact({ assessment: second }))).toEqual([
      { table: 'assessments', key: 'assess-2', row: second },
    ])
  })

  it('研判不挂业务实体：why 链里只经 cause 出现', () => {
    expect(timeline([fact({ assessment: assessment() })], 'task', 'task-1')).toEqual([])
  })
})
