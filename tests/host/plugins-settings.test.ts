// @vitest-environment node
/**
 * 插件设置专项（M7 T2）：真实 SQLite 临时库 + 真实内核上的
 * 「plugins.replace 事实 → plugin_settings 投影 → 重建」与宿主命令路由的 `plugin.set` 编排。
 *
 * 覆盖：
 * 1. `plugin.set` 新插件按 manifest 默认值建 seed、合入 patch、版本 +1；
 * 2. 授权 ⊆ 声明能力、secret 键 ⊆ 声明的 secret 字段、未知插件；
 * 3. `plugins.replace` 直接 dispatch 的返回值与投影；
 * 4. 增量 vs 重建逐表全等；`plugin_secrets`（非投影表）不被重建清空。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import type { KernelPort } from '../../src/kernel/types'
import { viewSpec } from '../../src/kernel/view-spec'
import type { PluginManifest } from '../../src/protocol/manifest'
import type { PluginView } from '../../src/protocol/plugins'
import { openDatabase } from '../../src/host/db'
import { createStore, type Store } from '../../src/host/store/index'
import {
  createCommandRouter,
  type CommandRouter,
  type PluginCommandDeps,
} from '../../src/host/commands'
import { dumpProjection } from './store/test-support'

const TZ = 'UTC'
const AT = '2026-11-05T10:00:00.000Z'
const kernel: KernelPort = { decide, project, viewSpec }

const webhookManifest: PluginManifest = {
  id: 'webhook',
  kind: 'source',
  name: 'Webhook 来源',
  version: '1.0.0',
  capabilities: ['net'],
  config: [
    { key: 'port', label: '端口', type: 'number', default: 47615 },
    { key: 'path', label: '路径', type: 'text', default: '/webhook' },
    { key: 'secret', label: '签名密钥', type: 'secret' },
  ],
}

let openDbs: DatabaseSync[] = []
let roots: string[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

interface World {
  db: DatabaseSync
  store: Store
  router: CommandRouter
  secrets: Map<string, Record<string, string>>
  pluginDeps: PluginCommandDeps
}

/** 额外可识别的插件（manifest 缺省 / 内置插件等边界用）；默认只有 webhook。 */
interface WorldOptions {
  manifests?: PluginManifest[]
  /** 其中哪些算内置插件（seed 默认启用并授权全部声明能力） */
  builtin?: readonly string[]
}

/** 每个用例一个真实 SQLite 临时文件库（走 `openDatabase` 的完整建库路径）。 */
function world(options: WorldOptions = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwf-plugins-'))
  roots.push(root)
  const db = openDatabase(path.join(root, 'ai-workflow.db'))
  openDbs.push(db)
  const store = createStore({ db, kernel, now: () => AT, timezone: TZ })
  store.ensureProjection()
  const secrets = new Map<string, Record<string, string>>()
  const builtinIds = new Set(options.builtin ?? [])
  const manifestById = new Map<string, PluginManifest>([
    [webhookManifest.id, webhookManifest],
    ...(options.manifests ?? []).map((manifest) => [manifest.id, manifest] as const),
  ])
  const pluginDeps: PluginCommandDeps = {
    entry: (id) => {
      const manifest = manifestById.get(id)
      return manifest === undefined ? null : { manifest, builtin: builtinIds.has(id) }
    },
    view: (id): PluginView | null => {
      const manifest = manifestById.get(id)
      if (manifest === undefined) return null
      const settings = store.query('plugins.settings').settings.find((row) => row.id === id)
      return {
        id,
        kind: manifest.kind,
        name: manifest.name,
        version: manifest.version,
        description: '',
        builtin: builtinIds.has(id),
        enabled: settings?.enabled ?? false,
        declared: [...manifest.capabilities],
        granted: settings?.granted ?? [],
        configFields: [...(manifest.config ?? [])],
        config: settings?.config ?? {},
        secretKeys: Object.keys(secrets.get(id) ?? {}),
        status: settings?.enabled === true ? 'ready' : 'disabled',
        error: null,
      }
    },
    writeSecrets: (id, patch) => {
      const current = secrets.get(id) ?? {}
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete current[key]
        else current[key] = value
      }
      secrets.set(id, current)
    },
  }
  const router = createCommandRouter({
    store,
    dispatch: (input) => store.dispatch(input),
    executors: { forRuntime: () => null },
    executorDefaults: (key) => ({
      executorKey: key ?? 'dsh',
      command: 'dsh',
      profile: 'multica',
    }),
    hostView: () => null,
    plugins: pluginDeps,
    newCommandId: () => 'generated-id',
  })
  return { db, store, router, secrets, pluginDeps }
}

const settingsOf = (store: Store) => store.query('plugins.settings')

describe('plugin.set 编排（M7）', () => {
  it('新插件按 manifest 默认值建 seed：启用 + 授权 + config 合并后版本 +1', async () => {
    const { store, router } = world()
    const result = await router.dispatch({
      type: 'plugin.set',
      commandId: 'c-1',
      pluginId: 'webhook',
      enabled: true,
      granted: ['net'],
      config: { port: 48000 },
    })
    const settings = settingsOf(store)
    expect(settings.version).toBe(1)
    expect(settings.settings).toEqual([
      {
        id: 'webhook',
        kind: 'source',
        enabled: true,
        granted: ['net'],
        config: { port: 48000, path: '/webhook' },
      },
    ])
    expect(result.value).toMatchObject({ id: 'webhook', enabled: true, status: 'ready' })
  })

  it('未知插件 reject not_found', async () => {
    const { router } = world()
    await expect(
      router.dispatch({ type: 'plugin.set', commandId: 'c-2', pluginId: 'missing', enabled: true }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('授权超出声明能力 reject invalid_input', async () => {
    const { router } = world()
    await expect(
      router.dispatch({
        type: 'plugin.set',
        commandId: 'c-3',
        pluginId: 'webhook',
        granted: ['net', 'spawn'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: '插件未声明该能力: spawn' })
  })

  it('未声明的 secret 字段 reject invalid_input', async () => {
    const { router } = world()
    await expect(
      router.dispatch({
        type: 'plugin.set',
        commandId: 'c-4',
        pluginId: 'webhook',
        secrets: { token: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: '插件未声明该 secret 字段: token' })
  })

  it('secret 写入与删除只落到宿主 secret 表（不产事实、不回显值）', async () => {
    const { store, router, secrets } = world()
    const saved = await router.dispatch({
      type: 'plugin.set',
      commandId: 'c-5',
      pluginId: 'webhook',
      secrets: { secret: 's3cret' },
    })
    expect(secrets.get('webhook')).toEqual({ secret: 's3cret' })
    expect(JSON.stringify(saved)).not.toContain('s3cret')
    expect(JSON.stringify(settingsOf(store))).not.toContain('s3cret')

    await router.dispatch({
      type: 'plugin.set',
      commandId: 'c-6',
      pluginId: 'webhook',
      secrets: { secret: null },
    })
    expect(secrets.get('webhook')).toEqual({})
  })

  it('同一 commandId 重放：版本不重复 +1', async () => {
    const { store, router } = world()
    await router.dispatch({
      type: 'plugin.set',
      commandId: 'same',
      pluginId: 'webhook',
      enabled: true,
    })
    await router.dispatch({
      type: 'plugin.set',
      commandId: 'same',
      pluginId: 'webhook',
      enabled: true,
    })
    expect(settingsOf(store).version).toBe(1)
  })
})

const builtinManifest: PluginManifest = {
  id: 'builtin-source',
  kind: 'source',
  name: '内置来源',
  version: '1.0.0',
  capabilities: ['net'],
}

/** manifest 声明了一个非 secret 字段但没有默认值（seed 不应写入该键）。 */
const noDefaultManifest: PluginManifest = {
  id: 'plain-source',
  kind: 'source',
  name: '无默认来源',
  version: '1.0.0',
  capabilities: [],
  config: [{ key: 'label', label: '名称', type: 'text' }],
}

describe('plugin.set 编排：manifest 缺省与内置插件（M7）', () => {
  it('内置插件：新行默认启用并授权全部声明能力（manifest 无 config 时配置为空对象）', async () => {
    const { store, router } = world({ manifests: [builtinManifest], builtin: ['builtin-source'] })

    const result = await router.dispatch({
      type: 'plugin.set',
      commandId: 'b-1',
      pluginId: 'builtin-source',
    })

    expect(settingsOf(store).settings).toEqual([
      { id: 'builtin-source', kind: 'source', enabled: true, granted: ['net'], config: {} },
    ])
    expect(result.value).toMatchObject({ builtin: true, enabled: true, granted: ['net'] })
  })

  it('manifest 非 secret 字段没有默认值：seed 不写该键（等用户配置）', async () => {
    const { store, router } = world({ manifests: [noDefaultManifest] })

    await router.dispatch({
      type: 'plugin.set',
      commandId: 'p-1',
      pluginId: 'plain-source',
      enabled: true,
    })

    expect(settingsOf(store).settings).toEqual([
      { id: 'plain-source', kind: 'source', enabled: true, granted: [], config: {} },
    ])
  })

  it('manifest 没有声明 config：空 secret patch 仍合法并落到宿主 secret 表', async () => {
    const { router, secrets } = world({ manifests: [builtinManifest] })

    const saved = await router.dispatch({
      type: 'plugin.set',
      commandId: 's-1',
      pluginId: 'builtin-source',
      secrets: {},
    })

    expect(secrets.get('builtin-source')).toEqual({})
    expect(saved.value).toMatchObject({ secretKeys: [] })
  })
})

describe('plugins.replace 投影与重建（M7）', () => {
  it('直接 dispatch 返回快照视图，投影行版本递增', () => {
    const { store } = world()
    store.dispatch({
      type: 'plugins.replace',
      commandId: 'r-1',
      settings: [
        { id: 'webhook', kind: 'source', enabled: true, granted: ['net'], config: { port: 1 } },
      ],
    })
    const settings = settingsOf(store)
    expect(settings.version).toBe(1)
    expect(settings.settings).toHaveLength(1)
    expect(settings.replacedAt).toBe(AT)
  })

  it('增量与重建逐表全等（含 plugin_settings）', async () => {
    const { db, store, router } = world()
    await router.dispatch({
      type: 'plugin.set',
      commandId: 'p-1',
      pluginId: 'webhook',
      enabled: true,
      granted: ['net'],
      config: { port: 48000 },
    })
    const before = dumpProjection(db)
    store.rebuild()
    const after = dumpProjection(db)
    expect(after).toEqual(before)
    expect(settingsOf(store).version).toBe(1)
  })

  it('plugin_secrets 是非投影表：重建不清空（回滚后用户需重新授权/填 secret 的另一面）', () => {
    const { db, store } = world()
    db.prepare(
      'INSERT INTO plugin_secrets (plugin_id, key, value_cipher, updated_at) VALUES (?, ?, ?, ?)',
    ).run('webhook', 'secret', 'cipher-text', AT)
    store.rebuild()
    const rows = db.prepare('SELECT plugin_id, key, value_cipher FROM plugin_secrets').all()
    expect(rows).toEqual([{ plugin_id: 'webhook', key: 'secret', value_cipher: 'cipher-text' }])
  })
})

describe('plugin.set 边界（M7）', () => {
  it('未注入 plugins 依赖时 plugin.set 明确 unsupported', async () => {
    const worldWithoutPlugins = (() => {
      const root = mkdtempSync(path.join(tmpdir(), 'aiwf-plugins-nodeps-'))
      roots.push(root)
      const db = openDatabase(path.join(root, 'ai-workflow.db'))
      openDbs.push(db)
      const store = createStore({ db, kernel, now: () => AT, timezone: TZ })
      store.ensureProjection()
      const router = createCommandRouter({
        store,
        dispatch: (input) => store.dispatch(input),
        executors: { forRuntime: () => null },
        executorDefaults: (key) => ({ executorKey: key ?? 'dsh', command: 'dsh', profile: '' }),
        hostView: () => null,
        newCommandId: () => 'generated-id',
      })
      return router
    })()
    await expect(
      worldWithoutPlugins.dispatch({
        type: 'plugin.set',
        commandId: 'c-nodeps',
        pluginId: 'webhook',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'unsupported', message: '插件设置未装配' })
  })

  it('plugins.replace 的幂等回放返回值是新快照（valueOf 走 plugins.settings）', async () => {
    const { store, router } = world()
    const command = {
      type: 'plugins.replace' as const,
      commandId: 'replay-1',
      settings: [
        {
          id: 'webhook',
          kind: 'source' as const,
          enabled: true,
          granted: ['net' as const],
          config: {},
        },
      ],
    }
    const first = await router.dispatch(command)
    const second = await router.dispatch(command)
    expect(second.facts).toEqual(first.facts)
    expect(second.value).toMatchObject({ version: 1 })
    expect(settingsOf(store).version).toBe(1)
  })

  it('plugin.set：deps.dispatch 未落事实时 commandFacts 为 null，facts 回退空数组', async () => {
    const { store, pluginDeps } = world()
    const router = createCommandRouter({
      store,
      dispatch: () => ({ facts: [] }) as never,
      executors: { forRuntime: () => null },
      executorDefaults: (key) => ({
        executorKey: key ?? 'dsh',
        command: 'dsh',
        profile: 'multica',
      }),
      hostView: () => null,
      plugins: pluginDeps,
      newCommandId: () => 'generated-id',
    })
    const result = await router.dispatch({
      type: 'plugin.set',
      commandId: 'c-nofacts',
      pluginId: 'webhook',
      enabled: true,
    })
    expect(result.facts).toEqual([])
    expect(result.value).toMatchObject({ id: 'webhook' })
  })
})
