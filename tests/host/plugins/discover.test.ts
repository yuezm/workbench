// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverExternalPlugins } from '../../../src/host/plugins/discover'

/**
 * 外部插件发现（M7 D1）：扫描 `<pluginsRoot>/<kind>/<id>/` 的 manifest + 入口。
 *
 * 用真实临时目录（读盘就是被测行为的一部分）；每个拒绝分支都要给出可展示的
 * `reason` + `detail`，不允许静默跳过。
 */

const tempDirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'discover-'))
  tempDirs.push(dir)
  return dir
}

interface ManifestOverrides {
  id?: string
  kind?: string
  name?: string
  version?: string
  capabilities?: string[]
}

function manifestOf(id: string, overrides: ManifestOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? id,
    kind: overrides.kind ?? 'source',
    name: overrides.name ?? id,
    version: overrides.version ?? '1.0.0',
    capabilities: overrides.capabilities ?? ['net'],
  }
}

/** 在用户目录里落一个插件；`manifest` 传字符串时原样写入（用于非法 JSON）。 */
function writePlugin(
  root: string,
  kind: string,
  id: string,
  manifest: unknown = manifestOf(id, { kind }),
  withEntry = true,
): void {
  const dir = path.join(root, kind, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  )
  if (withEntry)
    writeFileSync(path.join(dir, 'plugin.mjs'), 'export const start = async () => () => {}')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('discoverExternalPlugins 正常装载', () => {
  it('合法 source / channel 插件产出 entry（含目录与入口绝对路径）', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'my-source', manifestOf('my-source', { kind: 'source' }))
    writePlugin(root, 'channel', 'my-channel', manifestOf('my-channel', { kind: 'channel' }))

    const result = await discoverExternalPlugins({ pluginsRoot: root })

    expect(result.missingRoot).toBe(false)
    expect(result.rejections).toEqual([])
    expect(result.entries.map((entry) => [entry.kind, entry.id, entry.overridesBuiltin])).toEqual([
      ['channel', 'my-channel', false],
      ['source', 'my-source', false],
    ])
    const source = result.entries.find((entry) => entry.id === 'my-source')
    expect(source?.dir).toBe(path.join(root, 'source', 'my-source'))
    expect(source?.entry).toBe(path.join(root, 'source', 'my-source', 'plugin.mjs'))
    expect(source?.manifest).toMatchObject({ id: 'my-source', kind: 'source', version: '1.0.0' })
  })

  it('同 kind+id 与内置重复时用户目录优先（overridesBuiltin），不拒绝', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'webhook', manifestOf('webhook', { kind: 'source' }))

    const result = await discoverExternalPlugins({
      pluginsRoot: root,
      builtins: [{ kind: 'source', id: 'webhook' }],
    })

    expect(result.rejections).toEqual([])
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].overridesBuiltin).toBe(true)
  })

  it('根目录不存在是正常状态（首次启动）', async () => {
    const missing = path.join(tempRoot(), 'not-created')
    await expect(discoverExternalPlugins({ pluginsRoot: missing })).resolves.toEqual({
      entries: [],
      rejections: [],
      missingRoot: true,
    })
  })

  it('根路径是文件时按缺失处理（不抛错）', async () => {
    const root = tempRoot()
    const file = path.join(root, 'plugins')
    writeFileSync(file, 'not a dir')
    await expect(discoverExternalPlugins({ pluginsRoot: file })).resolves.toEqual({
      entries: [],
      rejections: [],
      missingRoot: true,
    })
  })

  it('输出顺序稳定：kind 目录与插件目录都按名字排序', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'b-plugin')
    writePlugin(root, 'source', 'a-plugin')
    writePlugin(root, 'channel', 'c-channel')

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.entries.map((entry) => entry.id)).toEqual(['c-channel', 'a-plugin', 'b-plugin'])
  })
})

describe('discoverExternalPlugins 拒绝原因', () => {
  it('manifest 不是合法 JSON：manifest_invalid 带解析错误', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'broken', '{ not json')

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.entries).toEqual([])
    expect(result.rejections).toEqual([
      {
        path: 'source/broken',
        kind: 'source',
        id: 'broken',
        reason: 'manifest_invalid',
        detail: expect.stringContaining('不是合法 JSON'),
      },
    ])
  })

  it('缺少 manifest.json：manifest_invalid', async () => {
    const root = tempRoot()
    mkdirSync(path.join(root, 'source', 'empty'), { recursive: true })
    writeFileSync(path.join(root, 'source', 'empty', 'plugin.mjs'), '')

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.rejections[0]).toMatchObject({
      path: 'source/empty',
      reason: 'manifest_invalid',
      detail: '缺少 manifest.json',
    })
  })

  it('manifest 形状非法（id 不是 kebab-case）：manifest_invalid', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'bad-id', manifestOf('Bad_Id', { kind: 'source' }))

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.rejections[0]).toMatchObject({
      path: 'source/bad-id',
      reason: 'manifest_invalid',
      detail: 'id 不是 kebab-case',
    })
  })

  it('入口文件缺失：entry_missing（manifest 本身合法）', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'no-entry', manifestOf('no-entry', { kind: 'source' }), false)

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.rejections).toEqual([
      {
        path: 'source/no-entry',
        kind: 'source',
        id: 'no-entry',
        reason: 'entry_missing',
        detail: '缺少入口文件 plugin.mjs',
      },
    ])
  })

  it('目录名与 manifest.id 不一致：manifest_invalid', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'dir-name', manifestOf('other-id', { kind: 'source' }))

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.rejections[0]).toMatchObject({
      reason: 'manifest_invalid',
      detail: expect.stringContaining('目录名与 manifest.id 不一致'),
    })
  })

  it('目录类别与 manifest.kind 不一致：manifest_invalid', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'cross-kind', manifestOf('cross-kind', { kind: 'channel' }))

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.rejections[0]).toMatchObject({
      reason: 'manifest_invalid',
      detail: expect.stringContaining('目录类别与 manifest.kind 不一致'),
    })
  })

  it('非 source/channel 目录：kind_unsupported（不读 manifest、不执行）', async () => {
    const root = tempRoot()
    writePlugin(root, 'executors', 'my-executor', manifestOf('my-executor', { kind: 'executor' }))

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.entries).toEqual([])
    expect(result.rejections[0]).toMatchObject({
      path: 'executors/my-executor',
      kind: 'executors',
      id: 'my-executor',
      reason: 'kind_unsupported',
      detail: 'M7 不开放外部 executors 插件',
    })
  })

  it('source 目录里声明 executor kind：kind_unsupported（parseExternalManifest 判定）', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'wannabe', manifestOf('wannabe', { kind: 'executor' }))

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.rejections[0]).toMatchObject({
      path: 'source/wannabe',
      reason: 'kind_unsupported',
    })
  })

  it('跨 kind 同 id：duplicate_id（插件 id 全局唯一）', async () => {
    const root = tempRoot()
    writePlugin(root, 'channel', 'same-id', manifestOf('same-id', { kind: 'channel' }))
    writePlugin(root, 'source', 'same-id', manifestOf('same-id', { kind: 'source' }))

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    // channel 按目录序先装载，source 同 id 被拒
    expect(result.entries.map((entry) => entry.id)).toEqual(['same-id'])
    expect(result.rejections[0]).toMatchObject({
      path: 'source/same-id',
      reason: 'duplicate_id',
      detail: expect.stringContaining('已装载的 channel 插件重复'),
    })
  })

  it('与内置同 id 但 kind 不同：duplicate_id（同 kind+id 才算覆盖）', async () => {
    const root = tempRoot()
    writePlugin(root, 'source', 'desktop', manifestOf('desktop', { kind: 'source' }))

    const result = await discoverExternalPlugins({
      pluginsRoot: root,
      builtins: [{ kind: 'channel', id: 'desktop' }],
    })
    expect(result.entries).toEqual([])
    expect(result.rejections[0]).toMatchObject({
      reason: 'duplicate_id',
      detail: expect.stringContaining('内置 channel 插件重复'),
    })
  })

  it('忽略根目录与类别目录下的散落文件', async () => {
    const root = tempRoot()
    writeFileSync(path.join(root, 'README.md'), 'x')
    mkdirSync(path.join(root, 'source'), { recursive: true })
    writeFileSync(path.join(root, 'source', 'stray.txt'), 'x')
    writePlugin(root, 'source', 'real', manifestOf('real', { kind: 'source' }))

    const result = await discoverExternalPlugins({ pluginsRoot: root })
    expect(result.entries.map((entry) => entry.id)).toEqual(['real'])
    expect(result.rejections).toEqual([])
  })
})
