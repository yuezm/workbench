// @vitest-environment node
/**
 * 回执字段校验的**逐键**口径（R1）：一个坏键只丢它自己，不连坐同块的其它键。
 *
 * 这条用例集来自一次真实事故：评审智能体同时给了 `ask`（gate-verdict 卡）、
 * `findings`（severity 用了 review skill 的 `Required` / `Optional` / `Nit`）与
 * `deliverables`。旧口径一票否决，整份回执连同 `ask` 一起被丢，任务卡死在闸门。
 */
import { describe, expect, it } from 'vitest'
import { parseReceiptBlock } from '@workbench/plugins-kit/receipt-block'
import { applyReceiptFields, receiptFromObject } from '@workbench/plugins-kit/receipt-fields'
import { parseReceiptToolInput } from '@workbench/plugins-kit/receipt-tool'
import type { Receipt } from '@workbench/protocol/inputs'
import { COMMAND_LIMITS } from '@workbench/protocol/validate'
import { DELIVERABLE_LIMITS } from '@workbench/protocol/entities'

const toolCall = (value: unknown): string => JSON.stringify(value)

/** 事故现场的最小复刻：合法 ask + 合法 deliverables + 7 条非法 severity 的 findings */
const incident = {
  ask: [
    {
      title: '可见标签是否必须逐字「告警值（匹配则告警）」？',
      key: 'gate-verdict',
      text: '验收 1 没过：可见标签只有「告警值」。',
      options: ['同意，按打回走', '我要和你再讨论', '情况有变，直接放行'],
    },
  ],
  deliverables: {
    branch: 'feat/status-bit-alarm-label',
    commits: ['267a059', '1db7f4f'],
    gates: [{ cmd: 'node scripts/verify.mjs', exitCode: 0 }],
  },
  findings: [
    {
      key: 'R1',
      severity: 'Required',
      claim: '可见标签不是需求字面文本',
      requiredAction: '改整串',
    },
    { key: 'O1', severity: 'Optional', claim: '判据写死几何不变', requiredAction: '改写判据' },
    { key: 'N1', severity: 'Nit', claim: '缺用例注释', requiredAction: '补注释' },
  ],
}

describe('receiptFromObject：逐键容错（R1）', () => {
  it('事故回放：findings 非法不再连坐 ask 与 deliverables', () => {
    const parsed = receiptFromObject(incident)
    expect(parsed.block?.ask).toEqual(incident.ask)
    expect(parsed.block?.deliverables).toEqual(incident.deliverables)
    expect(parsed.block?.findings).toBeUndefined()
    expect(parsed.dropped.map((item) => item.key)).toEqual(['findings'])
  })

  it('坏掉的键给得出原因：findings 的 reason 点明 severity 的合法值', () => {
    const parsed = receiptFromObject(incident)
    const reason = parsed.dropped[0]?.reason ?? ''
    expect(reason).toContain('severity')
    expect(reason).toContain('blocker')
  })

  it('坏 checks 不连坐 verdict；坏 verdict 不连坐 checks', () => {
    expect(
      receiptFromObject({ verdict: 'pass', checks: [{ cmd: '', exitCode: 0 }] }),
    ).toMatchObject({
      block: { verdict: 'pass' },
      dropped: [{ key: 'checks' }],
    })
    expect(
      receiptFromObject({ verdict: 'PASS', checks: [{ cmd: 'pnpm check', exitCode: 0 }] }),
    ).toMatchObject({
      block: { checks: [{ cmd: 'pnpm check', exitCode: 0 }] },
      dropped: [{ key: 'verdict' }],
    })
  })

  it('坏 ask 只丢 ask，同块 other 键照常生效', () => {
    const parsed = receiptFromObject({ ask: [{ title: '空选项', options: [] }], notices: ['n'] })
    expect(parsed.block).toEqual({ notices: ['n'] })
    expect(parsed.dropped.map((item) => item.key)).toEqual(['ask'])
  })

  it('一个合法键都没有：block 为 null，但不吞掉 dropped 的原因', () => {
    const parsed = receiptFromObject({ findings: incident.findings, foo: 1 })
    expect(parsed.block).toBeNull()
    expect(parsed.dropped.map((item) => item.key)).toEqual(['findings'])
  })

  it('未知键与 null / undefined 值不算 dropped', () => {
    expect(receiptFromObject({ foo: 1, notices: null })).toEqual({ block: null, dropped: [] })
    expect(receiptFromObject({ notices: ['n'], foo: 1 })).toEqual({
      block: { notices: ['n'] },
      dropped: [],
    })
  })

  it('全合法：dropped 为空', () => {
    const parsed = receiptFromObject({
      verdict: 'fail',
      checks: [{ cmd: 'pnpm check', exitCode: 1 }],
      findings: [{ key: 'R1', severity: 'blocker', claim: 'c', requiredAction: 'a' }],
    })
    expect(parsed.dropped).toEqual([])
    expect(parsed.block?.verdict).toBe('fail')
  })
})

describe('两条传输沿用同一份逐键口径', () => {
  it('文本通道：坏 findings 不连坐 ask 与 deliverables', () => {
    const text = ['```json', JSON.stringify(incident), '```'].join('\n')
    expect(parseReceiptBlock(text)).toMatchObject({
      ask: incident.ask,
      deliverables: incident.deliverables,
    })
  })

  it('工具通道：坏 findings 不连坐 ask 与 deliverables', () => {
    expect(parseReceiptToolInput('mcp__workbench__receipt', toolCall(incident))).toMatchObject({
      ask: incident.ask,
      deliverables: incident.deliverables,
    })
  })

  it('两条通道对同一对象给同一个块', () => {
    const text = ['```json', JSON.stringify(incident), '```'].join('\n')
    expect(parseReceiptBlock(text)).toEqual(
      parseReceiptToolInput('mcp__workbench__receipt', toolCall(incident)),
    )
  })
})

/**
 * M28 的 `deliverables` 此前只写在提示词与工具 schema 里，kit 侧的解析与 `applyReceiptFields`
 * 都没有这个键——模型每次都交了，`runs.deliverables_json` 却永远是 null。这里钉住链路。
 */
describe('deliverables：声明了就要进 Receipt', () => {
  const deliverables = {
    branch: 'feat/status-bit-alarm-label',
    base: 'develop',
    commits: ['267a059'],
    files: ['src/a.ts'],
    gates: [{ cmd: 'node scripts/verify.mjs', exitCode: 0 }],
  }

  const receiptOf = (): Receipt => ({
    status: 'succeeded',
    leaseId: 'lease-1',
    turn: 1,
    output: '',
  })

  it('合法交付物解析进块，applyReceiptFields 写进 Receipt', () => {
    const parsed = receiptFromObject({ deliverables })
    expect(parsed.block?.deliverables).toEqual(deliverables)
    expect(parsed.dropped).toEqual([])

    const receipt = receiptOf()
    applyReceiptFields(receipt, parsed.block as NonNullable<typeof parsed.block>)
    expect(receipt.deliverables).toEqual(deliverables)
  })

  it('只声明部分项也收（缺项由内核 normalizeDeliverables 补齐）', () => {
    expect(receiptFromObject({ deliverables: { branch: 'feat/x' } }).block?.deliverables).toEqual({
      branch: 'feat/x',
    })
  })

  it('形状非法只丢 deliverables，同块其它键照常', () => {
    for (const bad of [
      'not-object',
      { commits: 'abc' },
      { commits: ['x'.repeat(DELIVERABLE_LIMITS.maxChars + 1)] },
      {
        commits: Array.from({ length: DELIVERABLE_LIMITS.maxCommits + 1 }, (_, i) => `c${i}`),
      },
      { gates: [{ cmd: '', exitCode: 0 }] },
      { gates: [{ cmd: 'pnpm check', exitCode: '0' }] },
      {
        gates: Array.from({ length: COMMAND_LIMITS.gateChecks + 1 }, () => ({
          cmd: 'pnpm check',
          exitCode: 0,
        })),
      },
    ]) {
      const parsed = receiptFromObject({ deliverables: bad, notices: ['同块照常生效'] })
      expect(parsed.block).toEqual({ notices: ['同块照常生效'] })
      expect(parsed.dropped.map((item) => item.key)).toEqual(['deliverables'])
    }
  })
})
