import { describe, expect, it } from 'vitest'
import { COMMAND_NAMES, type Command } from '../../src/protocol/commands'
import { EXECUTOR_PORT_VERSION } from '../../src/protocol/executor'
import {
  HOST_INPUT_NAMES,
  INPUT_NAMES,
  type HostInput,
  type HostInputName,
  type Input,
  type InputName,
} from '../../src/protocol/inputs'
import { validateCommand, validateInput } from '../../src/protocol/validate'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/** `Input` 的判别键恰好覆盖 `INPUT_NAMES`；命令是它的子集。 */
const unionChecks: [
  Assert<Equal<Input['type'], InputName>>,
  Assert<Equal<HostInput['type'], HostInputName>>,
  Assert<Equal<Extract<Input, Command>, Command>>,
  Assert<Equal<InputName, Command['type'] | HostInputName>>,
] = [true, true, true, true]

const validInputs: Input[] = [
  { type: 'run.claim', runtimeId: 'rt-1', capacity: 2 },
  { type: 'run.heartbeat', runId: 'run-1', leaseId: 'run-1:1' },
  {
    type: 'run.receipt',
    runId: 'run-1',
    receipt: {
      status: 'succeeded',
      leaseId: 'run-1:1',
      turn: 1,
      output: '完成',
      sessionId: 'sess-1',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      notices: ['提示'],
      resolves: ['card-1'],
      later: '2026-11-05T00:00:00.000Z',
      ask: [{ title: '选择', text: '正文', options: ['A', 'B'], key: 'k-1' }],
      events: [
        {
          source: 'dsh',
          type: 'issues.opened',
          subject: 'issue-1',
          summary: '摘要',
          detail: '全文',
          link: 'https://example.com/1',
          dedupeKey: 'k',
        },
      ],
      errorCode: 'run_failed',
      exitCode: 1,
      durationMs: 10,
      resumeRejected: true,
    },
  },
  { type: 'run.host_settled', runId: 'run-1', status: 'cancelled', errorCode: 'cancelled' },
  { type: 'run.host_settled', runId: 'run-1', leaseId: 'run-1:1', turn: 1, status: 'failed' },
  { type: 'run.cancel', runId: 'run-1' },
  { type: 'clock.tick' },
  { type: 'conversation.create', agentId: 'ag-1', title: '新对话' },
  { type: 'conversation.send', conversationId: 'cv-1', content: '你好' },
  { type: 'conversation.rename', conversationId: 'cv-1', title: '标题' },
  { type: 'conversation.remove', conversationId: 'cv-1' },
]

/** 只取失败文案；先用断言固定 `ok=false`，避免分支未覆盖。 */
const rejected = (input: unknown): string => {
  const result = validateInput(input)
  expect(result.ok).toBe(false)
  return (result as { ok: false; message: string }).message
}

const host = (type: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  type,
  ...fields,
})

const longText = (n: number): string => 'x'.repeat(n)

describe('protocol/inputs', () => {
  it('输入名全集 = 命令名 + 宿主内部输入名，互不重叠且顺序稳定', () => {
    expect([...HOST_INPUT_NAMES]).toEqual([
      'run.claim',
      'run.heartbeat',
      'run.receipt',
      'run.host_settled',
      'run.cancel',
      'clock.tick',
      'conversation.create',
      'conversation.send',
      'conversation.rename',
      'conversation.remove',
    ])
    expect([...INPUT_NAMES]).toEqual([...COMMAND_NAMES, ...HOST_INPUT_NAMES])
    expect(new Set(INPUT_NAMES).size).toBe(INPUT_NAMES.length)
    for (const name of HOST_INPUT_NAMES) {
      expect((COMMAND_NAMES as readonly string[]).includes(name)).toBe(false)
    }
  })

  it('输入名都是小写点分，拼写与事实命名风格一致', () => {
    for (const name of INPUT_NAMES) expect(name).toMatch(/^[a-z]+\.[a-z_]+$/)
  })

  it('Input 判别联合与名称常量一一对应；命令是其子集', () => {
    expect(unionChecks.every(Boolean)).toBe(true)
  })

  it('宿主内部输入全部通过校验，并原样返回（不裁剪、不补默认值）', () => {
    for (const input of validInputs) {
      expect(validateInput(input)).toEqual({ ok: true, input })
    }
  })

  it('命令走同一个入口：结果与 validateCommand 一致', () => {
    const command: Command = { type: 'task.remove', commandId: 'c-1', id: 't-1' }
    expect(validateInput(command)).toEqual({ ok: true, input: command })
    expect(validateCommand(command)).toEqual({ ok: true, command })
  })

  it('拒绝非对象与未知输入名', () => {
    for (const input of [null, 42, 'clock.tick', []]) {
      expect(rejected(input)).toBe('输入必须是对象')
    }
    expect(rejected({})).toBe('未知输入: undefined')
    expect(rejected({ type: 42 })).toBe('未知输入: 42')
    expect(rejected({ type: 'run.nope' })).toBe('未知输入: run.nope')
  })

  it('run.claim：runtimeId 必填、capacity 1–8 的整数', () => {
    expect(rejected(host('run.claim', { capacity: 1 }))).toBe('runtimeId必填')
    expect(rejected(host('run.claim', { runtimeId: 'rt-1' }))).toBe('capacity必须是整数')
    expect(rejected(host('run.claim', { runtimeId: 'rt-1', capacity: 1.5 }))).toBe(
      'capacity必须是整数',
    )
    expect(rejected(host('run.claim', { runtimeId: 'rt-1', capacity: 0 }))).toBe(
      'capacity必须在 1 到 8 之间',
    )
    expect(rejected(host('run.claim', { runtimeId: 'rt-1', capacity: 9 }))).toBe(
      'capacity必须在 1 到 8 之间',
    )
  })

  it('run.heartbeat：runId 与 leaseId 必填', () => {
    expect(rejected(host('run.heartbeat', { leaseId: 'run-1:1' }))).toBe('runId必填')
    expect(rejected(host('run.heartbeat', { runId: 'run-1' }))).toBe('leaseId必填')
    expect(rejected(host('run.heartbeat', { runId: 'run-1', leaseId: longText(201) }))).toBe(
      'leaseId最长 200 个字符',
    )
  })

  it('run.receipt：runId 与 receipt 的必填项（含 D15 的 leaseId/turn）', () => {
    expect(rejected(host('run.receipt', {}))).toBe('runId必填')
    expect(rejected(host('run.receipt', { runId: 'run-1' }))).toBe('receipt 必须是对象')
    expect(rejected(host('run.receipt', { runId: 'run-1', receipt: {} }))).toBe(
      'receipt.status必填',
    )
    expect(
      rejected(
        host('run.receipt', { runId: 'run-1', receipt: { status: 'running', leaseId: 'l' } }),
      ),
    ).toBe('receipt.status取值必须是 succeeded / failed / cancelled')
    expect(
      rejected(host('run.receipt', { runId: 'run-1', receipt: { status: 'succeeded' } })),
    ).toBe('receipt.leaseId必填')
    expect(
      rejected(
        host('run.receipt', {
          runId: 'run-1',
          receipt: { status: 'succeeded', leaseId: 'run-1:1' },
        }),
      ),
    ).toBe('receipt.turn必须是整数')
    expect(
      rejected(
        host('run.receipt', {
          runId: 'run-1',
          receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 0 },
        }),
      ),
    ).toBe('receipt.turn必须在 1 到 1000000 之间')
  })

  it('run.receipt：可选字段逐项校验', () => {
    const base = { status: 'succeeded', leaseId: 'run-1:1', turn: 1 }
    const withReceipt = (patch: Record<string, unknown>): Record<string, unknown> =>
      host('run.receipt', { runId: 'run-1', receipt: { ...base, ...patch } })

    expect(rejected(withReceipt({ output: 7 }))).toBe('receipt.output必须是字符串')
    expect(rejected(withReceipt({ sessionId: 7 }))).toBe('receipt.sessionId必须是字符串')
    expect(rejected(withReceipt({ error: 7 }))).toBe('receipt.error必须是字符串')
    expect(rejected(withReceipt({ usage: 'x' }))).toBe('receipt.usage 必须是对象')
    expect(rejected(withReceipt({ usage: { inputTokens: -1 } }))).toBe(
      'receipt.usage.inputTokens必须在 0 到 1000000000000 之间',
    )
    expect(rejected(withReceipt({ ask: 'x' }))).toBe('receipt.ask 必须是数组')
    expect(rejected(withReceipt({ ask: [{}] }))).toBe('receipt.ask[0].title必填')
    expect(rejected(withReceipt({ ask: [{ title: 't', options: 'x' }] }))).toBe(
      'receipt.ask[0].options 必须是数组',
    )
    expect(rejected(withReceipt({ ask: [{ title: 't', options: [''] }] }))).toBe(
      'receipt.ask[0].options[0]必填',
    )
    expect(rejected(withReceipt({ notices: [7] }))).toBe('receipt.notices[0]必须是字符串')
    expect(rejected(withReceipt({ resolves: [''] }))).toBe('receipt.resolves[0]必填')
    expect(rejected(withReceipt({ later: 7 }))).toBe('receipt.later必须是字符串')
    expect(rejected(withReceipt({ events: 'x' }))).toBe('receipt.events 必须是数组')
    expect(rejected(withReceipt({ events: [{}] }))).toBe('receipt.events[0].source必填')
    expect(rejected(withReceipt({ errorCode: 'nope' }))).toBe(
      'receipt.errorCode取值必须是 spawn_failed / exit_nonzero / run_failed / timeout / cancelled / protocol_error / no_result / runtime_missing / runtime_disabled / executor_lost',
    )
    expect(rejected(withReceipt({ exitCode: 'x' }))).toBe('receipt.exitCode必须是整数')
    expect(rejected(withReceipt({ durationMs: -1 }))).toBe(
      'receipt.durationMs必须在 0 到 86400000 之间',
    )
    expect(rejected(withReceipt({ resumeRejected: 'yes' }))).toBe(
      'receipt.resumeRejected必须是布尔值',
    )
    expect(
      rejected(withReceipt({ ask: Array.from({ length: 101 }, () => ({ title: 't' })) })),
    ).toBe('receipt.ask 最多 100 项')
  })

  it('run.host_settled：仅宿主可发的兜底终态（status 必填、errorCode 枚举）', () => {
    expect(rejected(host('run.host_settled', { status: 'failed' }))).toBe('runId必填')
    expect(rejected(host('run.host_settled', { runId: 'run-1' }))).toBe('status必填')
    expect(rejected(host('run.host_settled', { runId: 'run-1', status: 'running' }))).toBe(
      'status取值必须是 succeeded / failed / cancelled',
    )
    expect(
      rejected(host('run.host_settled', { runId: 'run-1', status: 'failed', errorCode: 'nope' })),
    ).toContain('errorCode取值必须是')
    expect(rejected(host('run.host_settled', { runId: 'run-1', status: 'failed', turn: 0 }))).toBe(
      'turn必须在 1 到 1000000 之间',
    )
    expect(
      rejected(host('run.host_settled', { runId: 'run-1', status: 'failed', leaseId: '' })),
    ).toBe('leaseId必填')
  })

  it('run.cancel / clock.tick：run.cancel 必填 runId，clock.tick 无字段要求', () => {
    expect(rejected(host('run.cancel', {}))).toBe('runId必填')
    expect(validateInput({ type: 'clock.tick', extra: 1 })).toEqual({
      ok: true,
      input: { type: 'clock.tick', extra: 1 },
    })
  })

  it('conversation.*：引用与正文/标题形状', () => {
    expect(rejected(host('conversation.create', {}))).toBe('agentId必填')
    expect(rejected(host('conversation.create', { agentId: 'ag-1', title: 7 }))).toBe(
      'title必须是字符串',
    )
    expect(rejected(host('conversation.send', { content: 'x' }))).toBe('conversationId必填')
    expect(rejected(host('conversation.send', { conversationId: 'cv-1' }))).toBe('content必填')
    expect(
      rejected(host('conversation.send', { conversationId: 'cv-1', content: longText(20_001) })),
    ).toBe('content最长 20000 个字符')
    expect(rejected(host('conversation.rename', { conversationId: 'cv-1' }))).toBe('title必填')
    expect(rejected(host('conversation.rename', { title: 't' }))).toBe('conversationId必填')
    expect(rejected(host('conversation.remove', {}))).toBe('conversationId必填')
  })

  it('执行器端口版本常量随契约暴露（M3 兼容判断用）', () => {
    expect(EXECUTOR_PORT_VERSION).toBe(1)
  })
})
