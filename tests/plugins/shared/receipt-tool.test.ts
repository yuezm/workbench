// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseReceiptBlock } from '../../../src/plugins/shared/receipt-block'
import {
  parseReceiptToolInput,
  RECEIPT_TOOL_NAMES,
  receiptToolDefinition,
} from '../../../src/plugins/shared/receipt-tool'
import { RECEIPT_KEYS } from '../../../src/protocol/receipt-keys'

/** 一个各键齐全的合法回执对象 */
const fullReceipt = {
  ask: [{ title: '选一个', text: '用哪个方案？', options: ['A', 'B'], key: 'plan' }],
  notices: ['依赖已装好'],
  resolves: ['card-0'],
  later: '2026-11-06T09:00:00.000Z',
  events: [{ source: 'agent', type: 'issues.opened', subject: 'issue-1', summary: '新问题' }],
  spawn: [{ subject: '实现登录页', summary: '含校验', stageId: 'st-2', key: 'login' }],
  notes: ['先跑测试再提交'],
  verdict: 'fail',
  checks: [{ cmd: 'pnpm check', exitCode: 1 }],
  findings: [
    {
      key: 'R1',
      severity: 'blocker',
      location: 'src/a.ts:42',
      claim: '越界没校验',
      requiredAction: '复跑 pnpm check 不红即算修好',
    },
  ],
  addresses: [{ findingId: 'rpt-1#R1', disposition: 'deferred', note: '下轮再改' }],
}

const toolCall = (value: unknown): string => JSON.stringify(value)

describe('receiptToolDefinition', () => {
  it('工具名取自常量；schema 的键与 RECEIPT_KEYS 同源', () => {
    const definition = receiptToolDefinition()
    expect(definition.name).toBe('receipt')
    const properties = definition.inputSchema.properties as Record<string, unknown>
    expect(Object.keys(properties)).toEqual([...RECEIPT_KEYS])
    // 未知键不该让整次调用失败（校验层本来就会忽略）
    expect(definition.inputSchema.additionalProperties).toBe(true)
  })

  it('verdict 只认 pass / fail；其余键给到类型', () => {
    const properties = receiptToolDefinition().inputSchema.properties as Record<
      string,
      { type?: string; enum?: string[] }
    >
    expect(properties.verdict).toMatchObject({ type: 'string', enum: ['pass', 'fail'] })
    for (const key of ['ask', 'notices', 'resolves', 'events', 'spawn', 'notes']) {
      expect(properties[key].type).toBe('array')
    }
    expect(properties.later.type).toBe('string')
  })
})

describe('parseReceiptToolInput', () => {
  it('两种公开名都认：workbench.receipt / mcp__workbench__receipt', () => {
    for (const name of RECEIPT_TOOL_NAMES) {
      expect(parseReceiptToolInput(name, toolCall({ notices: ['工具回执'] }))).toEqual({
        notices: ['工具回执'],
      })
    }
  })

  it('不认识的工具名 / 缺参数 / 空参数：null（不猜前缀，不把别的工具当回执）', () => {
    for (const name of [
      'receipt',
      'workbench.receipts',
      'mcp__other__receipt',
      'workbench.receipt.extra',
      undefined,
    ]) {
      expect(parseReceiptToolInput(name, toolCall({ notices: ['n'] }))).toBeNull()
    }
    expect(parseReceiptToolInput('workbench.receipt', undefined)).toBeNull()
    expect(parseReceiptToolInput('workbench.receipt', '   ')).toBeNull()
  })

  it('参数不是 JSON / 不是对象 / 字段非法：null（整块忽略，交给文本通道）', () => {
    expect(parseReceiptToolInput('workbench.receipt', '{坏 JSON')).toBeNull()
    expect(parseReceiptToolInput('workbench.receipt', '[1,2]')).toBeNull()
    expect(parseReceiptToolInput('workbench.receipt', 'null')).toBeNull()
    expect(parseReceiptToolInput('workbench.receipt', toolCall({ ask: 1 }))).toBeNull()
    expect(parseReceiptToolInput('workbench.receipt', toolCall({ verdict: 'maybe' }))).toBeNull()
    // 十一键全无（只有未知键）也算没有回执
    expect(parseReceiptToolInput('workbench.receipt', toolCall({ foo: 1 }))).toBeNull()
  })

  it('键齐全时全量解析（含 M14 的评审键）', () => {
    const block = parseReceiptToolInput('workbench.receipt', toolCall(fullReceipt))
    expect(block).toEqual(fullReceipt)
  })

  // M34：`acceptance` 已从回执键里删除，工具通道同样整键忽略，同块其它键照常生效
  it('废弃的 acceptance 键被忽略，不连累同块 verdict', () => {
    expect(
      parseReceiptToolInput(
        'workbench.receipt',
        toolCall({
          verdict: 'pass',
          checks: [{ cmd: 'pnpm check', exitCode: 0, acceptance: 1 }],
          acceptance: [{ no: 1, met: true }],
        }),
      ),
    ).toEqual({ verdict: 'pass', checks: [{ cmd: 'pnpm check', exitCode: 0, acceptance: 1 }] })
  })

  it('两条传输同口径：同一对象的工具解析与围栏解析结果一致', () => {
    const fence = ['```json', JSON.stringify(fullReceipt), '```'].join('\n')
    expect(parseReceiptToolInput('workbench.receipt', toolCall(fullReceipt))).toEqual(
      parseReceiptBlock(fence),
    )
  })
})
