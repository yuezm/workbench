// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { queryView } from '@workbench/host-store/views'
import type { AutomationRule } from '@workbench/protocol/rules'
import type { Authority } from '@workbench/protocol/authority'
import { createMemoryDb } from './test-support'

const AT = '2026-11-17T00:00:00.000Z'

const rule: AutomationRule = {
  id: 'rule-1',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled: true,
}

const authority: Authority = {
  mode: 'observe',
  sources: [
    {
      id: 'github',
      allowed: ['octocat'],
      bots: ['dependabot[bot]'],
      receiveAll: false,
      admission: {
        listedAddressed: 'explicit',
        listedUnaddressed: 'inferred',
        unlistedAddressed: 'ignore',
        unlistedUnaddressed: 'ignore',
        botAddressed: 'inferred',
      },
    },
  ],
  assessorAgentId: null,
  assessBatch: 5,
  assessWindowMs: 1000,
}

const seed = (version: number, value: Authority | null): ReturnType<typeof createMemoryDb> => {
  const db = createMemoryDb()
  db.prepare(
    'INSERT INTO rule_sets (id, version, replaced_at, rules_json, authority_json) VALUES (?, ?, ?, ?, ?)',
  ).run(
    'current',
    version,
    AT,
    JSON.stringify([rule]),
    value === null ? null : JSON.stringify(value),
  )
  return db
}

describe('authority.current（A1 准入回显）', () => {
  it('没有规则集：报 compat + 版本 0', () => {
    const db = createMemoryDb()
    expect(queryView(db, 'authority.current')).toEqual({
      mode: 'compat',
      sources: [],
      assessorAgentId: null,
      assessBatch: 8,
      assessWindowMs: 5000,
      policyVersion: 0,
    })
  })

  it('规则集没有准入块：报 compat，带上规则版本', () => {
    const db = seed(3, null)
    expect(queryView(db, 'authority.current')).toEqual({
      mode: 'compat',
      sources: [],
      assessorAgentId: null,
      assessBatch: 8,
      assessWindowMs: 5000,
      policyVersion: 3,
    })
  })

  it('配置了就原样回显（规则页据此渲染）', () => {
    const db = seed(7, authority)
    expect(queryView(db, 'authority.current')).toEqual({
      mode: 'observe',
      sources: authority.sources,
      assessorAgentId: null,
      assessBatch: 5,
      assessWindowMs: 1000,
      policyVersion: 7,
    })
  })
})
