// @vitest-environment node
/**
 * 停用规则跳过 → 补跑 的真实链路（M42）：真内核 + 真 SQLite + 真投影。
 *
 * 覆盖三件事：
 * 1. 停用期间命中的事件落进 `event_skips`（`replayed_at = NULL`），不建任务；
 * 2. 恢复后 `rule.replay` 补建任务并把该行标成已补跑；
 * 3. 重复补跑零事实；重建投影与增量逐表全等。
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationRule } from '../../../src/protocol/rules'
import { decide } from '../../../src/kernel/decide'
import { project } from '../../../src/kernel/scopes/project'
import { viewSpec } from '../../../src/kernel/scopes/view-spec'
import { nextWakeAt } from '../../../src/kernel/core/next-wake'
import { createStore } from '../../../src/host/store/index'
import { createMemoryDb, dumpProjection } from './test-support'

const AT = '2026-11-14T10:00:00.000Z'

let openDbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

const memory = (): DatabaseSync => {
  const db = createMemoryDb()
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

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }).n

describe('store：规则暂停与补跑（M42）', () => {
  it('停用期间事件进 event_skips；恢复后补跑建任务；重复补跑零事实', () => {
    const db = memory()
    let counter = 0
    const store = createStore({
      db,
      kernel: { decide, project, viewSpec, nextWakeAt },
      now: () => AT,
      newId: () => {
        counter += 1
        return `id-${counter}`
      },
      timezone: 'UTC',
    })

    const runtime = store.dispatch({
      type: 'runtime.create',
      commandId: 'c-rt',
      input: { name: '本地', executorKey: 'command', command: 'echo' },
    })
    const runtimeId = (
      runtime.facts.find((fact) => fact.type === 'runtime.created')?.payload as {
        runtime: { id: string }
      }
    ).runtime.id

    const agent = store.dispatch({
      type: 'agent.create',
      commandId: 'c-ag',
      input: { name: '实现者', runtimeId },
    })
    const agentId = (
      agent.facts.find((fact) => fact.type === 'agent.created')?.payload as {
        agent: { id: string }
      }
    ).agent.id

    const workflow = store.dispatch({
      type: 'workflow.create',
      commandId: 'c-wf',
      input: {
        name: '研发',
        stages: [
          { name: '实现', entryMode: 'agent', agentId },
          { name: '完成', entryMode: 'none' },
        ],
      },
    })
    const workflowId = (
      workflow.facts.find((fact) => fact.type === 'workflow.created')?.payload as {
        workflow: { id: string }
      }
    ).workflow.id

    store.dispatch({
      type: 'rules.replace',
      commandId: 'c-r1',
      rules: [rule({ to: { workflowId } })],
    })
    store.dispatch({
      type: 'event.received',
      event: { source: 'github', type: 'issues.opened', subject: '#1' },
    })
    expect(count(db, 'tasks')).toBe(1)
    expect(count(db, 'events')).toBe(1)
    expect(count(db, 'event_skips')).toBe(0)

    // 暂停：同一入口的新事件只留痕
    store.dispatch({
      type: 'rules.replace',
      commandId: 'c-r2',
      rules: [rule({ to: { workflowId }, enabled: false })],
    })
    store.dispatch({
      type: 'event.received',
      event: { source: 'github', type: 'issues.opened', subject: '#2' },
    })
    expect(count(db, 'tasks')).toBe(1)
    expect(count(db, 'event_skips')).toBe(1)
    expect(
      db.prepare('SELECT replayed_at FROM event_skips').get() as unknown as {
        replayed_at: string | null
      },
    ).toEqual({ replayed_at: null })

    // 停用中补跑：拒绝
    expect(() =>
      store.dispatch({
        type: 'rule.replay',
        commandId: 'c-rp0',
        ruleId: rule({ to: { workflowId } }).id,
      }),
    ).toThrow(/已停用/)

    // 恢复后补跑：建任务并标记已补跑
    store.dispatch({
      type: 'rules.replace',
      commandId: 'c-r3',
      rules: [rule({ to: { workflowId } })],
    })
    const replayed = store.dispatch({ type: 'rule.replay', commandId: 'c-rp1', ruleId: 'rule-1' })
    expect(replayed.facts.map((fact) => fact.type)).toContain('task.created')
    expect(count(db, 'tasks')).toBe(2)
    const skip = db.prepare('SELECT replayed_at FROM event_skips').get() as unknown as {
      replayed_at: string | null
    }
    expect(skip.replayed_at).toBe(AT)

    // 重复补跑：零事实
    const replayAgain = store.dispatch({
      type: 'rule.replay',
      commandId: 'c-rp2',
      ruleId: 'rule-1',
    })
    expect(replayAgain.facts).toEqual([])
    expect(count(db, 'tasks')).toBe(2)

    // 增量投影与重建逐表全等（包含 events / event_skips 两张新表）
    const incremental = dumpProjection(db)
    store.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
  })
})
