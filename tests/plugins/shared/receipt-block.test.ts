// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { applyReceiptBlock, parseReceiptBlock } from '../../../src/plugins/shared/receipt-block'
import type { Receipt } from '../../../src/protocol/inputs'
import { COMMAND_LIMITS } from '../../../src/protocol/validate'

/** 造一个围栏块（默认 json 标签） */
const fence = (content: string, tag = 'json'): string => ['```' + tag, content, '```'].join('\n')

/** 把对象塞进围栏块 */
const blockOf = (value: unknown): string => fence(JSON.stringify(value))

/** 合法 ask 夹具 */
const askOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: '选一个',
  text: '用哪个方案？',
  options: ['A', 'B'],
  key: 'plan',
  ...over,
})

/** 合法事件夹具 */
const eventOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: 'agent',
  type: 'issues.opened',
  subject: 'issue-1',
  summary: '发现新问题',
  ...over,
})

const receiptOf = (over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: 'lease-1',
  turn: 1,
  output: '原文',
  ...over,
})

describe('parseReceiptBlock：围栏扫描', () => {
  it('多块取最后一块（前面的块被忽略）', () => {
    const text = [
      '先给结论。',
      blockOf({ notices: ['第一块'] }),
      '中间说明',
      blockOf({ notices: ['第二块'] }),
      '结束',
    ].join('\n')
    expect(parseReceiptBlock(text)).toEqual({ notices: ['第二块'] })
  })

  it('标签大小写不敏感（```JSON）', () => {
    expect(parseReceiptBlock(fence('{"notices":["大写"]}', 'JSON'))).toEqual({
      notices: ['大写'],
    })
  })

  it('非 json 围栏、未闭合围栏、没有围栏都不识别', () => {
    expect(parseReceiptBlock(fence('{"notices":["ts"]}', 'ts'))).toBeNull()
    expect(parseReceiptBlock(['```json', '{"notices":["没闭合"]}'].join('\n'))).toBeNull()
    expect(parseReceiptBlock('普通文本 {"notices":["没围栏"]}')).toBeNull()
    expect(parseReceiptBlock('')).toBeNull()
  })

  it('最后一块是非法 JSON：直接 null，不回退到更早的合法块', () => {
    expect(parseReceiptBlock(fence('{坏 JSON'))).toBeNull()
    const text = [blockOf({ notices: ['早先的合法块'] }), fence('{坏 JSON')].join('\n')
    expect(parseReceiptBlock(text)).toBeNull()
  })

  it('最后一块能解析但不是对象：null，不回退到更早的对象块', () => {
    const text = [blockOf({ notices: ['早先'] }), blockOf([1, 2])].join('\n')
    expect(parseReceiptBlock(text)).toBeNull()
  })

  it('最后一块不含五键：null，不回退到更早的回执块', () => {
    const text = [blockOf({ notices: ['上一轮陈旧回执'] }), blockOf({ foo: 1 })].join('\n')
    expect(parseReceiptBlock(text)).toBeNull()
  })

  it('非对象（数组 / null / 字符串 / 数字）一律 null', () => {
    for (const raw of ['[]', 'null', '"text"', '42', 'true']) {
      expect(parseReceiptBlock(fence(raw))).toBeNull()
    }
  })
})

describe('parseReceiptBlock：键与字段', () => {
  it('五键齐全时原样返回五个字段，未知键忽略', () => {
    const block = {
      ask: [askOf()],
      notices: ['已完成依赖安装'],
      resolves: ['card-0'],
      later: '2026-11-06T09:00:00.000Z',
      events: [eventOf()],
      unknown: '忽略我',
    }
    expect(parseReceiptBlock(blockOf(block))).toEqual({
      ask: [askOf()],
      notices: ['已完成依赖安装'],
      resolves: ['card-0'],
      later: '2026-11-06T09:00:00.000Z',
      events: [eventOf()],
    })
  })

  it('五键全无：null', () => {
    expect(parseReceiptBlock(blockOf({ foo: 1 }))).toBeNull()
    expect(parseReceiptBlock(blockOf({}))).toBeNull()
  })

  it('spawn：合法子任务原样返回；空标题 / 批次越界 / 条数超限整块忽略', () => {
    const spawn = [
      {
        subject: '实现登录页',
        summary: '含表单与校验',
        stageId: 'st-1',
        batch: 1,
        key: 'login',
      },
    ]
    expect(parseReceiptBlock(blockOf({ spawn }))).toEqual({ spawn })
    expect(parseReceiptBlock(blockOf({ spawn: [], notices: ['x'] }))).toEqual({ notices: ['x'] })
    expect(parseReceiptBlock(blockOf({ spawn: null, notices: ['x'] }))).toEqual({
      notices: ['x'],
    })
    for (const bad of [
      [{ subject: '   ' }],
      [{ subject: 'x', batch: 0 }],
      [{ subject: 'x', batch: COMMAND_LIMITS.spawnBatchMax + 1 }],
      [{ subject: 'x', batch: 1.5 }],
      [{ subject: 'x', summary: 'y'.repeat(COMMAND_LIMITS.description + 1) }],
      [{ subject: 'x', key: 'k'.repeat(COMMAND_LIMITS.id + 1) }],
      [{ subject: 'x', stageId: 's'.repeat(COMMAND_LIMITS.id + 1) }],
      ['not-object'],
    ]) {
      expect(parseReceiptBlock(blockOf({ spawn: bad, notices: ['同块也不能生效'] }))).toBeNull()
    }
    expect(parseReceiptBlock(blockOf({ spawn: 'not-array' }))).toBeNull()
    const tooMany = Array.from({ length: COMMAND_LIMITS.spawnItems + 1 }, (_, i) => ({
      subject: `子任务${i}`,
    }))
    expect(parseReceiptBlock(blockOf({ spawn: tooMany }))).toBeNull()
  })

  it('null / 空数组视为未提供；只剩空字段时无回执', () => {
    expect(parseReceiptBlock(blockOf({ ask: null, notices: ['x'] }))).toEqual({ notices: ['x'] })
    expect(parseReceiptBlock(blockOf({ resolves: [], notices: ['x'] }))).toEqual({
      notices: ['x'],
    })
    expect(parseReceiptBlock(blockOf({ ask: [], notices: [], events: [] }))).toBeNull()
  })

  it('ask 选项为空 / 条数超限 / 标题超限 / 选项超限：整块忽略（连累同块 notices）', () => {
    const tooManyOptions = Array.from(
      { length: COMMAND_LIMITS.askOptions + 1 },
      (_, i) => `选项${i}`,
    )
    const titleTooLong = 'x'.repeat(COMMAND_LIMITS.title + 1)
    for (const ask of [
      askOf({ options: [] }),
      askOf({ options: tooManyOptions }),
      askOf({ title: titleTooLong }),
      askOf({ options: ['A', ''] }),
      askOf({ title: '   ' }),
    ]) {
      const text = blockOf({ ask: [ask], notices: ['同块有效字段也不能生效'] })
      expect(parseReceiptBlock(text)).toBeNull()
    }
  })

  it('ask 条数超限 / 非对象项 / text、key 超限：整块忽略', () => {
    const asks = Array.from({ length: COMMAND_LIMITS.receiptItems + 1 }, () => askOf())
    for (const ask of [
      askOf({ text: 'x'.repeat(COMMAND_LIMITS.description + 1) }),
      askOf({ key: 'k'.repeat(COMMAND_LIMITS.id + 1) }),
      askOf({ options: 'not-array' }),
    ]) {
      expect(parseReceiptBlock(blockOf({ ask: [ask] }))).toBeNull()
    }
    expect(parseReceiptBlock(blockOf({ ask: asks }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ ask: ['not-object'] }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ ask: 'not-array' }))).toBeNull()
  })

  it('notices 非数组 / 超限 / 空文案：整块忽略', () => {
    expect(parseReceiptBlock(blockOf({ notices: 'x' }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ notices: ['  '] }))).toBeNull()
    expect(
      parseReceiptBlock(blockOf({ notices: ['x'.repeat(COMMAND_LIMITS.description + 1)] })),
    ).toBeNull()
    expect(
      parseReceiptBlock(
        blockOf({ notices: Array.from({ length: COMMAND_LIMITS.receiptItems + 1 }, () => 'x') }),
      ),
    ).toBeNull()
  })

  it('resolves 非数组 / 超限 / 空 id：整块忽略', () => {
    expect(parseReceiptBlock(blockOf({ resolves: 'card-0' }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ resolves: [''] }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ resolves: ['x'.repeat(COMMAND_LIMITS.id + 1)] }))).toBeNull()
    expect(
      parseReceiptBlock(
        blockOf({ resolves: Array.from({ length: COMMAND_LIMITS.receiptItems + 1 }, () => 'c') }),
      ),
    ).toBeNull()
  })

  it('later 非字符串 / 空串 / 非 ISO 时间：整块忽略', () => {
    expect(parseReceiptBlock(blockOf({ later: 123 }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ later: '' }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ later: '明天上午' }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ later: '2026-11-06T09:00:00.000Z' }))).toEqual({
      later: '2026-11-06T09:00:00.000Z',
    })
  })

  it('events 字段逐项校验：任一项非法整块忽略', () => {
    const invalid = [
      { source: '' },
      { type: '' },
      { subject: '' },
      { summary: 'x'.repeat(COMMAND_LIMITS.summary + 1) },
      { detail: 1 },
      { link: 'x'.repeat(COMMAND_LIMITS.workdir + 1) },
      { dedupeKey: 'x'.repeat(COMMAND_LIMITS.id + 1) },
    ]
    for (const over of invalid) {
      expect(parseReceiptBlock(blockOf({ events: [eventOf(over)] }))).toBeNull()
    }
    expect(parseReceiptBlock(blockOf({ events: ['not-object'] }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ events: 'not-array' }))).toBeNull()
    expect(
      parseReceiptBlock(
        blockOf({
          events: Array.from({ length: COMMAND_LIMITS.receiptItems + 1 }, () => eventOf()),
        }),
      ),
    ).toBeNull()
  })

  it('可选字段可以缺省：带 detail/link/dedupeKey 的完整事件', () => {
    const event = eventOf({
      detail: '全文',
      link: 'https://example.test/1',
      dedupeKey: 'issue-1',
    })
    expect(parseReceiptBlock(blockOf({ events: [event] }))).toEqual({ events: [event] })
  })
})

describe('parseReceiptBlock：闸门判定（M11）', () => {
  it('verdict + checks 原样返回（fail 允许非 0 退出码）', () => {
    const checks = [
      { cmd: 'git tag', exitCode: 0 },
      { cmd: 'npm whoami', exitCode: 1 },
    ]
    expect(parseReceiptBlock(blockOf({ verdict: 'fail', checks }))).toEqual({
      verdict: 'fail',
      checks,
    })
  })

  it('只带 verdict 也算回执块（闸门只给结论时不丢块）', () => {
    expect(parseReceiptBlock(blockOf({ verdict: 'pass' }))).toEqual({ verdict: 'pass' })
  })

  it('只带 checks 也算回执块（结论缺省交给内核判「没给结论」）', () => {
    const checks = [{ cmd: 'pnpm check', exitCode: 0 }]
    expect(parseReceiptBlock(blockOf({ checks }))).toEqual({ checks })
  })

  it('verdict 不是 pass / fail：整块忽略', () => {
    for (const verdict of ['PASS', '未通过', '', 1, true, {}]) {
      expect(parseReceiptBlock(blockOf({ verdict, notices: ['同块也不能生效'] }))).toBeNull()
    }
  })

  it('checks 非数组 / 条数超限 / cmd 为空或超长 / 退出码非整数或越界：整块忽略', () => {
    const badChecks = [
      'not-array',
      [{ cmd: '  ', exitCode: 0 }],
      [{ cmd: 'x'.repeat(COMMAND_LIMITS.gateCmd + 1), exitCode: 0 }],
      [{ cmd: 'pnpm check', exitCode: '0' }],
      [{ cmd: 'pnpm check', exitCode: 1.5 }],
      [{ cmd: 'pnpm check', exitCode: 1_000_001 }],
      [{ cmd: 'pnpm check', exitCode: -1_000_001 }],
      [{ exitCode: 0 }],
      ['not-object'],
    ]
    for (const checks of badChecks) {
      expect(parseReceiptBlock(blockOf({ checks, notices: ['同块也不能生效'] }))).toBeNull()
    }
    const tooMany = Array.from({ length: COMMAND_LIMITS.gateChecks + 1 }, () => ({
      cmd: 'pnpm check',
      exitCode: 0,
    }))
    expect(parseReceiptBlock(blockOf({ checks: tooMany }))).toBeNull()
  })

  it('checks 空数组视为未提供：不连累同块 verdict', () => {
    expect(parseReceiptBlock(blockOf({ verdict: 'fail', checks: [] }))).toEqual({
      verdict: 'fail',
    })
    expect(parseReceiptBlock(blockOf({ verdict: 'fail', checks: null }))).toEqual({
      verdict: 'fail',
    })
  })

  it('与其余键同块时都解析', () => {
    const checks = [{ cmd: 'git status --short', exitCode: 0 }]
    expect(parseReceiptBlock(blockOf({ verdict: 'fail', checks, notices: ['未给量级'] }))).toEqual({
      verdict: 'fail',
      checks,
      notices: ['未给量级'],
    })
  })
})

describe('applyReceiptBlock：执行器接线口径', () => {
  it('解析成功：只补六个字段，output 原文不动', () => {
    const text = blockOf({
      ask: [askOf()],
      notices: ['n'],
      resolves: ['card-0'],
      later: '2026-11-06T09:00:00.000Z',
      events: [eventOf()],
      spawn: [{ subject: '子任务', key: 'k' }],
    })
    const receipt = receiptOf({ output: text })
    applyReceiptBlock(receipt, text)

    expect(receipt.output).toBe(text)
    expect(receipt.status).toBe('succeeded')
    expect(receipt.ask).toEqual([askOf()])
    expect(receipt.notices).toEqual(['n'])
    expect(receipt.resolves).toEqual(['card-0'])
    expect(receipt.later).toBe('2026-11-06T09:00:00.000Z')
    expect(receipt.events).toEqual([eventOf()])
    expect(receipt.spawn).toEqual([{ subject: '子任务', key: 'k' }])
  })

  it('闸门判定：verdict 与 checks 写进回执（其余字段保持未提供）', () => {
    const checks = [{ cmd: 'git tag', exitCode: 0 }]
    const text = blockOf({ verdict: 'fail', checks })
    const receipt = receiptOf({ output: text })
    applyReceiptBlock(receipt, text)

    expect(receipt.verdict).toBe('fail')
    expect(receipt.checks).toEqual(checks)
    expect(receipt.ask).toBeUndefined()
    expect(receipt.notices).toBeUndefined()
    expect(receipt.later).toBeUndefined()
  })

  it('只带部分字段：只补出现的字段，其余保持未提供', () => {
    const text = blockOf({ notices: ['n'] })
    const receipt = receiptOf({ output: text })
    applyReceiptBlock(receipt, text)

    expect(receipt.notices).toEqual(['n'])
    expect(receipt.ask).toBeUndefined()
    expect(receipt.resolves).toBeUndefined()
    expect(receipt.later).toBeUndefined()
    expect(receipt.events).toBeUndefined()
    expect(receipt.spawn).toBeUndefined()
  })

  it('只带 later 时其它四个字段保持未提供', () => {
    const text = blockOf({ later: '2026-11-06T09:00:00.000Z' })
    const receipt = receiptOf({ output: text })
    applyReceiptBlock(receipt, text)

    expect(receipt.later).toBe('2026-11-06T09:00:00.000Z')
    expect(receipt.ask).toBeUndefined()
    expect(receipt.notices).toBeUndefined()
    expect(receipt.resolves).toBeUndefined()
    expect(receipt.events).toBeUndefined()
    expect(receipt.spawn).toBeUndefined()
  })

  it('解析失败：不写任何字段，终态与 output 保持原样', () => {
    const text = fence('{"ask": 1}')
    const receipt = receiptOf({ status: 'failed', output: text, error: '原始错误' })
    applyReceiptBlock(receipt, text)

    expect(receipt).toEqual({
      status: 'failed',
      leaseId: 'lease-1',
      turn: 1,
      output: text,
      error: '原始错误',
    })
  })

  it('notes（M6.5）：合法笔记解析并写进回执；单独 notes 也算回执块', () => {
    const text = blockOf({ notes: ['先跑测试', '注意工作树'] })
    expect(parseReceiptBlock(text)).toEqual({ notes: ['先跑测试', '注意工作树'] })
    const receipt = receiptOf({ output: text })
    applyReceiptBlock(receipt, text)
    expect(receipt.notes).toEqual(['先跑测试', '注意工作树'])
    expect(receipt.ask).toBeUndefined()
  })

  it('notes 非法：空文本 / 超长 / 超条数 → 整块忽略', () => {
    expect(parseReceiptBlock(blockOf({ notes: ['  '] }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ notes: ['x'.repeat(2001)] }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ notes: Array.from({ length: 101 }, () => 'x') }))).toBeNull()
  })

  it('notes 为空数组：不算回执块（其余键也没有时返回 null）', () => {
    expect(parseReceiptBlock(blockOf({ notes: [] }))).toBeNull()
  })

  it('notes 与另一键同时出现时都解析（六键口径）', () => {
    const text = blockOf({ notices: ['完成'], notes: ['资料'] })
    expect(parseReceiptBlock(text)).toEqual({ notices: ['完成'], notes: ['资料'] })
  })
})

describe('parseReceiptBlock：评审键与废弃的验收自评键（M14 / M34）', () => {
  /** 合法待改项夹具 */
  const findingOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    key: 'R1',
    severity: 'blocker',
    location: 'src/a.ts:42',
    claim: '越界下标没有校验',
    requiredAction: '复跑 pnpm check 且不红即算修好',
    ...over,
  })

  /** 合法处置夹具 */
  const addressOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    findingId: 'rpt-1#R1',
    disposition: 'fixed',
    checkRef: 'pnpm check',
    ...over,
  })

  it('findings：合法清单原样返回；单独 findings 也算回执块', () => {
    expect(parseReceiptBlock(blockOf({ findings: [findingOf()] }))).toEqual({
      findings: [findingOf()],
    })
    // 提示词里有、解析器不认，评审硬门就永远触发不了
    expect(parseReceiptBlock(blockOf({ findings: [findingOf()], notices: ['n'] }))).toEqual({
      findings: [findingOf()],
      notices: ['n'],
    })
  })

  it('findings 非法：缺必填 / severity 不认 / 小标重复 / 超条数 → 整块忽略', () => {
    for (const bad of [
      [{ ...findingOf(), key: '  ' }],
      [{ ...findingOf(), severity: 'critical' }],
      [{ ...findingOf(), claim: '' }],
      [{ ...findingOf(), requiredAction: '' }],
      [findingOf(), findingOf()],
      Array.from({ length: 201 }, (_, index) => findingOf({ key: `R${index}` })),
    ]) {
      expect(parseReceiptBlock(blockOf({ findings: bad }))).toBeNull()
    }
    expect(parseReceiptBlock(blockOf({ findings: [], notices: ['n'] }))).toEqual({ notices: ['n'] })
  })

  it('addresses：fixed 带 checkRef、rejected / deferred 带 note 才认', () => {
    const ok = [
      addressOf(),
      addressOf({ findingId: 'rpt-1#R2', disposition: 'deferred', note: '下轮再改' }),
    ]
    expect(parseReceiptBlock(blockOf({ addresses: ok }))).toEqual({ addresses: ok })
    for (const bad of [
      [addressOf({ checkRef: '' })],
      [addressOf({ checkRef: undefined })],
      [addressOf({ disposition: 'rejected' })],
      [addressOf({ disposition: 'done' })],
      [addressOf({ findingId: '' })],
      Array.from({ length: 201 }, (_, index) =>
        addressOf({ findingId: `rpt-1#R${index}`, disposition: 'rejected', note: '不改' }),
      ),
    ]) {
      expect(parseReceiptBlock(blockOf({ addresses: bad }))).toBeNull()
    }
    expect(parseReceiptBlock(blockOf({ addresses: [], notices: ['n'] }))).toEqual({
      notices: ['n'],
    })
  })

  // M34：回执键 `acceptance` 已删除（执行阶段不再自评）。老执行器残留这个键时整键忽略，
  // 同块其它键照常生效——一块里混着废弃键不该让整块失效。
  it('acceptance 键出现即忽略：同块 verdict / checks 仍生效', () => {
    expect(
      parseReceiptBlock(
        blockOf({
          verdict: 'pass',
          checks: [{ cmd: 'pnpm check', exitCode: 0 }],
          acceptance: [{ no: 1, met: false, evidence: '早已废弃的自评' }],
        }),
      ),
    ).toEqual({ verdict: 'pass', checks: [{ cmd: 'pnpm check', exitCode: 0 }] })
    // 形状再离谱也一样忽略：它已不是可校验的字段
    expect(
      parseReceiptBlock(blockOf({ acceptance: [{ no: 0, met: 'yes' }], notices: ['n'] })),
    ).toEqual({
      notices: ['n'],
    })
  })

  it('只有 acceptance 键：不算回执块（没有可用键 → null）', () => {
    expect(parseReceiptBlock(blockOf({ acceptance: [{ no: 1, met: true }] }))).toBeNull()
    expect(parseReceiptBlock(blockOf({ acceptance: [] }))).toBeNull()
  })

  // M34：闸门逐条给证据——`checks[].acceptance` 是 1 基序号，可省略（环境检查）
  it('checks[].acceptance：1–12 的整数原样保留，可省略', () => {
    const checks = [
      { cmd: 'pnpm check', exitCode: 0, acceptance: 1 },
      { cmd: 'pnpm lint', exitCode: 0, acceptance: 12 },
      { cmd: 'git status --short', exitCode: 0 },
    ]
    expect(parseReceiptBlock(blockOf({ verdict: 'pass', checks }))).toEqual({
      verdict: 'pass',
      checks,
    })
  })

  it('checks[].acceptance 非法（非整数 / 越界 / 字符串）：整块忽略', () => {
    for (const acceptance of [0, 13, 1.5, '1', true, {}]) {
      expect(
        parseReceiptBlock(
          blockOf({
            verdict: 'pass',
            checks: [{ cmd: 'pnpm check', exitCode: 0, acceptance }],
            notices: ['同块也不能生效'],
          }),
        ),
      ).toBeNull()
    }
    // null 视为未提供
    expect(
      parseReceiptBlock(
        blockOf({
          verdict: 'pass',
          checks: [{ cmd: 'pnpm check', exitCode: 0, acceptance: null }],
        }),
      ),
    ).toEqual({ verdict: 'pass', checks: [{ cmd: 'pnpm check', exitCode: 0, acceptance: null }] })
  })

  it('applyReceiptBlock：评审两键写进回执，output 与终态不动', () => {
    const text = blockOf({
      findings: [findingOf()],
      addresses: [addressOf()],
    })
    const receipt = receiptOf({ output: text })
    applyReceiptBlock(receipt, text)

    expect(receipt.output).toBe(text)
    expect(receipt.status).toBe('succeeded')
    expect(receipt.findings).toEqual([findingOf()])
    expect(receipt.addresses).toEqual([addressOf()])
    expect(Object.hasOwn(receipt, 'acceptance')).toBe(false)
  })

  it('非对象条目 / 超长字段：整块忽略（不把半截清单送进内核）', () => {
    for (const bad of [
      { findings: ['R1'] },
      { findings: [findingOf({ location: 'x'.repeat(301) })] },
      { findings: [findingOf({ evidence: 'x'.repeat(2001) })] },
      { addresses: ['rpt-1#R1'] },
      { addresses: [addressOf({ checkRef: 'x'.repeat(501) })] },
      { addresses: [addressOf({ disposition: 'deferred', note: 'x'.repeat(501) })] },
    ]) {
      expect(parseReceiptBlock(blockOf(bad))).toBeNull()
    }
  })

  // M34：`acceptance` 键已从回执口径里删除，老执行器还写它时整块不成立，什么都不写
  it('applyReceiptBlock：只剩废弃的 acceptance 键时不改回执', () => {
    const text = blockOf({ acceptance: [{ no: 1, met: false }] })
    const receipt = receiptOf({ output: text })
    applyReceiptBlock(receipt, text)

    expect(Object.hasOwn(receipt, 'acceptance')).toBe(false)
    expect(receipt.findings).toBeUndefined()
    expect(receipt.addresses).toBeUndefined()
    expect(receipt.output).toBe(text)
  })
})
