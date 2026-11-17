// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { queryView } from '@workbench/host-store/views'
import { createMemoryDb } from './test-support'

const AT = '2026-11-17T00:00:00.000Z'

const insert = (
  db: ReturnType<typeof createMemoryDb>,
  over: { id?: string; taskId?: string; revokedAt?: string | null } = {},
): void => {
  db.prepare(
    `INSERT INTO mandates
      (id, task_id, scope_json, strength, basis, policy_version, rule_ids_json, by_json,
       granted_at, revoked_at, revoked_reason, legacy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    over.id ?? 'mandate-1',
    over.taskId ?? 'task-1',
    JSON.stringify({
      workflowId: 'wf-1',
      stageId: 'st-1',
      projectId: null,
      access: 'edit',
      maxRuns: null,
      maxTokens: null,
      expiresAt: null,
    }),
    'explicit',
    'addressed',
    4,
    JSON.stringify(['rule-1']),
    JSON.stringify({
      kind: 'identity',
      source: 'github',
      identity: { kind: 'human', id: 'octocat', addressed: true },
    }),
    AT,
    over.revokedAt ?? null,
    over.revokedAt === undefined || over.revokedAt === null ? null : 'stop',
  )
}

describe('mandates.byTask（A2 授权回显）', () => {
  it('没有授权：返回 null（老任务不造行）', () => {
    const db = createMemoryDb()
    expect(queryView(db, 'mandates.byTask', { taskId: 'task-1' })).toBeNull()
  })

  it('有授权：整行回显（范围 / 强度 / 依据 / 版本 / 授予人）', () => {
    const db = createMemoryDb()
    insert(db)
    expect(queryView(db, 'mandates.byTask', { taskId: 'task-1' })).toEqual({
      id: 'mandate-1',
      taskId: 'task-1',
      scope: {
        workflowId: 'wf-1',
        stageId: 'st-1',
        projectId: null,
        access: 'edit',
        maxRuns: null,
        maxTokens: null,
        expiresAt: null,
      },
      strength: 'explicit',
      basis: 'addressed',
      policyVersion: 4,
      ruleIds: ['rule-1'],
      by: {
        kind: 'identity',
        source: 'github',
        identity: { kind: 'human', id: 'octocat', addressed: true },
      },
      grantedAt: AT,
      revokedAt: null,
      revokedReason: null,
      legacy: false,
    })
  })

  it('撤销后仍能回显（历史要能回答「当时凭什么」）', () => {
    const db = createMemoryDb()
    insert(db, { revokedAt: AT })
    const row = queryView(db, 'mandates.byTask', { taskId: 'task-1' })
    expect(row).toMatchObject({ revokedAt: AT, revokedReason: 'stop' })
  })
})
