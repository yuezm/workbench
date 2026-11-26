// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ACCEPT_MODES,
  ADMISSION_CELLS,
  ADMISSION_REASONS,
  AUTHORITY_LIMITS,
  DEFAULT_ADMISSION_TABLE,
  IDENTITY_KINDS,
  compatAuthority,
  isAcceptMode,
  isAdmissionCell,
  isIdentityKind,
  normalizeAdmissionTable,
  normalizeAuthority,
  normalizeSourcePolicy,
} from '@workbench/protocol/authority'

describe('authority 契约常量', () => {
  it('接受模式只有三档', () => {
    expect(ACCEPT_MODES).toEqual(['off', 'observe', 'auto'])
  })

  it('准入单元格只有三种取值', () => {
    expect(ADMISSION_CELLS).toEqual(['explicit', 'inferred', 'ignore'])
  })

  it('身份种类只有三种', () => {
    expect(IDENTITY_KINDS).toEqual(['human', 'bot', 'system'])
  })

  it('拒绝原因沿用规格里的五个码', () => {
    expect(ADMISSION_REASONS).toEqual([
      'not-listed',
      'mode-off',
      'bot-not-listed',
      'no-rule',
      'assess-failed',
    ])
  })

  it('上限与规格一致', () => {
    expect(AUTHORITY_LIMITS).toEqual({
      sources: 32,
      identitiesPerSource: 200,
      sourceId: 64,
      identityId: 128,
      assessBatchMin: 1,
      assessBatchMax: 20,
      assessWindowMsMax: 60_000,
    })
  })
})

describe('DEFAULT_ADMISSION_TABLE', () => {
  it('缺省值按 SPEC-authority §准入表', () => {
    expect(DEFAULT_ADMISSION_TABLE).toEqual({
      listedAddressed: 'explicit',
      listedUnaddressed: 'inferred',
      unlistedAddressed: 'ignore',
      unlistedUnaddressed: 'ignore',
      botAddressed: 'inferred',
    })
  })
})

describe('compatAuthority', () => {
  it('规则集没有 authority 块时退化为今日行为：auto、无来源策略', () => {
    expect(compatAuthority()).toEqual({
      mode: 'auto',
      sources: [],
      assessorAgentId: null,
      assessBatch: 8,
      assessWindowMs: 5000,
    })
  })

  it('每次返回独立副本，调用方改它不影响下一次', () => {
    const first = compatAuthority()
    first.sources.push({
      id: 'github',
      allowed: ['octocat'],
      bots: [],
      receiveAll: false,
      admission: { ...DEFAULT_ADMISSION_TABLE },
    })
    expect(compatAuthority().sources).toEqual([])
  })
})

describe('枚举判断', () => {
  it.each([
    ['off', true],
    ['observe', true],
    ['auto', true],
    ['compat', false],
    ['', false],
  ])('isAcceptMode(%s) = %s', (value, expected) => {
    expect(isAcceptMode(value)).toBe(expected)
  })

  it('isAdmissionCell 只认三档', () => {
    expect(isAdmissionCell('explicit')).toBe(true)
    expect(isAdmissionCell('inferred')).toBe(true)
    expect(isAdmissionCell('ignore')).toBe(true)
    expect(isAdmissionCell('allow')).toBe(false)
  })

  it('isIdentityKind 只认三类', () => {
    expect(isIdentityKind('human')).toBe(true)
    expect(isIdentityKind('bot')).toBe(true)
    expect(isIdentityKind('system')).toBe(true)
    expect(isIdentityKind('agent')).toBe(false)
  })
})

describe('normalizeAdmissionTable', () => {
  it('空值与非法值都回落到缺省', () => {
    expect(normalizeAdmissionTable(undefined)).toEqual(DEFAULT_ADMISSION_TABLE)
    expect(normalizeAdmissionTable({ listedAddressed: 'allow' })).toEqual(DEFAULT_ADMISSION_TABLE)
  })

  it('合法单元格原样保留', () => {
    expect(
      normalizeAdmissionTable({
        listedAddressed: 'inferred',
        listedUnaddressed: 'ignore',
        unlistedAddressed: 'explicit',
        unlistedUnaddressed: 'inferred',
        botAddressed: 'ignore',
      }),
    ).toEqual({
      listedAddressed: 'inferred',
      listedUnaddressed: 'ignore',
      unlistedAddressed: 'explicit',
      unlistedUnaddressed: 'inferred',
      botAddressed: 'ignore',
    })
  })

  it('部分给值时只补缺的那几格', () => {
    expect(normalizeAdmissionTable({ unlistedAddressed: 'explicit' })).toEqual({
      ...DEFAULT_ADMISSION_TABLE,
      unlistedAddressed: 'explicit',
    })
  })
})

describe('normalizeSourcePolicy', () => {
  it('没有 id 的来源被丢弃', () => {
    expect(normalizeSourcePolicy({})).toBeNull()
    expect(normalizeSourcePolicy({ id: '   ' })).toBeNull()
    expect(normalizeSourcePolicy('github')).toBeNull()
  })

  it('id 去空白并截到上限', () => {
    const long = 'x'.repeat(AUTHORITY_LIMITS.sourceId + 10)
    expect(normalizeSourcePolicy({ id: `  ${long}  ` })?.id).toBe(
      long.slice(0, AUTHORITY_LIMITS.sourceId),
    )
  })

  it('名单去空白、去空项、去重，并截到上限', () => {
    const many = Array.from({ length: AUTHORITY_LIMITS.identitiesPerSource + 5 }, (_, i) => `u${i}`)
    const policy = normalizeSourcePolicy({ id: 'github', allowed: [' a ', 'a', '', 'b', ...many] })
    expect(policy?.allowed.slice(0, 4)).toEqual(['a', 'b', 'u0', 'u1'])
    expect(policy?.allowed).toHaveLength(AUTHORITY_LIMITS.identitiesPerSource)
  })

  it('名单项超出单条长度上限时丢弃', () => {
    const tooLong = 'y'.repeat(AUTHORITY_LIMITS.identityId + 1)
    expect(normalizeSourcePolicy({ id: 'github', allowed: [tooLong, 'ok'] })?.allowed).toEqual([
      'ok',
    ])
  })

  it('名单里的非字符串项直接跳过（历史行 / 手改配置可能混进数字）', () => {
    const policy = normalizeSourcePolicy({
      id: 'github',
      allowed: [42, null, { id: 'x' }, 'octocat'],
      bots: [true, 'bot_1'],
    })
    expect(policy?.allowed).toEqual(['octocat'])
    expect(policy?.bots).toEqual(['bot_1'])
  })

  it('名单不是数组时为空', () => {
    const policy = normalizeSourcePolicy({ id: 'github', allowed: 'octocat' })
    expect(policy?.allowed).toEqual([])
    expect(policy?.bots).toEqual([])
  })

  it('receiveAll 缺省 false，非布尔按 false', () => {
    expect(normalizeSourcePolicy({ id: 'github' })?.receiveAll).toBe(false)
    expect(normalizeSourcePolicy({ id: 'github', receiveAll: 'yes' })?.receiveAll).toBe(false)
    expect(normalizeSourcePolicy({ id: 'github', receiveAll: true })?.receiveAll).toBe(true)
  })

  it('admission 缺省为默认表', () => {
    expect(normalizeSourcePolicy({ id: 'github' })?.admission).toEqual(DEFAULT_ADMISSION_TABLE)
  })
})

describe('normalizeAuthority', () => {
  it('非对象回落到兼容模式', () => {
    expect(normalizeAuthority(undefined)).toEqual(compatAuthority())
    expect(normalizeAuthority(null)).toEqual(compatAuthority())
    expect(normalizeAuthority('off')).toEqual(compatAuthority())
  })

  it('未知模式回落到 auto', () => {
    expect(normalizeAuthority({ mode: 'compat' }).mode).toBe('auto')
    expect(normalizeAuthority({ mode: 'observe' }).mode).toBe('observe')
  })

  it('来源按 id 去重并截到上限', () => {
    const many = Array.from({ length: AUTHORITY_LIMITS.sources + 3 }, (_, i) => ({ id: `s${i}` }))
    const authority = normalizeAuthority({
      mode: 'auto',
      sources: [{ id: 'github' }, { id: 'github' }, { id: 'feishu' }, ...many],
    })
    expect(authority.sources[0]?.id).toBe('github')
    expect(authority.sources[1]?.id).toBe('feishu')
    expect(authority.sources).toHaveLength(AUTHORITY_LIMITS.sources)
  })

  it('来源不是数组时为空', () => {
    expect(normalizeAuthority({ sources: 'github' }).sources).toEqual([])
  })

  it('研判智能体只收非空字符串', () => {
    expect(normalizeAuthority({ assessorAgentId: '  ' }).assessorAgentId).toBeNull()
    expect(normalizeAuthority({ assessorAgentId: 7 }).assessorAgentId).toBeNull()
    expect(normalizeAuthority({ assessorAgentId: ' judge ' }).assessorAgentId).toBe('judge')
  })

  it('assessBatch 越界与小数回落到 8', () => {
    expect(normalizeAuthority({ assessBatch: 0 }).assessBatch).toBe(8)
    expect(normalizeAuthority({ assessBatch: 21 }).assessBatch).toBe(8)
    expect(normalizeAuthority({ assessBatch: 2.5 }).assessBatch).toBe(8)
    expect(normalizeAuthority({ assessBatch: 20 }).assessBatch).toBe(20)
    expect(normalizeAuthority({ assessBatch: 1 }).assessBatch).toBe(1)
  })

  it('assessWindowMs 越界回落到 5000，0 合法', () => {
    expect(normalizeAuthority({ assessWindowMs: -1 }).assessWindowMs).toBe(5000)
    expect(normalizeAuthority({ assessWindowMs: 60_001 }).assessWindowMs).toBe(5000)
    expect(normalizeAuthority({ assessWindowMs: 0 }).assessWindowMs).toBe(0)
    expect(normalizeAuthority({ assessWindowMs: 60_000 }).assessWindowMs).toBe(60_000)
  })

  it('完整输入原样归一', () => {
    expect(
      normalizeAuthority({
        mode: 'observe',
        assessorAgentId: 'judge',
        assessBatch: 5,
        assessWindowMs: 1000,
        sources: [
          {
            id: 'feishu',
            allowed: ['ou_1'],
            bots: ['bot_1'],
            receiveAll: true,
            admission: { listedAddressed: 'explicit' },
          },
        ],
      }),
    ).toEqual({
      mode: 'observe',
      assessorAgentId: 'judge',
      assessBatch: 5,
      assessWindowMs: 1000,
      sources: [
        {
          id: 'feishu',
          allowed: ['ou_1'],
          bots: ['bot_1'],
          receiveAll: true,
          admission: DEFAULT_ADMISSION_TABLE,
        },
      ],
    })
  })
})
