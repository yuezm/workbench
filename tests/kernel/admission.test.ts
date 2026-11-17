// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ADMISSION_TABLE,
  type AcceptMode,
  type AdmissionTable,
  type Authority,
  type EventIdentity,
  type SourcePolicy,
} from '@workbench/protocol/authority'
import { admit } from '@workbench/kernel/scopes/admission'

/** 一条默认来源策略：允许 octocat、机器人 dependabot、不接收未点名消息。 */
const sourcePolicy = (over: Partial<SourcePolicy> = {}): SourcePolicy => ({
  id: 'github',
  allowed: ['octocat'],
  bots: ['dependabot[bot]'],
  receiveAll: false,
  admission: { ...DEFAULT_ADMISSION_TABLE },
  ...over,
})

const configured = (
  mode: AcceptMode,
  over: Partial<SourcePolicy> = {},
  admission?: Partial<AdmissionTable>,
): Authority => {
  const base = sourcePolicy(over)
  return {
    mode,
    sources: [{ ...base, admission: { ...base.admission, ...admission } }],
    assessorAgentId: null,
    assessBatch: 8,
    assessWindowMs: 5000,
  }
}

const human = (id = 'octocat', addressed = true): EventIdentity => ({
  kind: 'human',
  id,
  addressed,
})
const bot = (id = 'dependabot[bot]', addressed = true): EventIdentity => ({
  kind: 'bot',
  id,
  addressed,
})

describe('admit — 兼容模式（规则集没有 authority 块）', () => {
  it('有身份也全部 explicit 接单', () => {
    expect(admit({ source: 'github', identity: human() }, null)).toEqual({
      allow: true,
      strength: 'explicit',
      basis: 'manual',
    })
  })

  it('没有身份（老宿主）照旧接单', () => {
    expect(admit({ source: 'github' }, null)).toEqual({
      allow: true,
      strength: 'explicit',
      basis: 'manual',
    })
  })
})

describe('admit — 来源与身份', () => {
  it('未列入 sources 的来源被拒为 not-listed', () => {
    expect(admit({ source: 'feishu', identity: human() }, configured('auto'))).toEqual({
      allow: false,
      reason: 'not-listed',
    })
  })

  it('system 身份（手工 / app / 派生）恒接单', () => {
    expect(
      admit(
        { source: 'github', identity: { kind: 'system', id: 'unknown', addressed: true } },
        configured('off'),
      ),
    ).toEqual({ allow: true, strength: 'explicit', basis: 'manual' })
  })

  it('没有身份但来源已配置：按 system 处理', () => {
    expect(admit({ source: 'github' }, configured('off'))).toEqual({
      allow: true,
      strength: 'explicit',
      basis: 'manual',
    })
  })
})

describe('admit — 名单内、点名（三档模式一致）', () => {
  it.each(['off', 'observe', 'auto'] as const)('%s：explicit + basis=addressed', (mode) => {
    expect(admit({ source: 'github', identity: human() }, configured(mode))).toEqual({
      allow: true,
      strength: 'explicit',
      basis: 'addressed',
    })
  })

  it('准入表把这一格降成 ignore 时拒绝', () => {
    expect(
      admit(
        { source: 'github', identity: human() },
        configured('auto', {}, { listedAddressed: 'ignore' }),
      ),
    ).toEqual({ allow: false, reason: 'not-listed' })
  })
})

describe('admit — 名单内、未点名', () => {
  it('receiveAll=false：未点名一律拒绝（事件必须点名）', () => {
    expect(
      admit({ source: 'github', identity: human('octocat', false) }, configured('auto')),
    ).toEqual({ allow: false, reason: 'not-listed' })
  })

  it('receiveAll=true + inferred 格：off 拒绝为 mode-off', () => {
    expect(
      admit(
        { source: 'github', identity: human('octocat', false) },
        configured('off', { receiveAll: true }),
      ),
    ).toEqual({ allow: false, reason: 'mode-off' })
  })

  it.each(['observe', 'auto'] as const)('receiveAll=true + inferred 格：%s 允许推断', (mode) => {
    expect(
      admit(
        { source: 'github', identity: human('octocat', false) },
        configured(mode, { receiveAll: true }),
      ),
    ).toEqual({ allow: true, strength: 'inferred', basis: 'table' })
  })

  it('receiveAll=true + explicit 格：off 也接单', () => {
    expect(
      admit(
        { source: 'github', identity: human('octocat', false) },
        configured('off', { receiveAll: true }, { listedUnaddressed: 'explicit' }),
      ),
    ).toEqual({ allow: true, strength: 'explicit', basis: 'table' })
  })
})

describe('admit — 名单外', () => {
  it('点名但缺省格是 ignore：三种模式都拒', () => {
    for (const mode of ['off', 'observe', 'auto'] as const) {
      expect(admit({ source: 'github', identity: human('stranger') }, configured(mode))).toEqual({
        allow: false,
        reason: 'not-listed',
      })
    }
  })

  it('点名 + 准入表给 explicit：off 也接单，basis=table', () => {
    expect(
      admit(
        { source: 'github', identity: human('stranger') },
        configured('off', {}, { unlistedAddressed: 'explicit' }),
      ),
    ).toEqual({ allow: true, strength: 'explicit', basis: 'table' })
  })

  it('点名 + 准入表给 inferred：off 拒绝，auto 允许', () => {
    const authority = configured('auto', {}, { unlistedAddressed: 'inferred' })
    expect(
      admit({ source: 'github', identity: human('stranger') }, { ...authority, mode: 'off' }),
    ).toEqual({ allow: false, reason: 'mode-off' })
    expect(admit({ source: 'github', identity: human('stranger') }, authority)).toEqual({
      allow: true,
      strength: 'inferred',
      basis: 'table',
    })
  })

  it('未点名 + receiveAll + 缺省 ignore：拒绝', () => {
    expect(
      admit(
        { source: 'github', identity: human('stranger', false) },
        configured('auto', { receiveAll: true }),
      ),
    ).toEqual({ allow: false, reason: 'not-listed' })
  })

  it('未点名 + receiveAll + inferred：按表判定', () => {
    expect(
      admit(
        { source: 'github', identity: human('stranger', false) },
        configured('auto', { receiveAll: true }, { unlistedUnaddressed: 'inferred' }),
      ),
    ).toEqual({ allow: true, strength: 'inferred', basis: 'table' })
  })
})

describe('admit — 机器人', () => {
  it('不在 bots 名单：拒绝为 bot-not-listed（不论模式）', () => {
    for (const mode of ['off', 'observe', 'auto'] as const) {
      expect(admit({ source: 'github', identity: bot('renovate[bot]') }, configured(mode))).toEqual(
        {
          allow: false,
          reason: 'bot-not-listed',
        },
      )
    }
  })

  it('在 bots 名单 + inferred 格：off 拒绝为 mode-off', () => {
    expect(admit({ source: 'github', identity: bot() }, configured('off'))).toEqual({
      allow: false,
      reason: 'mode-off',
    })
  })

  it.each(['observe', 'auto'] as const)(
    '在 bots 名单 + inferred 格：%s 允许，basis=bot',
    (mode) => {
      expect(admit({ source: 'github', identity: bot() }, configured(mode))).toEqual({
        allow: true,
        strength: 'inferred',
        basis: 'bot',
      })
    },
  )

  it('在 bots 名单但该格被设成 explicit：off 也接单，basis=bot', () => {
    expect(
      admit(
        { source: 'github', identity: bot() },
        configured('off', {}, { botAddressed: 'explicit' }),
      ),
    ).toEqual({ allow: true, strength: 'explicit', basis: 'bot' })
  })

  it('在 bots 名单但该格被设成 ignore：拒绝', () => {
    expect(
      admit(
        { source: 'github', identity: bot() },
        configured('auto', {}, { botAddressed: 'ignore' }),
      ),
    ).toEqual({ allow: false, reason: 'not-listed' })
  })

  it('机器人不看点名：未点名也按 botAddressed 判', () => {
    expect(
      admit({ source: 'github', identity: bot('dependabot[bot]', false) }, configured('auto')),
    ).toEqual({ allow: true, strength: 'inferred', basis: 'bot' })
  })
})
