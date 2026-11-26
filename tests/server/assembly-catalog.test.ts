// @vitest-environment node
/**
 * 插件目录合并与派生（`packages/bundle/base/src/catalog.ts`）。
 *
 * 这些判断原先长在装配根里：内置 + 用户目录合并、授权/启用口径、`plugins.all` 视图行、
 * secret 写入的错误包装。靠真进程只能覆盖「一切正常」那一条，重复 id、未授权、
 * 来源报错、加密不可用这些组合这里直接构造输入逐条断言。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ExternalPluginEntry, ExternalPluginRejection } from '@workbench/host/plugins/discover'
import type { SourceStatus } from '@workbench/host/sources'
import { channels as builtinChannels, sources as builtinSources } from '@workbench/plugins-registry'
import type { PluginManifest } from '@workbench/protocol/manifest'
import type { PluginSetting } from '@workbench/protocol/plugins'
import {
  adapterOptionsOf,
  authorizedOf,
  channelEntriesOf,
  configOf,
  declaredOf,
  enabledOf,
  grantedOf,
  hubConfigOf,
  hubEnabledOf,
  mergeCatalog,
  pluginCommandDepsOf,
  pluginViewsOf,
  secretWriterOf,
  sourceEntriesOf,
  type CatalogEntry,
  type PluginRuntimeState,
} from '@workbench/bundle-base/catalog'

const manifestOf = (patch: Partial<PluginManifest> & Pick<PluginManifest, 'id' | 'kind'>) => {
  const manifest: PluginManifest = {
    name: patch.id,
    version: '1.0.0',
    capabilities: [],
    ...patch,
  }
  return manifest
}

const builtins = [
  { key: 'dsh', manifest: manifestOf({ id: 'dsh', kind: 'executor' }) },
  { key: 'in-app', manifest: manifestOf({ id: 'in-app', kind: 'channel' }) },
  { key: 'webhook', manifest: manifestOf({ id: 'webhook', kind: 'source' }) },
]

const externalEntry = (
  kind: 'source' | 'channel',
  id: string,
  patch: Partial<PluginManifest> = {},
): ExternalPluginEntry => ({
  kind,
  id,
  manifest: manifestOf({ id, kind, ...patch }),
  dir: `/plugins/${kind}/${id}`,
  entry: `/plugins/${kind}/${id}/plugin.mjs`,
  overridesBuiltin: false,
})

/** 只读运行期状态：设置行 / 解密后的 secret / secret 键名 */
function runtimeOf(options: {
  settings?: PluginSetting[]
  secrets?: Record<string, Record<string, string>>
  secretKeys?: Record<string, string[]>
}): PluginRuntimeState {
  return {
    settingOf: (id) => options.settings?.find((row) => row.id === id) ?? null,
    secretsOf: (id) => options.secrets?.[id] ?? {},
    secretKeysOf: (id) => options.secretKeys?.[id] ?? [],
  }
}

const setting = (
  patch: Partial<PluginSetting> & Pick<PluginSetting, 'id' | 'kind'>,
): PluginSetting => ({
  enabled: false,
  granted: [],
  config: {},
  ...patch,
})

describe('mergeCatalog：内置 + 用户目录', () => {
  it('内置按注册表顺序先入列；外部同 kind+id 原地覆盖（位置不变、builtin=false）', () => {
    const merged = mergeCatalog(builtins, {
      entries: [externalEntry('source', 'webhook')],
      rejections: [],
    })

    expect(merged.catalog.map((entry) => [entry.id, entry.builtin])).toEqual([
      ['dsh', true],
      ['in-app', true],
      ['webhook', false],
    ])
    expect(merged.rejections).toEqual([])
    // 覆盖项保留外部清单（dir/entry 供子进程用）
    expect(merged.catalog[2]?.external?.entry).toContain('plugin.mjs')
  })

  it('外部新 id 追加在末尾；跨 kind 撞 id 时拒绝并给出 duplicate_id', () => {
    const merged = mergeCatalog(builtins, {
      entries: [externalEntry('channel', 'demo'), externalEntry('source', 'dsh')],
      rejections: [],
    })

    expect(merged.catalog.map((entry) => entry.id)).toEqual(['dsh', 'in-app', 'webhook', 'demo'])
    expect(merged.rejections).toEqual([
      {
        path: 'source/dsh',
        kind: 'source',
        id: 'dsh',
        reason: 'duplicate_id',
        detail: '插件 id 已被占用: dsh',
      },
    ])
  })

  it('扫描阶段已有的拒绝项原样带出（顺序在前）', () => {
    const scanned: ExternalPluginRejection = {
      path: 'executor/x',
      kind: 'executor',
      id: 'x',
      reason: 'kind_unsupported',
      detail: 'M7 不开放外部 executor 插件',
    }
    const merged = mergeCatalog(builtins, {
      entries: [externalEntry('channel', 'in-app')],
      rejections: [scanned],
    })

    expect(merged.rejections[0]).toEqual(scanned)
    expect(merged.catalog.find((entry) => entry.id === 'in-app')?.builtin).toBe(false)
  })

  it('同 kind+id 命中非内置行（外部重复）时按撞 id 拒绝，不产生第二行', () => {
    const duplicate = externalEntry('channel', 'demo')
    const merged = mergeCatalog(builtins, {
      entries: [duplicate, externalEntry('source', 'demo')],
      rejections: [],
    })

    expect(merged.catalog.filter((entry) => entry.id === 'demo')).toHaveLength(1)
    expect(merged.rejections[0]?.reason).toBe('duplicate_id')
  })
})

describe('授权与启用口径', () => {
  const builtinEntry: CatalogEntry = {
    id: 'webhook',
    kind: 'source',
    builtin: true,
    manifest: manifestOf({ id: 'webhook', kind: 'source', capabilities: ['net'] }),
    external: null,
  }
  const externalOf = (capabilities: PluginManifest['capabilities'] = ['net']): CatalogEntry => ({
    id: 'demo',
    kind: 'source',
    builtin: false,
    manifest: manifestOf({ id: 'demo', kind: 'source', capabilities }),
    external: externalEntry('source', 'demo', { capabilities }),
  })

  it('内置插件恒可信：授权=声明、缺省启用、enabled=false 才关', () => {
    const none = runtimeOf({})
    expect(declaredOf(builtinEntry)).toEqual(['net'])
    expect(grantedOf(builtinEntry, none)).toEqual(['net'])
    expect(authorizedOf(builtinEntry, none)).toBe(true)
    expect(enabledOf(builtinEntry, none)).toBe(true)

    const disabled = runtimeOf({
      settings: [setting({ id: 'webhook', kind: 'source', enabled: false })],
    })
    expect(enabledOf(builtinEntry, disabled)).toBe(false)
    // 内置关掉也仍然「已授权」：授权面由本仓库自己定
    expect(authorizedOf(builtinEntry, disabled)).toBe(true)
  })

  it('外部插件默认不启用：没有设置行 → disabled + unauthorized', () => {
    const runtime = runtimeOf({})
    const entry = externalOf()
    expect(grantedOf(entry, runtime)).toEqual([])
    expect(authorizedOf(entry, runtime)).toBe(false)
    expect(enabledOf(entry, runtime)).toBe(false)
  })

  it('外部插件启用但能力没全授权 → unauthorized（仍不可用）', () => {
    const runtime = runtimeOf({
      settings: [setting({ id: 'demo', kind: 'source', enabled: true, granted: [] })],
    })
    const entry = externalOf()
    expect(authorizedOf(entry, runtime)).toBe(false)
    expect(enabledOf(entry, runtime)).toBe(false)
  })

  it('外部插件启用且能力全部授权 → 可用', () => {
    const runtime = runtimeOf({
      settings: [setting({ id: 'demo', kind: 'source', enabled: true, granted: ['net'] })],
    })
    const entry = externalOf()
    expect(grantedOf(entry, runtime)).toEqual(['net'])
    expect(authorizedOf(entry, runtime)).toBe(true)
    expect(enabledOf(entry, runtime)).toBe(true)
  })

  it('外部插件声明零能力：启用即授权（空集合的 every 为真）', () => {
    const runtime = runtimeOf({
      settings: [setting({ id: 'demo', kind: 'source', enabled: true, granted: [] })],
    })
    expect(enabledOf(externalOf([]), runtime)).toBe(true)
  })
})

describe('configOf：manifest 默认值 → 设置值 → 授权 secret', () => {
  const withConfig = (builtin: boolean): CatalogEntry => ({
    id: builtin ? 'webhook' : 'demo',
    kind: 'source',
    builtin,
    manifest: manifestOf({
      id: builtin ? 'webhook' : 'demo',
      kind: 'source',
      config: [
        { key: 'url', label: '地址', type: 'text', default: 'http://localhost' },
        { key: 'secret', label: '密钥', type: 'secret' },
      ],
    }),
    external: builtin ? null : externalEntry('source', 'demo'),
  })

  it('内置：默认值 + 设置值 + 声明外的面板键 + secret 全透传', () => {
    const runtime = runtimeOf({
      settings: [
        setting({
          id: 'webhook',
          kind: 'source',
          enabled: true,
          granted: ['net'],
          config: { url: 'http://127.0.0.1:9', connections: 'panel-only' },
        }),
      ],
      secrets: { webhook: { secret: 'plain' } },
    })

    expect(configOf(withConfig(true), runtime)).toEqual({
      url: 'http://127.0.0.1:9',
      connections: 'panel-only',
      secret: 'plain',
    })
  })

  it('外部：只收 manifest 声明的键（声明外的历史残留不生效）', () => {
    const runtime = runtimeOf({
      settings: [
        setting({
          id: 'demo',
          kind: 'source',
          enabled: true,
          granted: ['net'],
          config: { url: 'http://x', connections: 'panel-only' },
        }),
      ],
      secrets: { demo: { secret: 'plain' } },
    })

    expect(configOf(withConfig(false), runtime)).toEqual({ url: 'http://x', secret: 'plain' })
  })
})

describe('adapterOptionsOf：外部插件才需要适配器', () => {
  const deps = { execPath: '/usr/bin/node', spawn: vi.fn(), log: vi.fn() }

  it('内置返回 null（走注册表的原生实现）', () => {
    const entry: CatalogEntry = {
      id: 'webhook',
      kind: 'source',
      builtin: true,
      manifest: manifestOf({ id: 'webhook', kind: 'source' }),
      external: null,
    }
    expect(adapterOptionsOf(entry, runtimeOf({}), deps)).toBeNull()
  })

  it('外部：下发授权后的能力、合并后的配置，日志转给装配根', () => {
    const runtime = runtimeOf({
      settings: [setting({ id: 'demo', kind: 'source', enabled: true, granted: ['net'] })],
    })
    const entry: CatalogEntry = {
      id: 'demo',
      kind: 'source',
      builtin: false,
      manifest: manifestOf({ id: 'demo', kind: 'source', capabilities: ['net'] }),
      external: externalEntry('source', 'demo', { capabilities: ['net'] }),
    }

    const options = adapterOptionsOf(entry, runtime, deps)
    expect(options?.execPath).toBe('/usr/bin/node')
    expect(options?.granted).toEqual(['net'])
    expect(options?.config).toEqual({})
    options?.log?.('子进程说了一句')
    expect(deps.log).toHaveBeenCalledWith('子进程说了一句')
  })
})

describe('channelEntriesOf / sourceEntriesOf：内置取注册表，外部包适配器', () => {
  const deps = { execPath: '/usr/bin/node', spawn: vi.fn(), log: vi.fn() }

  it('通道：内置行与注册表同源，外部行包成适配器插件', () => {
    const catalog: CatalogEntry[] = [
      {
        id: 'in-app',
        kind: 'channel',
        builtin: true,
        manifest: builtinChannels[0]?.manifest as PluginManifest,
        external: null,
      },
      {
        id: 'demo',
        kind: 'channel',
        builtin: false,
        manifest: manifestOf({ id: 'demo', kind: 'channel' }),
        external: externalEntry('channel', 'demo'),
      },
    ]

    const entries = channelEntriesOf(catalog, runtimeOf({}), deps)
    expect(entries.map((entry) => entry.key)).toEqual(['in-app', 'demo'])
    // 内置：与注册表同一个插件对象（不是重新包装）
    expect(entries[0]?.plugin).toBe(builtinChannels[0]?.plugin)
    expect(entries[1]?.plugin.start).toBeTypeOf('function')
    expect(entries[1]?.label).toBe('demo')
  })

  it('来源：内置行与注册表同源，外部行包成适配器插件', () => {
    const catalog: CatalogEntry[] = [
      {
        id: 'webhook',
        kind: 'source',
        builtin: true,
        manifest: builtinSources[0]?.manifest as PluginManifest,
        external: null,
      },
      {
        id: 'demo',
        kind: 'source',
        builtin: false,
        manifest: manifestOf({ id: 'demo', kind: 'source' }),
        external: externalEntry('source', 'demo'),
      },
    ]

    const entries = sourceEntriesOf(catalog, runtimeOf({}), deps)
    expect(entries.map((entry) => entry.key)).toEqual(['webhook', 'demo'])
    expect(entries[0]?.plugin).toBe(builtinSources[0]?.plugin)
    expect(entries[1]?.plugin.start).toBeTypeOf('function')
  })
})

describe('hubConfigOf / hubEnabledOf：hub 按 kind + key 取目录行', () => {
  const catalog: CatalogEntry[] = [
    {
      id: 'webhook',
      kind: 'source',
      builtin: true,
      manifest: manifestOf({
        id: 'webhook',
        kind: 'source',
        config: [{ key: 'url', label: '地址', type: 'text', default: 'http://d' }],
      }),
      external: null,
    },
  ]

  it('行在：给合并后的配置与启用判断', () => {
    const runtime = runtimeOf({
      settings: [
        setting({ id: 'webhook', kind: 'source', enabled: false, config: { url: 'http://x' } }),
      ],
    })
    expect(hubConfigOf(catalog, runtime, 'source')({ key: 'webhook' })).toEqual({ url: 'http://x' })
    expect(hubEnabledOf(catalog, runtime, 'source')({ key: 'webhook' })).toBe(false)
  })

  it('行不在：配置空对象、启用为 true（内置默认值）', () => {
    const runtime = runtimeOf({})
    expect(hubConfigOf(catalog, runtime, 'source')({ key: 'nope' })).toEqual({})
    expect(hubEnabledOf(catalog, runtime, 'source')({ key: 'nope' })).toBe(true)
  })

  it('kind 不匹配同样当行不在（channel 视角查 source 行）', () => {
    const runtime = runtimeOf({})
    expect(hubConfigOf(catalog, runtime, 'channel')({ key: 'webhook' })).toEqual({})
    expect(hubEnabledOf(catalog, runtime, 'channel')({ key: 'webhook' })).toBe(true)
  })
})

describe('pluginViewsOf：plugins.all 视图', () => {
  const baseCatalog: CatalogEntry[] = [
    {
      id: 'dsh',
      kind: 'executor',
      builtin: true,
      manifest: manifestOf({
        id: 'dsh',
        kind: 'executor',
        description: '本机 dsh',
        config: [{ key: 'command', label: '命令', type: 'text', default: 'dsh' }],
      }),
      external: null,
    },
    {
      id: 'demo',
      kind: 'source',
      builtin: false,
      manifest: manifestOf({ id: 'demo', kind: 'source', capabilities: ['net'] }),
      external: externalEntry('source', 'demo', { capabilities: ['net'] }),
    },
    {
      id: 'lazy',
      kind: 'source',
      builtin: false,
      manifest: manifestOf({ id: 'lazy', kind: 'source', capabilities: ['net'] }),
      external: externalEntry('source', 'lazy', { capabilities: ['net'] }),
    },
  ]

  it('内置 ready、外部未授权 unauthorized、外部已启用但来源报错 error', () => {
    const runtime = runtimeOf({
      settings: [
        setting({ id: 'demo', kind: 'source', enabled: true, granted: ['net'] }),
        setting({ id: 'dsh', kind: 'executor', enabled: true, config: { command: 'dsh-x' } }),
      ],
      secretKeys: { dsh: ['token'] },
    })
    const statuses: SourceStatus[] = [
      { key: 'demo', state: 'error', error: '子进程连续失败 4 次' },
      { key: 'lazy', state: 'disabled', error: null },
    ]

    const views = pluginViewsOf({
      catalog: baseCatalog,
      rejections: [],
      runtime,
      sourceStatuses: statuses,
    })

    expect(views.map((view) => [view.id, view.status])).toEqual([
      ['dsh', 'ready'],
      ['demo', 'error'],
      ['lazy', 'unauthorized'],
    ])
    expect(views[0]).toMatchObject({
      kind: 'executor',
      builtin: true,
      enabled: true,
      declared: [],
      granted: [],
      config: { command: 'dsh-x' },
      secretKeys: ['token'],
      description: '本机 dsh',
      configFields: [{ key: 'command', label: '命令', type: 'text', default: 'dsh' }],
      error: null,
    })
    expect(views[1]?.error).toBe('子进程连续失败 4 次')
    expect(views[2]).toMatchObject({ enabled: false, error: null })
  })

  it('内置关闭 → disabled；外部有设置但未启用也 disabled（不是 unauthorized）', () => {
    const runtime = runtimeOf({
      settings: [
        setting({ id: 'dsh', kind: 'executor', enabled: false }),
        setting({ id: 'demo', kind: 'source', enabled: false, granted: ['net'] }),
      ],
    })
    const views = pluginViewsOf({
      catalog: baseCatalog,
      rejections: [],
      runtime,
      sourceStatuses: [],
    })

    expect(views.map((view) => view.status)).toEqual(['disabled', 'disabled', 'unauthorized'])
    // 来源状态只在启用时参与判定：关闭的来源即使报错也显示 disabled
    const withError = pluginViewsOf({
      catalog: baseCatalog,
      rejections: [],
      runtime,
      sourceStatuses: [{ key: 'dsh', state: 'error', error: 'boom' }],
    })
    expect(withError[0]?.status).toBe('disabled')
    expect(withError[0]?.error).toBeNull()
  })

  it('已启用的来源：状态 running → ready；状态表里没有它也不改状态（仍 ready）', () => {
    const runtime = runtimeOf({
      settings: [setting({ id: 'demo', kind: 'source', enabled: true, granted: ['net'] })],
    })
    const running = pluginViewsOf({
      catalog: baseCatalog,
      rejections: [],
      runtime,
      sourceStatuses: [{ key: 'demo', state: 'running', error: null }],
    })
    expect(running[1]?.status).toBe('ready')
    expect(running[1]?.error).toBeNull()

    const missing = pluginViewsOf({
      catalog: baseCatalog,
      rejections: [],
      runtime,
      sourceStatuses: [],
    })
    expect(missing[1]?.status).toBe('ready')
  })

  it('拒绝项排到末尾：合法 kind 原样、未知 kind 退成 source、缺 id 用路径、空路径给兜底名', () => {
    const rejections: ExternalPluginRejection[] = [
      {
        path: 'source/broken',
        kind: 'source',
        id: 'broken',
        reason: 'entry_missing',
        detail: '缺少入口文件 plugin.mjs',
      },
      {
        path: 'executor/unknown',
        kind: 'executor',
        id: 'unknown',
        reason: 'kind_unsupported',
        detail: 'M7 不开放外部 executor 插件',
      },
      {
        path: 'weird/dir',
        kind: null,
        id: null,
        reason: 'manifest_invalid',
        detail: 'manifest 不是对象',
      },
      { path: '', kind: null, id: null, reason: 'manifest_invalid', detail: '插件目录不可读' },
    ]

    const views = pluginViewsOf({
      catalog: [],
      rejections,
      runtime: runtimeOf({}),
      sourceStatuses: [],
    })

    expect(views.map((view) => [view.id, view.kind, view.status, view.name])).toEqual([
      ['broken', 'source', 'manifest_error', 'source/broken'],
      ['unknown', 'executor', 'manifest_error', 'executor/unknown'],
      ['weird/dir', 'source', 'manifest_error', 'weird/dir'],
      ['', 'source', 'manifest_error', '插件目录'],
    ])
    expect(views[0]?.error).toBe('缺少入口文件 plugin.mjs')
    expect(views[0]?.builtin).toBe(false)
    expect(views[0]?.version).toBe('')
  })
})

describe('pluginCommandDepsOf / secretWriterOf：命令路由的插件侧', () => {
  const catalog: CatalogEntry[] = [
    {
      id: 'demo',
      kind: 'source',
      builtin: false,
      manifest: manifestOf({ id: 'demo', kind: 'source' }),
      external: externalEntry('source', 'demo'),
    },
  ]

  it('entry/view 按 id 取，缺失返回 null；writeSecrets 原样转发', () => {
    const writeSecrets = vi.fn()
    const views = vi.fn(() => [
      {
        id: 'demo',
        kind: 'source' as const,
        name: 'demo',
        version: '1.0.0',
        description: '',
        builtin: false,
        enabled: false,
        declared: [],
        granted: [],
        configFields: [],
        config: {},
        secretKeys: [],
        status: 'disabled' as const,
        error: null,
      },
    ])
    const deps = pluginCommandDepsOf({ catalog, views, writeSecrets })

    expect(deps.entry('demo')).toEqual({
      manifest: catalog[0]?.manifest,
      builtin: false,
    })
    expect(deps.entry('nope')).toBeNull()
    expect(deps.view('demo')?.id).toBe('demo')
    expect(deps.view('nope')).toBeNull()
    deps.writeSecrets('demo', { token: 'v' })
    expect(writeSecrets).toHaveBeenCalledWith('demo', { token: 'v' })
  })

  it('secretWriterOf：null 删除、其余写入、抛错转可读文案（不含值）', () => {
    const store = {
      setSecret: vi.fn(),
      removeSecret: vi.fn(),
    }
    const write = secretWriterOf(store)
    write('demo', { token: 'v', stale: null })
    expect(store.setSecret).toHaveBeenCalledWith('demo', 'token', 'v')
    expect(store.removeSecret).toHaveBeenCalledWith('demo', 'stale')

    const failing = secretWriterOf({
      setSecret: () => {
        throw new Error('secret_cipher_unavailable: 宿主未提供安全存储，拒绝明文落库')
      },
      removeSecret: () => undefined,
    })
    expect(() => failing('demo', { token: 'plain-value' })).toThrow(
      '无法保存插件 secret：secret_cipher_unavailable',
    )
    // 错误文案不透出值
    try {
      failing('demo', { token: 'plain-value' })
    } catch (error) {
      expect(String(error)).not.toContain('plain-value')
    }

    const nonError = secretWriterOf({
      setSecret: () => {
        // 非 Error 抛出（第三方 cipher 的原始抛出）也要收成可读文案
        throw 'boom:details'
      },
      removeSecret: () => undefined,
    })
    expect(() => nonError('demo', { token: 'v' })).toThrow('无法保存插件 secret：boom')
  })
})
