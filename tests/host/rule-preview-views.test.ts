// @vitest-environment node
/**
 * 规则预演 / 下次触发 两条只读视图（M36-F）：真实 SQLite + 真实内核纯函数。
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationRule } from '../../src/protocol/rules'
import type { RuleNextFire, RulePreview } from '../../src/protocol/rules'
import { createProjectionWriter } from '../../src/host/store/projection-apply'
import { queryView } from '../../src/host/store/views'
import { createMemoryDb, sample } from './store/test-support'

const AT = '2026-11-14T10:00:00.000Z'

let openDbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

const memory = (): DatabaseSync => {
  const db = createMemoryDb()
  db.exec('PRAGMA foreign_keys = OFF')
  openDbs.push(db)
  return db
}

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: 'rule-1',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled: true,
  ...over,
})

const seed = (db: DatabaseSync, rules: AutomationRule[]): void => {
  const writer = createProjectionWriter(db)
  writer.apply(
    {
      table: 'rule_sets',
      key: 'current',
      row: { id: 'current', version: 1, replacedAt: AT, rules },
    },
    AT,
  )
  writer.apply({ table: 'projects', key: 'pj-1', row: sample.project() }, AT)
  writer.apply({ table: 'workflows', key: 'wf-1', row: sample.workflow() }, AT)
  writer.apply({ table: 'workflow_stages', key: 'st-1', row: sample.stage() }, AT)
}

describe('rules.preview', () => {
  it('命中启用规则：给出工作流 / 阶段 / 标题', () => {
    const db = memory()
    seed(db, [rule()])
    const preview = queryView(db, 'rules.preview', {
      source: 'github',
      type: 'issues.opened',
      subject: '#42 登录页报错',
    }) as RulePreview

    expect(preview.wouldCreate).toBe(true)
    expect(preview.matches).toEqual([
      {
        ruleId: 'rule-1',
        ruleName: 'Issue 进研发',
        enabled: true,
        workflowId: 'wf-1',
        stageId: 'st-1',
        title: '#42 登录页报错',
        threadKey: '#42 登录页报错',
      },
    ])
  })

  it('不命中：零匹配、不建任何东西', () => {
    const db = memory()
    seed(db, [rule()])
    expect(
      queryView(db, 'rules.preview', { source: 'gitlab', type: 'issues.opened', subject: '#1' }),
    ).toEqual({ matches: [], wouldCreate: false })
  })

  it('停用规则列出但 wouldCreate=false', () => {
    const db = memory()
    seed(db, [rule({ enabled: false })])
    const preview = queryView(db, 'rules.preview', {
      source: 'github',
      type: 'issues.opened',
      subject: '#1',
    }) as RulePreview
    expect(preview.matches[0]?.enabled).toBe(false)
    expect(preview.wouldCreate).toBe(false)
  })
})

describe('rules.next', () => {
  it('cron 规则给出下一次触发；事件规则与停用规则给 null', () => {
    const db = memory()
    seed(db, [
      rule({ id: 'cron-1', when: { cron: '0 9 * * *' } }),
      rule({ id: 'event-1' }),
      rule({ id: 'off-1', when: { cron: '0 9 * * *' }, enabled: false }),
    ])

    const rows = queryView(db, 'rules.next', { now: AT, timezone: 'UTC' }) as RuleNextFire[]
    const byId = new Map(rows.map((row) => [row.ruleId, row]))
    expect(byId.get('cron-1')).toEqual({
      ruleId: 'cron-1',
      enabled: true,
      nextAt: '2026-11-15T09:00:00.000Z',
    })
    expect(byId.get('event-1')?.nextAt).toBeNull()
    expect(byId.get('off-1')).toEqual({ ruleId: 'off-1', enabled: false, nextAt: null })
  })
})
