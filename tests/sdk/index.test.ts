// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Capability, PluginManifest } from '../../src/protocol/manifest'
import { createSdk } from '../../src/sdk'
import type { NetCapability, SdkHost, Spawned } from '../../src/sdk/types'

/**
 * sdk 能力门控（M3 T4 / M4 T6）：`createSdk` 只做「按 manifest 门控 + 原样转发」，
 * 因此这里全部用假宿主原件，不真的 spawn / 读盘 / 读时钟 / 弹通知。
 */

/** 最小子进程句柄：只验证 spawn 透传与返回值，不跑真实进程。 */
const spawned: Spawned = {
  pid: 4321,
  stdin: null,
  stdout: null,
  stderr: null,
  onError: () => undefined,
  onClose: () => undefined,
  kill: () => undefined,
}

function manifestOf(capabilities: readonly Capability[], id = 'dsh'): PluginManifest {
  return { id, kind: 'executor', name: 'dsh', version: '1.0.0', capabilities }
}

/** 假网络原件（M7）：三个方法都是 spy，断言只关心是否原样转发。 */
function netOf(): NetCapability {
  return {
    fetch: vi.fn(async () => ({ status: 200, headers: {}, body: 'ok' })),
    listen: vi.fn(async () => ({ port: 47_615, close: async () => undefined })),
    verifyHmacSha256: vi.fn(() => true),
  }
}

/** 假宿主原件：每个能力都是 spy，断言只关心 createSdk 是否原样转发。 */
function hostOf(): SdkHost {
  return {
    log: vi.fn(),
    now: () => 1_700_000_000_123,
    paths: { sessionRoot: 'C:/data/ai-workflow/sessions' },
    config: <T = Record<string, unknown>>(): T => ({ mode: 'dsh', timeoutMs: 60_000 }) as T,
    notify: vi.fn(),
    net: netOf(),
    process: {
      spawn: vi.fn(() => spawned),
      resolve: vi.fn(() => ({ path: 'C:/bin/dsh.cmd', error: null })),
      killTree: vi.fn(() => true),
      scanDirs: vi.fn(() => ['C:/bin']),
      findInDirs: vi.fn(() => 'C:/bin/dsh.cmd'),
    },
  }
}

describe('createSdk 能力门控', () => {
  it('未声明 spawn：访问 sdk.process 抛 capability_not_declared: spawn', () => {
    const sdk = createSdk(hostOf(), manifestOf([]))
    expect(() => sdk.process).toThrow(new Error('capability_not_declared: spawn'))
    // getter 不缓存拒绝结果：每次访问都抛
    expect(() => sdk.process).toThrow('capability_not_declared: spawn')
  })

  it('未声明 spawn 只影响 process：log/now/paths/config 照常可用', () => {
    const host = hostOf()
    const sdk = createSdk(host, manifestOf([]))

    sdk.log('probe start')
    expect(host.log).toHaveBeenCalledWith('[plugin:dsh] probe start')
    expect(sdk.now()).toBe(1_700_000_000_123)
    expect(sdk.paths).toBe(host.paths)
    expect(sdk.config()).toEqual({ mode: 'dsh', timeoutMs: 60_000 })
  })

  it('声明 spawn 后 process 原样透传（spawn/resolve/killTree）', () => {
    const host = hostOf()
    const sdk = createSdk(host, manifestOf(['spawn']))

    expect(sdk.process).toBe(host.process)

    const child = sdk.process.spawn('dsh.cmd', ['--stdio'], {
      cwd: 'C:/work',
      env: { PATH: 'C:/bin' },
      shell: true,
    })
    expect(host.process.spawn).toHaveBeenCalledWith('dsh.cmd', ['--stdio'], {
      cwd: 'C:/work',
      env: { PATH: 'C:/bin' },
      shell: true,
    })
    expect(child).toBe(spawned)

    expect(sdk.process.resolve('dsh')).toEqual({ path: 'C:/bin/dsh.cmd', error: null })
    expect(sdk.process.killTree(4321, 'SIGTERM')).toBe(true)
    expect(host.process.killTree).toHaveBeenCalledWith(4321, 'SIGTERM')
  })
})

describe('createSdk notify 能力门控（M4 T6）', () => {
  it('未声明 notify：访问 sdk.notify 抛 capability_not_declared: notify', () => {
    const sdk = createSdk(hostOf(), manifestOf([]))
    expect(() => sdk.notify).toThrow(new Error('capability_not_declared: notify'))
    // getter 不缓存拒绝结果：每次访问都抛
    expect(() => sdk.notify).toThrow('capability_not_declared: notify')
  })

  it('未声明 notify 只影响 notify：process 等已声明能力照常可用', () => {
    const host = hostOf()
    const sdk = createSdk(host, manifestOf(['spawn']))
    expect(() => sdk.notify).toThrow('capability_not_declared: notify')
    expect(sdk.process).toBe(host.process)
  })

  it('声明 notify 后原样透传 title/body（只作参数，不加前缀不改写）', () => {
    const host = hostOf()
    const sdk = createSdk(host, manifestOf(['notify']))

    sdk.notify('待审批', '任务已挂起，请选择选项')

    expect(host.notify).toHaveBeenCalledTimes(1)
    expect(host.notify).toHaveBeenCalledWith('待审批', '任务已挂起，请选择选项')
  })

  it('声明了 notify 但宿主没有原件：静默丢弃，不抛（通知失败不拖住投递）', () => {
    const bare: SdkHost = { ...hostOf(), notify: undefined }
    const sdk = createSdk(bare, manifestOf(['notify']))

    expect(() => sdk.notify('待审批', '正文')).not.toThrow()
  })
})

describe('createSdk net 能力门控（M7）', () => {
  it('未声明 net：访问 sdk.net 抛 capability_not_declared: net', () => {
    const sdk = createSdk(hostOf(), manifestOf([]))
    expect(() => sdk.net).toThrow(new Error('capability_not_declared: net'))
    // getter 不缓存拒绝结果：每次访问都抛
    expect(() => sdk.net).toThrow('capability_not_declared: net')
  })

  it('未声明 net 只影响 net：process/notify 等已声明能力照常可用', () => {
    const host = hostOf()
    const sdk = createSdk(host, manifestOf(['spawn', 'notify']))
    expect(() => sdk.net).toThrow('capability_not_declared: net')
    expect(sdk.process).toBe(host.process)
    expect(sdk.notify).toBe(host.notify)
  })

  it('声明 net 后原样透传 fetch/listen/verifyHmacSha256', async () => {
    const host = hostOf()
    const sdk = createSdk(host, manifestOf(['net']))
    expect(sdk.net).toBe(host.net)

    await expect(sdk.net.fetch('http://127.0.0.1:1/x', { timeoutMs: 5 })).resolves.toEqual({
      status: 200,
      headers: {},
      body: 'ok',
    })
    expect(host.net?.fetch).toHaveBeenCalledWith('http://127.0.0.1:1/x', { timeoutMs: 5 })
    expect(sdk.net.verifyHmacSha256('s', 'm', '0'.repeat(64))).toBe(true)
  })

  it('声明 net 但宿主没有原件：调用即 capability_unavailable（声明 ≠ 宿主支持）', () => {
    const bare: SdkHost = { ...hostOf(), net: undefined }
    const sdk = createSdk(bare, manifestOf(['net']))
    expect(() => sdk.net.fetch('http://127.0.0.1:1/x')).toThrow('capability_unavailable: net')
    expect(() => sdk.net.listen(0, async () => ({ status: 200 }))).toThrow(
      'capability_unavailable: net',
    )
    expect(() => sdk.net.verifyHmacSha256('s', 'm', '0'.repeat(64))).toThrow(
      'capability_unavailable: net',
    )
  })
})

describe('createSdk 能力面', () => {
  it('log 加插件 id 前缀（前缀取自 manifest，不是写死的）', () => {
    const host = hostOf()
    createSdk(host, manifestOf(['spawn'], 'command')).log('退出码 0')
    expect(host.log).toHaveBeenCalledTimes(1)
    expect(host.log).toHaveBeenCalledWith('[plugin:command] 退出码 0')
  })

  it('now 原样返回毫秒数', () => {
    const sdk = createSdk(hostOf(), manifestOf([]))
    expect(sdk.now()).toBe(1_700_000_000_123)
    expect(Number.isInteger(sdk.now())).toBe(true)
  })

  it('paths 原样代理（不复制、sessionRoot 可为 null）', () => {
    const host = hostOf()
    expect(createSdk(host, manifestOf([])).paths).toBe(host.paths)

    const bare: SdkHost = { ...hostOf(), paths: { sessionRoot: null } }
    expect(createSdk(bare, manifestOf([])).paths.sessionRoot).toBeNull()
  })

  it('config 原样代理，泛型只影响调用方类型', () => {
    const sdk = createSdk(hostOf(), manifestOf([]))
    expect(sdk.config<{ mode: string }>().mode).toBe('dsh')
  })

  it('能力面：log/now/paths/config/process/net/notify，不提供 emit/fs', () => {
    const sdk = createSdk(hostOf(), manifestOf(['spawn', 'net']))
    expect(Object.keys(sdk).sort()).toEqual([
      'config',
      'log',
      'net',
      'notify',
      'now',
      'paths',
      'process',
    ])
    expect('emit' in sdk).toBe(false)
    expect('fs' in sdk).toBe(false)
  })
})
