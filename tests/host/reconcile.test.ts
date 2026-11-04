// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import type { KernelPort } from '../../src/kernel/types'
import type { Agent, Runtime, Task } from '../../src/protocol/entities'
import { reconcile, type ReconcileDeps } from '../../src/host/reconcile'
import { openDatabase } from '../../src/host/db'
import { createProcessRegistry, type ProcessRegistry } from '../../src/host/process-registry'
import { createStore, type Store } from '../../src/host/store/index'

const kernel: KernelPort = { decide, project, viewSpec }
const AT = '2026-01-01T00:00:00.000Z'
const PAST = '2025-12-31T00:00:00.000Z'
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }

interface World {
  db: DatabaseSync
  store: Store
  registry: ProcessRegistry
}

let world: World
let commandSeq = 0

const nextCommandId = (): string => {
  commandSeq += 1
  return `cmd-${commandSeq}`
}

beforeEach(() => {
  commandSeq = 0
  const db = openDatabase(':memory:')
  const store = createStore({ db, kernel })
  store.ensureProjection()
  world = { db, store, registry: createProcessRegistry(db) }
})

afterEach(() => world.db.close())

/** 直读投影：对账只看 run 的当前状态（测试用它构造「崩溃后遗留」的夹具）。 */
const runRow = (runId: string): Record<string, unknown> | undefined =>
  world.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as unknown as
    Record<string, unknown> | undefined

const runStatus = (runId: string): ReturnType<ReconcileDeps['runStatus']> => {
  const row = runRow(runId)
  return row ? (String(row.status) as ReturnType<ReconcileDeps['runStatus']>) : null
}

const registryPids = (): Array<number | null> => world.registry.list().map((row) => row.pid)

/** 建一条「运行时 + 智能体 + agent 单阶段工作流 + 任务」并领取它的 run（running + 租约）。 */
function claimRun(): { runtime: Runtime; runId: string; taskId: string } {
  const runtimeFacts = world.store.dispatch({
    type: 'runtime.create',
    commandId: nextCommandId(),
    input: { name: 'rt-' + commandSeq, maxConcurrent: 1 },
  }).facts
  const runtimeId = (
    runtimeFacts.find((fact) => fact.type === 'runtime.created')?.payload as { runtime: Runtime }
  ).runtime.id
  const runtime = world.store.query('runtimes.all').find((item) => item.id === runtimeId) as Runtime

  const agentFacts = world.store.dispatch({
    type: 'agent.create',
    commandId: nextCommandId(),
    input: { name: 'coder', runtimeId, systemPrompt: 'sys' },
  }).facts
  const agentId = (
    agentFacts.find((fact) => fact.type === 'agent.created')?.payload as { agent: Agent }
  ).agent.id

  const workflowFacts = world.store.dispatch({
    type: 'workflow.create',
    commandId: nextCommandId(),
    input: { name: 'w', stages: [{ name: '执行', entryMode: 'agent', agentId }] },
  }).facts
  const workflowId = (
    workflowFacts.find((fact) => fact.type === 'workflow.created')?.payload as {
      workflow: { id: string }
    }
  ).workflow.id
  const taskFacts = world.store.dispatch({
    type: 'task.create',
    commandId: nextCommandId(),
    input: { title: 'T', workflowId },
  }).facts
  const taskId = (taskFacts.find((fact) => fact.type === 'task.created')?.payload as { task: Task })
    .task.id

  world.store.dispatch({ type: 'run.claim', runtimeId: runtime.id, capacity: 1 })
  const run = world.db.prepare('SELECT id FROM runs WHERE task_id = ?').get(taskId) as unknown as {
    id: string
  }
  return { runtime, runId: run.id, taskId }
}

/** 夹具：把 running 的租约/超时时刻改到过去，模拟「崩溃后遗留的 claim」。 */
const staleLease = (runId: string, patch: { leaseUntil?: string; deadlineAt?: string }): void => {
  if (patch.leaseUntil !== undefined) {
    world.db.prepare('UPDATE runs SET lease_until = ? WHERE id = ?').run(patch.leaseUntil, runId)
  }
  if (patch.deadlineAt !== undefined) {
    world.db.prepare('UPDATE runs SET deadline_at = ? WHERE id = ?').run(patch.deadlineAt, runId)
  }
}

/** 登记残留行（崩溃时 scheduler 已 begin/attachPid，未走到 finally 的 remove）。 */
const residue = (runId: string, pid: number | null): void => {
  world.registry.begin(runId, AT)
  if (pid !== null) world.registry.attachPid(runId, pid)
}

interface Harness {
  summary: ReturnType<typeof reconcile>
  events: string[]
  killedPids: number[]
}

function runReconcile(killPid: (pid: number) => boolean = () => true): Harness {
  const events: string[] = []
  const killedPids: number[] = []
  const summary = reconcile({
    registry: world.registry,
    dispatch: (input) => {
      events.push('dispatch:' + (input as { type: string }).type)
      return world.store.dispatch(input)
    },
    runStatus,
    killPid: (pid) => {
      events.push('kill:' + pid)
      killedPids.push(pid)
      return killPid(pid)
    },
  })
  return { summary, events, killedPids }
}

describe('reconcile：先杀后记账', () => {
  it('超租约的残留进程：先按 pid 终止，再清表，最后 clock.tick 回收为 queued + 退避', () => {
    const { runId } = claimRun()
    staleLease(runId, { leaseUntil: PAST })
    residue(runId, 123)
    expect(registryPids()).toEqual([123])

    const { summary, events, killedPids } = runReconcile()

    // 顺序：kill → clear → tick（清表没有独立事件，用 registry 已空 + tick 在 kill 之后断言）
    expect(events).toEqual(['kill:123', 'dispatch:clock.tick'])
    expect(killedPids).toEqual([123])
    expect(summary).toEqual({ killed: 1, cleared: 1, facts: 1 })
    expect(registryPids()).toEqual([])

    // 超租约回收：attempts+1 后回 queued（未达 maxAttempts），并写入退避时刻
    const row = runRow(runId) as Record<string, unknown>
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(1)
    expect(String(row.not_before)).not.toBe('')
    expect(row.lease_id).toBeNull()
  })

  it('超过 deadline 的残留 run：终止进程后回收为 failed/timeout', () => {
    const { runId } = claimRun()
    // 未超租约（心跳还在续）但已超过单轮 deadline
    staleLease(runId, { deadlineAt: PAST })
    residue(runId, 555)

    const { summary, events } = runReconcile()

    expect(events).toEqual(['kill:555', 'dispatch:clock.tick'])
    expect(summary).toEqual({ killed: 1, cleared: 1, facts: 1 })
    expect(runRow(runId)).toMatchObject({ status: 'failed', error_code: 'timeout' })
  })

  it('killPid 返回 false（进程已消失）：仍清表，killed 记 0', () => {
    const { runId } = claimRun()
    staleLease(runId, { leaseUntil: PAST })
    residue(runId, 9)

    const { summary } = runReconcile(() => false)

    expect(summary.killed).toBe(0)
    expect(summary.cleared).toBe(1)
    expect(registryPids()).toEqual([])
  })
})

describe('reconcile：只处理孤儿，不误杀', () => {
  it('已终态 run 的残留行：只清理登记，不按 pid 杀（pid 可能被复用）', () => {
    const { runId } = claimRun()
    const claimed = runRow(runId) as Record<string, unknown>
    world.store.dispatch({
      type: 'run.receipt',
      runId,
      receipt: {
        status: 'succeeded',
        leaseId: String(claimed.lease_id),
        turn: Number(claimed.turn),
        output: 'done',
        usage,
        durationMs: 1,
      },
    })
    expect(runStatus(runId)).toBe('succeeded')
    residue(runId, 999)

    const { summary, killedPids, events } = runReconcile()

    expect(killedPids).toEqual([])
    expect(summary).toEqual({ killed: 0, cleared: 1, facts: 0 })
    expect(events).toEqual(['dispatch:clock.tick'])
    expect(registryPids()).toEqual([])
    expect(runStatus(runId)).toBe('succeeded')
  })

  it('run 已删除（缺失）的残留行：只清理，不杀', () => {
    residue('ghost', 777)

    const { summary, killedPids } = runReconcile()

    expect(killedPids).toEqual([])
    expect(summary).toEqual({ killed: 0, cleared: 1, facts: 0 })
    expect(registryPids()).toEqual([])
  })

  it('多行混合：只杀仍在执行中的 run，终态/缺失行只清理', () => {
    const active = claimRun()
    staleLease(active.runId, { leaseUntil: PAST })
    residue(active.runId, 11)
    residue('ghost', 22)

    const { killedPids, summary } = runReconcile()

    expect(killedPids).toEqual([11])
    expect(summary).toEqual({ killed: 1, cleared: 2, facts: 1 })
    expect(registryPids()).toEqual([])
  })

  it('waiting（等人回答）的 run 保留状态，但残留进程仍终止', () => {
    const { runId } = claimRun()
    // 只有 running 会超时/超租约；waiting 是内核保留的挂起态（D12）
    world.db.prepare("UPDATE runs SET status = 'waiting', lease_id = NULL WHERE id = ?").run(runId)
    residue(runId, 33)

    const { summary, killedPids } = runReconcile()

    expect(killedPids).toEqual([33])
    expect(summary).toEqual({ killed: 1, cleared: 1, facts: 0 })
    expect(runStatus(runId)).toBe('waiting')
  })
})

describe('reconcile：无残留', () => {
  it('登记表为空、没有过期 run：不动任何数据（no-op）', () => {
    const { runId } = claimRun()
    staleLease(runId, { leaseUntil: '2099-01-01T00:00:00.000Z' })

    const { summary, events, killedPids } = runReconcile()

    expect(events).toEqual(['dispatch:clock.tick'])
    expect(summary).toEqual({ killed: 0, cleared: 0, facts: 0 })
    expect(killedPids).toEqual([])
    expect(runStatus(runId)).toBe('running')
    expect(registryPids()).toEqual([])
  })

  it('pid 为空的占位行（spawn 前崩溃）：不杀，直接清理', () => {
    const { runId } = claimRun()
    staleLease(runId, { leaseUntil: PAST })
    residue(runId, null)

    const { summary, killedPids } = runReconcile()

    expect(killedPids).toEqual([])
    expect(summary).toEqual({ killed: 0, cleared: 1, facts: 1 })
    expect(registryPids()).toEqual([])
  })
})
