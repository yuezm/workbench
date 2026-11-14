// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { mergePluginSetting, validatePluginSettings } from '../../src/kernel/scopes/plugins'
import { project } from '../../src/kernel/scopes/project'
import type { Environment, Limits, View } from '../../src/kernel/core/types'
import type { PluginSetting } from '../../src/protocol/plugins'

const NOW = '2026-11-05T10:00:00.000Z'

const LIMITS: Limits = {
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 300_000,
  backoffCapMs: 3_600_000,
  runTimeoutMs: 1_800_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
}

const env = (): Environment => {
  const counters = new Map<string, number>()
  return {
    timezone: 'UTC',
    limits: LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
  }
}

const setting = (over: Partial<PluginSetting> = {}): PluginSetting => ({
  id: 'webhook',
  kind: 'source',
  enabled: true,
  granted: ['net'],
  config: { port: 47615, path: '/webhook' },
  ...over,
})

const view = (seed: { settings?: PluginSetting[]; version?: number } = {}): View => ({
  seq: 1,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  events: new Map(),
  ruleSkips: [],
  activeTaskIds: new Set(),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: seed.settings ?? [],
  pluginSettingsVersion: seed.version ?? 0,
})

describe('decide: plugins.replace（M7 插件设置）', () => {
  it('整批保存产 plugins.replaced 且版本 +1，设置原样入账', () => {
    const decision = decide(
      view({ version: 2 }),
      { type: 'plugins.replace', commandId: 'c-1', settings: [setting()] },
      NOW,
      env(),
    )
    expect(decision.reject).toBeUndefined()
    expect(decision.facts).toHaveLength(1)
    const fact = decision.facts[0]
    expect(fact?.type).toBe('plugins.replaced')
    const payload = fact?.payload as {
      pluginSettings: {
        id: string
        version: number
        replacedAt: string
        settings: PluginSetting[]
      }
    }
    expect(payload.pluginSettings.id).toBe('current')
    expect(payload.pluginSettings.version).toBe(3)
    expect(payload.pluginSettings.replacedAt).toBe(NOW)
    expect(payload.pluginSettings.settings).toEqual([setting()])
  })

  it('空快照合法：版本 +1 且保留空清单', () => {
    const decision = decide(
      view(),
      { type: 'plugins.replace', commandId: 'c-2', settings: [] },
      NOW,
      env(),
    )
    expect(decision.facts[0]?.payload).toMatchObject({
      pluginSettings: { id: 'current', version: 1, settings: [] },
    })
  })

  it('重复 id 整批拒绝且零事实', () => {
    const decision = decide(
      view(),
      {
        type: 'plugins.replace',
        commandId: 'c-3',
        settings: [setting(), setting()],
      },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
    expect(decision.reject?.code).toBe('invalid_input')
    expect(decision.reject?.message).toContain('插件 id 重复')
  })

  it('未知能力整批拒绝', () => {
    const decision = decide(
      view(),
      {
        type: 'plugins.replace',
        commandId: 'c-4',
        settings: [setting({ granted: ['net', 'bogus' as never] })],
      },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
    expect(decision.reject?.message).toContain('未知能力')
  })

  it('id 不是 slug 整批拒绝', () => {
    const decision = decide(
      view(),
      { type: 'plugins.replace', commandId: 'c-5', settings: [setting({ id: 'Bad Id' })] },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
    expect(decision.reject?.message).toContain('小写 slug')
  })

  it('config 超长值整批拒绝', () => {
    const decision = decide(
      view(),
      {
        type: 'plugins.replace',
        commandId: 'c-6',
        settings: [setting({ config: { huge: 'x'.repeat(2_001) } })],
      },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
    expect(decision.reject?.message).toContain('最长')
  })

  it('plugin.set 直接进内核被拒绝（由宿主编排）', () => {
    const decision = decide(
      view(),
      { type: 'plugin.set', commandId: 'c-7', pluginId: 'webhook', enabled: false },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
    expect(decision.reject?.code).toBe('unsupported')
  })
})

describe('project: plugins.replaced → plugin_settings 单行', () => {
  it('一行事实 → 一行投影（key=current）', () => {
    const fact = {
      seq: 5,
      type: 'plugins.replaced' as const,
      actor: { kind: 'owner' as const, via: 'ui' as const },
      at: NOW,
      payload: {
        pluginSettings: {
          id: 'current' as const,
          version: 1,
          replacedAt: NOW,
          settings: [setting()],
        },
      },
    }
    const changes = project(fact)
    expect(changes).toEqual([
      {
        table: 'plugin_settings',
        key: 'current',
        row: fact.payload.pluginSettings,
      },
    ])
  })
})

describe('kernel/plugins 纯函数', () => {
  it('validatePluginSettings 归一 config 并保留声明 kind', () => {
    const result = validatePluginSettings([setting({ config: { port: 1 } })])
    expect('settings' in result).toBe(true)
    if ('settings' in result) expect(result.settings[0]?.config).toEqual({ port: 1 })
  })

  it('mergePluginSetting 只覆盖 patch 提供的字段', () => {
    const merged = mergePluginSetting(
      { id: 'webhook', kind: 'source', enabled: false, granted: [], config: { port: 1 } },
      { pluginId: 'webhook', enabled: true, config: { path: '/hook' } },
    )
    expect(merged).toEqual({
      id: 'webhook',
      kind: 'source',
      enabled: true,
      granted: [],
      config: { port: 1, path: '/hook' },
    })
  })

  it('mergePluginSetting 的 granted 是整体替换', () => {
    const merged = mergePluginSetting(
      { id: 'webhook', kind: 'source', enabled: true, granted: ['net'], config: {} },
      { pluginId: 'webhook', granted: [] },
    )
    expect(merged.granted).toEqual([])
  })

  it('validatePluginSettings 拒绝非布尔 enabled（防直接调内核时绕过协议层）', () => {
    const result = validatePluginSettings([setting({ enabled: 'yes' as unknown as boolean })])
    expect('error' in result).toBe(true)
  })

  it('replacedAt 之外的缺省值不影响其它设置', () => {
    const result = validatePluginSettings([setting({ id: 'other', kind: 'channel' })])
    if ('settings' in result) expect(result.settings[0]?.id).toBe('other')
    expect('error' in result).toBe(false)
  })

  it('validatePluginSettings 拒绝空 id / 能力重复 / 超条数', () => {
    expect(validatePluginSettings([setting({ id: '  ' })])).toMatchObject({
      error: '插件设置 1: id 必须是小写 slug',
    })
    expect(validatePluginSettings([setting({ granted: ['net', 'net'] })])).toMatchObject({
      error: '插件「webhook」: 能力重复 net',
    })
    // 条数上限与协议层同口径
    const tooMany = Array.from({ length: 65 }, (_, index) => setting({ id: `p-${index}` }))
    expect(validatePluginSettings(tooMany)).toMatchObject({ error: '插件设置最多 64 条' })
  })

  it('validatePluginSettings 拒绝空位（数组洞）', () => {
    const sparse = [setting()] as PluginSetting[]
    sparse[1] = undefined as unknown as PluginSetting
    expect(validatePluginSettings(sparse)).toMatchObject({ error: '插件设置 2: 缺失' })
  })

  it('validatePluginSettings 的 config 语义校验', () => {
    expect(validatePluginSettings([setting({ config: { k: Number.NaN } })])).toMatchObject({
      error: '插件「webhook」: config.k 必须是有限数字',
    })
    expect(validatePluginSettings([setting({ config: { '': 1 } })])).toMatchObject({
      error: '插件「webhook」: config 键非法 ',
    })
    expect(validatePluginSettings([setting({ config: { k: 'x'.repeat(2_001) } })])).toMatchObject({
      error: '插件「webhook」: config.k 最长 2000 个字符',
    })
    expect(
      validatePluginSettings([setting({ config: { k: { nested: true } as unknown as string } })]),
    ).toMatchObject({ error: '插件「webhook」: config.k 必须是标量' })
    const tooManyConfig = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`k${index}`, 1]),
    )
    expect(validatePluginSettings([setting({ config: tooManyConfig })])).toMatchObject({
      error: '插件「webhook」: config 最多 32 项',
    })
  })
})
