// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { fakePlugin } from './fake-plugin'
import { fakeSdk } from './fake-sdk'

/**
 * 夹具自检：插件用例只注入自己需要的能力，其余项走 `fakeSdk` 的缺省。
 * 缺省值本身也是契约（未注入 spawn 必须报错而不是静默返回空进程），因此单独断言，
 * 避免夹具缺省坏掉时插件用例「碰巧」通过。
 */
describe('fakeSdk：缺省能力面', () => {
  it('log / now / paths / config 给无副作用缺省', () => {
    const sdk = fakeSdk()

    expect(() => sdk.log('一行日志')).not.toThrow()
    expect(Number.isFinite(sdk.now())).toBe(true)
    expect(sdk.paths.sessionRoot).toBeNull()
    expect(sdk.config()).toEqual({})
  })

  it('process：spawn 未注入时抛可读错误，killTree / scanDirs / findInDirs 给空结论', () => {
    const sdk = fakeSdk()

    expect(() => sdk.process.spawn('missing-cmd', [], { env: {} })).toThrow('fakeSdk：未注入 spawn')
    expect(sdk.process.killTree(4242)).toBe(false)
    expect(sdk.process.scanDirs()).toEqual([])
    expect(sdk.process.findInDirs('missing-cmd', ['C:/bin'])).toBeNull()
  })

  it('resolve：只认当前 node 可执行文件，其它命令按 PATH 找不到', () => {
    const sdk = fakeSdk()

    expect(sdk.process.resolve(process.execPath)).toEqual({ path: process.execPath, error: null })
    expect(sdk.process.resolve('missing-cmd')).toEqual({
      path: null,
      error: '在 PATH 中找不到命令：missing-cmd',
    })
  })

  it('注入项覆盖缺省：各能力都走注入实现', () => {
    const spawn = vi.fn(() => {
      throw new Error('夹具不该真的启动进程')
    })
    const log = vi.fn()
    const sdk = fakeSdk({
      spawn,
      resolve: (command) => ({ path: 'C:/bin/' + command, error: null }),
      killTree: () => true,
      scanDirs: () => ['C:/bin'],
      findInDirs: (command, dirs) => (dirs.length > 0 ? 'C:/bin/' + command : null),
      now: () => 42,
      sessionRoot: 'C:/sessions',
      log,
      config: <T = Record<string, unknown>>() => ({ apiKey: 'test-key' }) as T,
    })

    expect(() => sdk.process.spawn('node', [], { env: {} })).toThrow('夹具不该真的启动进程')
    expect(spawn).toHaveBeenCalledTimes(1)
    sdk.log('hi')
    expect(log).toHaveBeenCalledWith('hi')
    expect(sdk.now()).toBe(42)
    expect(sdk.paths.sessionRoot).toBe('C:/sessions')
    expect(sdk.config()).toEqual({ apiKey: 'test-key' })
    expect(sdk.process.resolve('dsh')).toEqual({ path: 'C:/bin/dsh', error: null })
    expect(sdk.process.killTree(1)).toBe(true)
    expect(sdk.process.scanDirs()).toEqual(['C:/bin'])
    expect(sdk.process.findInDirs('dsh', ['C:/bin'])).toBe('C:/bin/dsh')
    expect(sdk.process.findInDirs('dsh', [])).toBeNull()
  })
})

describe('fakePlugin：假协议夹具', () => {
  it('detect 只报本机命令，executorKey / supported 由注册表汇总时填', () => {
    expect(fakePlugin.detect?.({ sdk: fakeSdk() })).toEqual([
      {
        command: 'fake-cli',
        label: 'Fake 协议',
        path: '/fake/fake-cli',
        executorKey: '',
        supported: false,
      },
    ])
  })
})
