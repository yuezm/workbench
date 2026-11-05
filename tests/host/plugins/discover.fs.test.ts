// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * 外部插件发现的**不可读目录**分支（M7 D1）：真实文件系统上很难稳定构造「目录存在但
 * readdir 失败」（权限/竞态），这里 mock `node:fs/promises` 精确覆盖三条降级路径：
 * 根目录不可读 → 整次发现返回一条可展示的拒绝原因；类别目录不可读 → 只拒绝该类别；
 * 未知类别目录不可读 → 拒绝项不带 kind。
 */

const { readdirMock, readFileMock, statMock } = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  readdir: readdirMock,
  readFile: readFileMock,
  stat: statMock,
}))

const { discoverExternalPlugins } = await import('../../../src/host/plugins/discover')

/** 目录项形状（discover 只用 name 与 isDirectory）。 */
const dirEntry = (name: string): { name: string; isDirectory: () => boolean } => ({
  name,
  isDirectory: () => true,
})

const permissionError = (path: string): Error => {
  const error = new Error(`EACCES: permission denied, scandir '${path}'`)
  ;(error as NodeJS.ErrnoException).code = 'EACCES'
  return error
}

describe('discoverExternalPlugins 目录不可读', () => {
  it('根目录存在但不可读：返回一条 manifest_invalid 拒绝原因（不静默当成没装插件）', async () => {
    statMock.mockResolvedValue({ isDirectory: () => true })
    readdirMock.mockRejectedValue(permissionError('/plugins'))

    const result = await discoverExternalPlugins({ pluginsRoot: '/plugins' })

    expect(result.missingRoot).toBe(false)
    expect(result.entries).toEqual([])
    expect(result.rejections).toEqual([
      {
        path: '',
        kind: null,
        id: null,
        reason: 'manifest_invalid',
        detail: expect.stringContaining('插件目录不可读'),
      },
    ])
    expect(String(result.rejections[0].detail)).toContain('EACCES')
  })

  it('已知类别目录不可读：只拒绝该类别，继续扫描其它类别', async () => {
    statMock.mockImplementation(async (target: string) =>
      target.endsWith('plugin.mjs') ? { isFile: () => true } : { isDirectory: () => true },
    )
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === '/plugins') return [dirEntry('source'), dirEntry('channel')]
      if (dir === join('/plugins', 'source')) throw permissionError(dir)
      return [dirEntry('ok-channel')]
    })
    readFileMock.mockResolvedValue(
      JSON.stringify({
        id: 'ok-channel',
        kind: 'channel',
        name: 'OK',
        version: '1.0.0',
        capabilities: [],
      }),
    )

    const result = await discoverExternalPlugins({ pluginsRoot: '/plugins' })

    expect(result.entries.map((entry) => entry.id)).toEqual(['ok-channel'])
    expect(result.rejections).toEqual([
      {
        path: 'source',
        kind: 'source',
        id: null,
        reason: 'manifest_invalid',
        detail: expect.stringContaining('插件类别目录不可读'),
      },
    ])
  })

  it('未知类别目录不可读：拒绝项 kind 为 null（类别本身也不在 M7 范围）', async () => {
    statMock.mockResolvedValue({ isDirectory: () => true })
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === '/plugins') return [dirEntry('executors')]
      throw permissionError(dir)
    })

    const result = await discoverExternalPlugins({ pluginsRoot: '/plugins' })

    expect(result.entries).toEqual([])
    expect(result.rejections).toEqual([
      {
        path: 'executors',
        kind: null,
        id: null,
        reason: 'manifest_invalid',
        detail: expect.stringContaining('插件类别目录不可读'),
      },
    ])
  })
})
