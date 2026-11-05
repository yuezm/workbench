import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../src/protocol/entities'
import type { Receipt, Turn } from '../../src/protocol/executor'
import {
  WORKER_FRAME_TYPES,
  WORKER_PROTOCOL_VERSION,
  encodeWorkerFrame,
  parseWorkerFrame,
  type HostToWorkerFrame,
  type WorkerClaim,
} from '../../src/protocol/worker'

/**
 * 远端 Worker 协议形状（M7 架构位）：只测纯函数编解码，不碰网络与进程。
 * 帧的两个方向分开：worker → 宿主走 `parseWorkerFrame`，宿主 → worker 走 `encodeWorkerFrame`。
 */
const claim: WorkerClaim = {
  runId: 'run-1',
  leaseId: 'run-1:1',
  turn: 1,
  leaseUntil: '2026-11-05T22:00:00.000Z',
}

const turn: Turn = {
  runId: 'run-1',
  leaseId: 'run-1:1',
  turn: 1,
  purpose: 'stage',
  prompt: '只回复 OK',
  cwd: 'C:/work',
  access: 'edit',
  timeoutMs: 60_000,
  signal: new AbortController().signal,
}

const event: RunEvent = { seq: 1, type: 'text', text: '处理中' }

const receipt: Receipt = { status: 'succeeded', leaseId: 'run-1:1', turn: 1, output: 'ok' }

/** 一行 JSON 文本（parseWorkerFrame 的入参形态） */
const lineOf = (value: unknown): string => JSON.stringify(value)

describe('protocol/worker：版本与帧类型', () => {
  it('协议版本固定为 1', () => {
    expect(WORKER_PROTOCOL_VERSION).toBe(1)
  })

  it('帧类型全集为 hello/claim/heartbeat/event/receipt/cancel', () => {
    expect(WORKER_FRAME_TYPES).toEqual([
      'hello',
      'claim',
      'heartbeat',
      'event',
      'receipt',
      'cancel',
    ])
  })
})

describe('parseWorkerFrame：合法帧', () => {
  it('hello：worker 身份与执行器键原样解析（键可以为空）', () => {
    const frame = parseWorkerFrame(
      lineOf({
        v: 1,
        type: 'hello',
        worker: { id: 'w-1', name: '构建机', executorKeys: ['dsh', 'command'] },
      }),
    )
    expect(frame).toEqual({
      v: 1,
      type: 'hello',
      worker: { id: 'w-1', name: '构建机', executorKeys: ['dsh', 'command'] },
    })

    expect(
      parseWorkerFrame(
        lineOf({ v: 1, type: 'hello', worker: { id: 'w-2', name: '空', executorKeys: [] } }),
      ),
    ).toMatchObject({ type: 'hello', worker: { executorKeys: [] } })
  })

  it('hello：未知字段被裁剪（只回契约字段）', () => {
    const frame = parseWorkerFrame(
      lineOf({
        v: 1,
        type: 'hello',
        worker: { id: 'w-1', name: '构建机', executorKeys: [], extra: 'ignored' },
        noise: true,
      }),
    )
    expect(frame).toEqual({
      v: 1,
      type: 'hello',
      worker: { id: 'w-1', name: '构建机', executorKeys: [] },
    })
  })

  it('heartbeat：租约四字段原样解析', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'heartbeat', claim }))).toEqual({
      v: 1,
      type: 'heartbeat',
      claim,
    })
  })

  it('event：runId 与运行事件原样解析', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'event', runId: 'run-1', event }))).toEqual({
      v: 1,
      type: 'event',
      runId: 'run-1',
      event,
    })
  })

  it('receipt：runId 与回执原样解析', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'receipt', runId: 'run-1', receipt }))).toEqual({
      v: 1,
      type: 'receipt',
      runId: 'run-1',
      receipt,
    })
  })
})

describe('parseWorkerFrame：非法 / 未知帧返回 null', () => {
  it('不是 JSON 文本', () => {
    expect(parseWorkerFrame('not-json')).toBeNull()
    expect(parseWorkerFrame('')).toBeNull()
  })

  it('JSON 不是对象（null / 数组 / 标量）', () => {
    expect(parseWorkerFrame('null')).toBeNull()
    expect(parseWorkerFrame('[]')).toBeNull()
    expect(parseWorkerFrame('42')).toBeNull()
    expect(parseWorkerFrame('"hello"')).toBeNull()
  })

  it('版本不符或缺失', () => {
    expect(parseWorkerFrame(lineOf({ v: 2, type: 'hello', worker: {} }))).toBeNull()
    expect(parseWorkerFrame(lineOf({ v: '1', type: 'hello', worker: {} }))).toBeNull()
    expect(parseWorkerFrame(lineOf({ type: 'hello', worker: {} }))).toBeNull()
  })

  it('hello：worker 非对象 / id 非法 / name 非法 / executorKeys 非法', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'hello', worker: 'w' }))).toBeNull()
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'hello' }))).toBeNull()
    expect(
      parseWorkerFrame(
        lineOf({ v: 1, type: 'hello', worker: { id: 1, name: 'n', executorKeys: [] } }),
      ),
    ).toBeNull()
    expect(
      parseWorkerFrame(
        lineOf({ v: 1, type: 'hello', worker: { id: '', name: 'n', executorKeys: [] } }),
      ),
    ).toBeNull()
    expect(
      parseWorkerFrame(
        lineOf({ v: 1, type: 'hello', worker: { id: 'w', name: 1, executorKeys: [] } }),
      ),
    ).toBeNull()
    expect(
      parseWorkerFrame(
        lineOf({ v: 1, type: 'hello', worker: { id: 'w', name: '', executorKeys: [] } }),
      ),
    ).toBeNull()
    expect(
      parseWorkerFrame(
        lineOf({ v: 1, type: 'hello', worker: { id: 'w', name: 'n', executorKeys: 'dsh' } }),
      ),
    ).toBeNull()
    expect(
      parseWorkerFrame(
        lineOf({ v: 1, type: 'hello', worker: { id: 'w', name: 'n', executorKeys: ['dsh', 1] } }),
      ),
    ).toBeNull()
  })

  it('heartbeat：claim 非对象 / 字段缺失或类型错', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'heartbeat', claim: 'c' }))).toBeNull()
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'heartbeat' }))).toBeNull()
    for (const broken of [
      { ...claim, runId: 1 },
      { ...claim, leaseId: 1 },
      { ...claim, turn: '1' },
      { ...claim, leaseUntil: 1 },
    ]) {
      expect(parseWorkerFrame(lineOf({ v: 1, type: 'heartbeat', claim: broken }))).toBeNull()
    }
  })

  it('event：runId 非字符串 / event 非对象', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'event', runId: 1, event }))).toBeNull()
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'event', runId: 'run-1', event: 'x' }))).toBeNull()
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'event', runId: 'run-1' }))).toBeNull()
  })

  it('receipt：runId 非字符串 / receipt 非对象', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'receipt', runId: 1, receipt }))).toBeNull()
    expect(
      parseWorkerFrame(lineOf({ v: 1, type: 'receipt', runId: 'run-1', receipt: 'x' })),
    ).toBeNull()
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'receipt', runId: 'run-1' }))).toBeNull()
  })

  it('宿主 → worker 的帧（claim / cancel）不解析为 worker 帧', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'claim', claim, turn }))).toBeNull()
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'cancel', runId: 'run-1' }))).toBeNull()
  })

  it('未知帧类型', () => {
    expect(parseWorkerFrame(lineOf({ v: 1, type: 'log', line: 'x' }))).toBeNull()
  })
})

describe('encodeWorkerFrame：宿主 → worker', () => {
  it('claim 帧编码成单行 JSONL，可被 JSON.parse 还原', () => {
    const frame: HostToWorkerFrame = { v: 1, type: 'claim', claim, turn }
    const encoded = encodeWorkerFrame(frame)

    expect(encoded.endsWith('\n')).toBe(true)
    // 单行：去掉唯一的行尾换行后不再含换行
    expect(encoded.slice(0, -1)).not.toContain('\n')
    expect(encoded).toBe(JSON.stringify(frame) + '\n')
    const parsed = JSON.parse(encoded) as {
      v: number
      type: string
      claim: WorkerClaim
      turn: Turn
    }
    expect(parsed.v).toBe(WORKER_PROTOCOL_VERSION)
    expect(parsed.type).toBe('claim')
    expect(parsed.claim).toEqual(claim)
    // `Turn.signal` 不是 JSON 字段（序列化后为空对象），只断言可传输字段
    expect(parsed.turn).toMatchObject({
      runId: 'run-1',
      leaseId: 'run-1:1',
      turn: 1,
      prompt: '只回复 OK',
    })
  })

  it('cancel 帧编码成单行 JSONL', () => {
    const frame: HostToWorkerFrame = { v: 1, type: 'cancel', runId: 'run-1' }
    const encoded = encodeWorkerFrame(frame)

    expect(encoded).toBe(JSON.stringify(frame) + '\n')
    expect(JSON.parse(encoded)).toEqual(frame)
  })
})
