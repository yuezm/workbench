// @vitest-environment node
/**
 * T3 运行/聊天投影专项：
 *
 * - 一段随机（固定种子）run/chat 事实序列，经 store 的实时写入路径落投影；
 * - `rebuild()` 清空九表后按 seq 重放同一批事实，逐表与增量投影全等（含 `run_events`）；
 * - `run_events` 的 `(run_id, seq)` 冲突直接报错、事务回滚、不覆盖历史；
 * - `run.removed` 删除 run 行时按 `run_id` 联删事件，且不影响其它 run。
 *
 * 事实由假内核的 `decide` 逐次吐出（store 只认真实 `project`），因此这条用例覆盖的是
 * 「dispatch 实时投影」与「rebuild 重放」两条独立路径。
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { project } from '../../../src/kernel/scopes/project'
import { KERNEL_VERSION } from '../../../src/kernel/core/types'
import type { Actor, FactDraft } from '../../../src/kernel/core/types'
import type { Conversation } from '../../../src/protocol/entities'
import type { FactPayload, FactType } from '../../../src/protocol/facts'
import { PROJECTION_TABLES, projectionFormat } from '../../../src/host/schema'
import { createStore } from '../../../src/host/store/index'
import { readProjectionMeta } from '../../../src/host/store/projection'
import { createFakeKernel } from './fake-kernel'
import {
  captureError,
  countRows,
  createMemoryDb,
  dumpProjection,
  sample,
  sequenceIds,
} from './test-support'

const AT = '2026-06-06T06:06:06.000Z'
const OWNER: Actor = { kind: 'owner', via: 'ui' }

/** 固定种子 PRNG（mulberry32），让「随机序列」可复现。 */
const rng = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state += 0x6d2b79f5
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const draft = <T extends FactType>(type: T, payload: FactPayload<T>): FactDraft<T> => ({
  type,
  actor: OWNER,
  at: AT,
  payload,
})

/** 一段「阶段 run + 聊天 run」混合事实序列（顺序合法，帧 seq 按 run 全局单调）。 */
function buildScript(seed: number): FactDraft[][] {
  const random = rng(seed)
  const between = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1))

  const batches: FactDraft[][] = [
    [
      draft('runtime.created', { runtime: sample.runtime() }),
      draft('agent.created', { agent: sample.agent() }),
      draft('workflow.created', { workflow: sample.workflow() }),
      draft('stage.created', { stage: sample.stage() }),
      draft('task.created', { task: sample.task() }),
    ],
  ]

  /** 生成 N 帧的若干条 run.frames 事实（每帧单独一条，方便断言逐帧追加）。 */
  const frameBatches = (runId: string, turn: number, count: number): FactDraft[][] =>
    Array.from({ length: count }, (_, index) => [
      draft('run.frames', {
        runId,
        turn,
        frames: [
          {
            runId,
            seq: index + 1,
            type: index % 2 === 0 ? 'text' : 'thinking',
            text: `帧 ${runId}-${index}`,
          },
        ],
      }),
    ])

  // run-a：阶段 run 成功（领取 → 续租 → 用量 → 终态）
  const runA = sample.run({ id: 'run-a', queueSeq: 0, ruleId: 'rule-1', rulesVersion: 3 })
  batches.push(
    [
      draft('run.queued', { run: runA }),
      draft('run.claimed', {
        run: {
          ...runA,
          status: 'running',
          leaseId: 'run-a:1',
          attempt: 1,
          leaseUntil: '2026-06-06T06:08:00.000Z',
          deadlineAt: '2026-06-06T06:36:00.000Z',
          startedAt: AT,
        },
      }),
      draft('run.lease_extended', {
        run: { ...runA, leaseId: 'run-a:1', leaseUntil: '2026-06-06T06:10:00.000Z' },
      }),
    ],
    ...frameBatches('run-a', 1, between(1, 4)),
    [
      draft('run.usage', {
        run: {
          ...runA,
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2 },
        },
      }),
      draft('run.succeeded', {
        run: {
          ...runA,
          status: 'succeeded',
          output: '完成',
          sessionId: 'sess-a',
          usage: { inputTokens: 12, outputTokens: 30, cacheReadTokens: 2, cacheWriteTokens: 4 },
          endedAt: AT,
        },
      }),
    ],
  )

  // run-b：阶段 run 失败（放弃一次 → 重新领取 → 失败）
  const runB = sample.run({ id: 'run-b', taskId: 'tk-1', queueSeq: 0 })
  batches.push(
    [
      draft('run.queued', { run: runB }),
      draft('run.claimed', {
        run: {
          ...runB,
          status: 'running',
          leaseId: 'run-b:1',
          attempt: 1,
          leaseUntil: '2026-06-06T06:08:00.000Z',
          deadlineAt: '2026-06-06T06:36:00.000Z',
          startedAt: AT,
        },
      }),
      draft('run.abandoned', {
        run: {
          ...runB,
          status: 'queued',
          attempts: 1,
          notBefore: '2026-06-06T06:15:00.000Z',
          leaseId: null,
          leaseUntil: null,
          deadlineAt: null,
        },
      }),
    ],
    ...frameBatches('run-b', 1, between(1, 3)),
    [
      draft('run.claimed', {
        run: {
          ...runB,
          status: 'running',
          leaseId: 'run-b:2',
          attempt: 2,
          leaseUntil: '2026-06-06T06:20:00.000Z',
          deadlineAt: '2026-06-06T06:50:00.000Z',
          startedAt: AT,
        },
      }),
      draft('run.failed', {
        run: {
          ...runB,
          status: 'failed',
          attempts: 1,
          error: '退出码 1',
          errorCode: 'exit_nonzero',
          exitCode: 1,
          durationMs: 1200,
          endedAt: AT,
        },
      }),
    ],
  )

  // run-c：聊天 run（对话创建 → 用户消息 → 领取 → 帧 → 成功 → 助手消息 → 改标题 / session）
  const conversation: Conversation = sample.conversation({ id: 'cv-1' })
  const runC = sample.run({
    id: 'run-c',
    purpose: 'chat',
    taskId: null,
    stageId: null,
    conversationId: 'cv-1',
    queueSeq: 0,
  })
  batches.push(
    [draft('conversation.created', { conversation })],
    [
      draft('run.queued', { run: runC }),
      draft('message.appended', {
        conversationId: 'cv-1',
        messageId: 'ms-user-1',
        role: 'user',
        content: '你好',
      }),
    ],
    [
      draft('run.claimed', {
        run: {
          ...runC,
          status: 'running',
          leaseId: 'run-c:1',
          attempt: 1,
          leaseUntil: '2026-06-06T06:08:00.000Z',
          deadlineAt: '2026-06-06T06:36:00.000Z',
          startedAt: AT,
        },
      }),
    ],
    ...frameBatches('run-c', 1, between(1, 3)),
    [
      draft('run.succeeded', {
        run: {
          ...runC,
          status: 'succeeded',
          output: '回答',
          sessionId: 'sess-c',
          endedAt: AT,
        },
      }),
      draft('message.appended', {
        conversationId: 'cv-1',
        messageId: 'ms-assistant-1',
        role: 'assistant',
        content: '回答',
        runId: 'run-c',
      }),
      draft('conversation.updated', {
        conversation: { ...conversation, title: '聊天标题', sessionId: 'sess-c', updatedAt: AT },
      }),
    ],
  )

  // run-d：入队后随任务删除被 run.removed 干掉（事件也应消失）
  const runD = sample.run({ id: 'run-d', queueSeq: 0 })
  batches.push([draft('run.queued', { run: runD })], ...frameBatches('run-d', 1, between(1, 2)), [
    draft('run.removed', { runId: 'run-d' }),
  ])

  // run-e：聊天 run 取消，随后删除对话（消息级联删除，run 历史保留 conversationId）
  const conversation2 = sample.conversation({ id: 'cv-2', title: '临时对话' })
  const runE = sample.run({
    id: 'run-e',
    purpose: 'chat',
    taskId: null,
    stageId: null,
    conversationId: 'cv-2',
    queueSeq: 0,
  })
  batches.push(
    [draft('conversation.created', { conversation: conversation2 })],
    [
      draft('message.appended', {
        conversationId: 'cv-2',
        messageId: 'ms-user-2',
        role: 'user',
        content: '临时问题',
      }),
      draft('run.queued', { run: runE }),
    ],
    [
      draft('run.claimed', {
        run: {
          ...runE,
          status: 'running',
          leaseId: 'run-e:1',
          attempt: 1,
          leaseUntil: '2026-06-06T06:08:00.000Z',
          deadlineAt: '2026-06-06T06:36:00.000Z',
          startedAt: AT,
        },
      }),
    ],
    [
      draft('run.cancel_requested', { run: { ...runE, cancelRequested: true }, by: 'owner' }),
      draft('run.cancelled', {
        run: {
          ...runE,
          status: 'cancelled',
          cancelRequested: true,
          errorCode: 'cancelled',
          endedAt: AT,
        },
      }),
    ],
    [draft('conversation.removed', { conversation: conversation2 })],
  )

  // run-f：等待回答后重新入队并成功（waiting 释放租约，续接 turn=2）
  const runF = sample.run({ id: 'run-f', turn: 1, queueSeq: 0 })
  batches.push(
    [draft('run.queued', { run: runF })],
    [
      draft('run.claimed', {
        run: {
          ...runF,
          status: 'running',
          leaseId: 'run-f:1',
          attempt: 1,
          leaseUntil: '2026-06-06T06:08:00.000Z',
          deadlineAt: '2026-06-06T06:36:00.000Z',
          startedAt: AT,
        },
      }),
      draft('run.waiting', {
        run: {
          ...runF,
          status: 'waiting',
          leaseId: null,
          leaseUntil: null,
          deadlineAt: null,
        },
        cardIds: [],
      }),
    ],
    [
      draft('run.queued', {
        run: {
          ...runF,
          status: 'queued',
          turn: 2,
          resumeSessionId: 'sess-f',
          notBefore: '2026-06-06T07:00:00.000Z',
        },
      }),
    ],
  )

  return batches
}

/** 把脚本灌进 store：每次 dispatch 产出一批事实（命令形状合法，决策被假内核覆盖）。 */
function seedStore(db: DatabaseSync, script: FactDraft[][]): ReturnType<typeof createStore> {
  let call = 0
  const kernel = createFakeKernel({
    project,
    viewSpec: () => [...PROJECTION_TABLES],
    decide: () => ({ facts: script[call++] ?? [] }),
  })
  const store = createStore({
    db,
    kernel,
    now: () => AT,
    newId: sequenceIds('rt-1', 'ag-1', 'wf-1', 'st-1', 'tk-1'),
  })
  store.ensureProjection()
  for (let index = 0; index < script.length; index += 1) {
    store.dispatch({ type: 'task.remove', commandId: `script-${index}`, id: 'tk-unknown' })
  }
  return store
}

let openDbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

function memory(): DatabaseSync {
  const db = createMemoryDb()
  openDbs.push(db)
  return db
}

describe('运行/聊天投影：实时写入与重建等价', () => {
  it('随机事实序列：增量投影与 rebuild 后九表逐行全等', () => {
    const db = memory()
    const script = buildScript(20261105)
    const store = seedStore(db, script)

    const incremental = dumpProjection(db)
    expect(countRows(db, 'runs')).toBe(5)
    expect(countRows(db, 'conversations')).toBe(1)
    expect(countRows(db, 'messages')).toBe(2)
    expect(incremental.run_events.length).toBeGreaterThan(0)

    store.rebuild()

    expect(dumpProjection(db)).toEqual(incremental)
    expect(readProjectionMeta(db)).toEqual({
      format: projectionFormat(KERNEL_VERSION),
      seq: store.factsCount(),
    })
    // 再建一次幂等
    store.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
  })

  it('删除 / 等待 / 取消都落成事实描述的行，重建不依赖 SQL 级联', () => {
    const db = memory()
    seedStore(db, buildScript(7))

    const rows = new Map(
      (
        db
          .prepare('SELECT id, status, purpose, task_id, conversation_id, attempts FROM runs')
          .all() as unknown as Array<{
          id: string
          status: string
          purpose: string
          task_id: string | null
          conversation_id: string | null
          attempts: number
        }>
      ).map((row) => [row.id, row]),
    )

    expect([...rows.keys()].sort()).toEqual(['run-a', 'run-b', 'run-c', 'run-e', 'run-f'])
    expect(rows.get('run-a')).toMatchObject({ status: 'succeeded', purpose: 'stage' })
    expect(rows.get('run-b')).toMatchObject({ status: 'failed', attempts: 1 })
    expect(rows.get('run-c')).toMatchObject({
      status: 'succeeded',
      purpose: 'chat',
      task_id: null,
      conversation_id: 'cv-1',
    })
    // 对话删除后历史 run 仍保留 conversationId（事实可重建、不被 FK SET NULL 抹掉）
    expect(rows.get('run-e')).toMatchObject({
      status: 'cancelled',
      conversation_id: 'cv-2',
    })
    expect(rows.get('run-f')).toMatchObject({ status: 'queued' })

    // run-d 被 run.removed：行与它的事件都消失；其它 run 的事件仍在
    expect(countRows(db, 'run_events')).toBeGreaterThan(0)
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'run-d'")
          .get() as unknown as {
          n: number
        }
      ).n,
    ).toBe(0)
  })
})

describe('运行/聊天投影：冲突与联删', () => {
  it('(run_id, seq) 重复：抛唯一约束错误并整体回滚，不覆盖历史', () => {
    const db = memory()
    const script = buildScript(1)
    // 取到第一条 run.frames 为止；再一次派发同一条帧事实，制造主键冲突。
    const frameIndex = script.findIndex((batch) => batch[0]?.type === 'run.frames')
    const prefix = script.slice(0, frameIndex + 1)
    const lastFrame = prefix[prefix.length - 1]?.[0]
    if (lastFrame === undefined) throw new Error('脚本缺少 run.frames 事实')
    expect(lastFrame.type).toBe('run.frames')
    let call = 0
    const kernel = createFakeKernel({
      project,
      decide: () => {
        call += 1
        if (call <= prefix.length) return { facts: prefix[call - 1] }
        return { facts: [lastFrame] }
      },
    })
    const store = createStore({ db, kernel, now: () => AT, newId: () => 'id-1' })
    store.ensureProjection()
    for (let index = 0; index < prefix.length; index += 1) {
      store.dispatch({ type: 'task.remove', commandId: `c-${index}`, id: 'tk-unknown' })
    }

    const factsBefore = store.factsCount()
    const eventsBefore = countRows(db, 'run_events')
    const metaBefore = readProjectionMeta(db)

    const error = captureError(() =>
      store.dispatch({ type: 'task.remove', commandId: 'dup', id: 'tk-unknown' }),
    )

    expect(error.message).toMatch(/UNIQUE constraint failed: run_events\.run_id, run_events\.seq/)
    expect(store.factsCount()).toBe(factsBefore)
    expect(countRows(db, 'run_events')).toBe(eventsBefore)
    expect(readProjectionMeta(db)).toEqual(metaBefore)
  })

  it('run.removed 只删目标 run 的事件，其它 run 的事件保留', () => {
    const db = memory()
    const script: FactDraft[][] = [
      [
        draft('runtime.created', { runtime: sample.runtime() }),
        draft('agent.created', { agent: sample.agent() }),
        draft('workflow.created', { workflow: sample.workflow() }),
        draft('stage.created', { stage: sample.stage() }),
        draft('task.created', { task: sample.task() }),
        draft('run.queued', { run: sample.run({ id: 'run-keep', queueSeq: 0 }) }),
        draft('run.queued', { run: sample.run({ id: 'run-drop', queueSeq: 0 }) }),
      ],
      [
        draft('run.frames', {
          runId: 'run-keep',
          turn: 1,
          frames: [{ runId: 'run-keep', seq: 1, type: 'text', text: 'keep' }],
        }),
        draft('run.frames', {
          runId: 'run-drop',
          turn: 1,
          frames: [{ runId: 'run-drop', seq: 1, type: 'text', text: 'drop' }],
        }),
      ],
      [draft('run.removed', { runId: 'run-drop' })],
    ]
    const store = seedStore(db, script)

    expect(countRows(db, 'runs')).toBe(1)
    expect(countRows(db, 'run_events')).toBe(1)
    expect(
      (db.prepare('SELECT run_id FROM run_events').get() as unknown as { run_id: string }).run_id,
    ).toBe('run-keep')

    const incremental = dumpProjection(db)
    store.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
  })
})

describe('运行/聊天投影：run.frames 多批 / 跨 turn（T12）', () => {
  it('同一 run 跨 turn 的帧 seq 连续、逐条顺序一致，重建后 run_events 逐行全等', () => {
    const db = memory()
    const runRow = sample.run({ id: 'run-frames', queueSeq: 0 })
    const frameFact = (turn: number, frames: Array<{ seq: number; text: string }>): FactDraft =>
      draft('run.frames', {
        runId: 'run-frames',
        turn,
        frames: frames.map((frame) => ({
          runId: 'run-frames',
          seq: frame.seq,
          type: 'text',
          text: frame.text,
        })),
      })
    const script: FactDraft[][] = [
      [
        draft('runtime.created', { runtime: sample.runtime() }),
        draft('agent.created', { agent: sample.agent() }),
        draft('workflow.created', { workflow: sample.workflow() }),
        draft('stage.created', { stage: sample.stage() }),
        draft('task.created', { task: sample.task() }),
        draft('run.queued', { run: runRow }),
        draft('run.claimed', { run: { ...runRow, status: 'running', attempt: 1 } }),
      ],
      // turn 1：两批（2 + 2），seq 1–4
      [
        frameFact(1, [
          { seq: 1, text: 't1-a' },
          { seq: 2, text: 't1-b' },
        ]),
      ],
      [
        frameFact(1, [
          { seq: 3, text: 't1-c' },
          { seq: 4, text: 't1-d' },
        ]),
      ],
      // turn 2：续接后再来两批（3 + 2），seq 5–9 不允许回退
      [draft('run.queued', { run: { ...runRow, status: 'queued', turn: 2 } })],
      [
        frameFact(2, [
          { seq: 5, text: 't2-a' },
          { seq: 6, text: 't2-b' },
          { seq: 7, text: 't2-c' },
        ]),
      ],
      [
        frameFact(2, [
          { seq: 8, text: 't2-d' },
          { seq: 9, text: 't2-e' },
        ]),
      ],
    ]
    const store = seedStore(db, script)

    const rows = db
      .prepare(
        'SELECT run_id, seq, type, payload_json, created_at FROM run_events ORDER BY run_id, seq',
      )
      .all() as unknown as Array<Record<string, unknown>>
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(
      rows.map((row) => (JSON.parse(String(row.payload_json)) as { text: string }).text),
    ).toEqual(['t1-a', 't1-b', 't1-c', 't1-d', 't2-a', 't2-b', 't2-c', 't2-d', 't2-e'])
    expect(rows.every((row) => row.run_id === 'run-frames')).toBe(true)

    const incremental = dumpProjection(db)
    store.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
    expect(
      (
        db
          .prepare(
            'SELECT run_id, seq, type, payload_json, created_at FROM run_events ORDER BY run_id, seq',
          )
          .all() as unknown as Array<Record<string, unknown>>
      ).map((row) => row.seq),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
