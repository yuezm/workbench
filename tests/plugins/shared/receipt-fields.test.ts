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
import { receiptFromObject } from '@workbench/plugins-kit/receipt-fields'
import { parseReceiptToolInput } from '@workbench/plugins-kit/receipt-tool'

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
  it('事故回放：findings 非法不再连坐 ask', () => {
    const parsed = receiptFromObject(incident)
    expect(parsed.block?.ask).toEqual(incident.ask)
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
  it('文本通道：坏 findings 不连坐 ask', () => {
    const text = ['```json', JSON.stringify(incident), '```'].join('\n')
    expect(parseReceiptBlock(text)?.ask).toEqual(incident.ask)
  })

  it('工具通道：坏 findings 不连坐 ask', () => {
    expect(parseReceiptToolInput('mcp__workbench__receipt', toolCall(incident))?.ask).toEqual(
      incident.ask,
    )
  })

  it('两条通道对同一对象给同一个块', () => {
    const text = ['```json', JSON.stringify(incident), '```'].join('\n')
    expect(parseReceiptBlock(text)).toEqual(
      parseReceiptToolInput('mcp__workbench__receipt', toolCall(incident)),
    )
  })
})
