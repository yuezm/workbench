// @vitest-environment node
/**
 * source 宿主 hub（M7 T4）：启停、事件转发（唯一入口 `event.received`）、失败隔离、
 * 状态记录与 stopAll 幂等。全部用假来源/假 effects，不涉及真实网络与数据库。
 */
import { describe, expect, it, vi } from 'vitest'
import type { RawEvent } from '../../src/protocol/inputs'
import type { PluginManifest } from '../../src/protocol/manifest'
import type { SdkHost, SourceContext } from '../../src/sdk/types'
import {
  createSources,
  type SourceRegistryEntry,
  type SourcesEffects,
} from '../../src/host/sources'

const AT = '2026-01-01T00:00:00.000Z'

const MANIFEST = (id: string): PluginManifest => ({
  id,
  kind: 'source',
  name: id,
  version: '1.0.0',
  capabilities: [],
})

const fakeSdkHost: SdkHost = {
  log: vi.fn(),
  now: () => Date.parse(AT),
  paths: { sessionRoot: null },
  config: <T = Record<string, unknown>>() => ({}) as T,
  process: {
    spawn: () => {
      throw new Error('来源不启动子进程')
    },
    resolve: (command) => ({ path: null, error: `来源不解析命令：${command}` }),
    killTree: () => false,
    scanDirs: () => [],
    findInDirs: () => null,
  },
}

interface FakeEntryOptions {
  /** start 里额外要做的事（抛错即模拟启动失败） */
  start?: (ctx: SourceContext) => void | Promise<void>
  /** dispose 里额外要做的事（抛错即模拟 dispose 失败） */
  dispose?: () => void
}

type FakeEntry = SourceRegistryEntry & {
  /** start 收到的上下文（每次 start 一项） */
  contexts: SourceContext[]
  /** dispose 被调用的次数 */
  disposed: number
}

/** 一个假来源：记录上下文与 dispose 次数，行为由 options 注入。 */
function fakeEntry(key: string, options: FakeEntryOptions = {}): FakeEntry {
  const contexts: SourceContext[] = []
  const state = { disposed: 0 }
  return {
    key,
    label: key,
    manifest: MANIFEST(key),
    plugin: {
      async start(ctx: SourceContext): Promise<() => void> {
        contexts.push(ctx)
        if (options.start !== undefined) await options.start(ctx)
        return () => {
          state.disposed += 1
          if (options.dispose !== undefined) options.dispose()
        }
      },
    },
    get contexts() {
      return contexts
    },
    get disposed() {
      return state.disposed
    },
  }
}

interface Harness {
  hub: ReturnType<typeof createSources>
  dispatch: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
}

function harness(options: {
  entries: SourceRegistryEntry[]
  configs?: Record<string, Record<string, unknown>>
  enabled?: (entry: SourceRegistryEntry) => boolean
}): Harness {
  const log = vi.fn()
  const dispatch = vi.fn(() => ({ facts: [] }))
  const hub = createSources({
    entries: options.entries,
    sdkHost: fakeSdkHost,
    effects: { dispatch } as unknown as SourcesEffects,
    configOf: (entry) => options.configs?.[entry.key] ?? {},
    isEnabled: options.enabled ?? (() => true),
    log,
  })
  return { hub, dispatch, log }
}

const event = (over: Partial<RawEvent> = {}): RawEvent => ({
  source: 'hook',
  type: 'issues.opened',
  subject: 'issue-1',
  ...over,
})

describe('source hub：启动与事件转发', () => {
  it('startAll 逐条启动，emit → event.received（hops=1、originRunId=null）', async () => {
    const first = fakeEntry('first')
    const second = fakeEntry('second')
    const { hub, dispatch } = harness({ entries: [first, second] })

    await hub.startAll()

    expect(first.contexts).toHaveLength(1)
    expect(second.contexts).toHaveLength(1)
    expect(hub.statuses()).toEqual([
      { key: 'first', state: 'running', error: null },
      { key: 'second', state: 'running', error: null },
    ])

    const raw = event()
    first.contexts[0].emit(raw)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({
      type: 'event.received',
      event: raw,
      hops: 1,
      originRunId: null,
    })
  })

  it('每条来源只拿到自己的配置（configOf → sdk.config）', async () => {
    let seen: Record<string, unknown> | null = null
    const entry = fakeEntry('hook', {
      start: (ctx) => {
        seen = ctx.sdk.config<Record<string, unknown>>()
      },
    })
    const { hub } = harness({ entries: [entry], configs: { hook: { port: 47615 } } })

    await hub.startAll()

    expect(seen).toEqual({ port: 47615 })
  })

  it('未启用的来源跳过并记 disabled 状态与日志', async () => {
    const enabled = fakeEntry('on')
    const disabled = fakeEntry('off')
    const { hub, log } = harness({
      entries: [enabled, disabled],
      enabled: (entry) => entry.key === 'on',
    })

    await hub.startAll()

    expect(disabled.contexts).toEqual([])
    expect(hub.statuses()).toEqual([
      { key: 'on', state: 'running', error: null },
      { key: 'off', state: 'disabled', error: null },
    ])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('来源 off 未启用'))
  })

  it('startAll 重复调用只启动一次；启动前状态为 idle', async () => {
    const start = vi.fn(async () => () => undefined)
    const entry: SourceRegistryEntry = {
      key: 'once',
      label: 'once',
      manifest: MANIFEST('once'),
      plugin: { start },
    }
    const { hub } = harness({ entries: [entry] })

    expect(hub.statuses()).toEqual([{ key: 'once', state: 'idle', error: null }])

    await hub.startAll()
    await hub.startAll()

    expect(start).toHaveBeenCalledTimes(1)
  })

  it('空清单：startAll / stopAll 都不抛错', async () => {
    const { hub } = harness({ entries: [] })

    await expect(hub.startAll()).resolves.toBeUndefined()
    await expect(hub.stopAll()).resolves.toBeUndefined()
    expect(hub.statuses()).toEqual([])
  })

  it('emit 时 effects.dispatch 抛错只记日志，不外抛', async () => {
    const entry = fakeEntry('hook')
    const { hub, dispatch, log } = harness({ entries: [entry] })
    dispatch.mockImplementation(() => {
      throw new Error('写库失败')
    })
    await hub.startAll()

    expect(() => entry.contexts[0].emit(event())).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('事件入账失败'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('写库失败'))
  })
})

describe('source hub：启动失败隔离', () => {
  it('单条 start 抛错只隔离它：其余照常启动、状态记 error、日志带原因', async () => {
    const broken = fakeEntry('broken', {
      start: () => {
        throw new Error('端口被占')
      },
    })
    const good = fakeEntry('good')
    const { hub, log } = harness({ entries: [broken, good] })

    await hub.startAll()

    expect(broken.contexts[0].signal.aborted).toBe(true)
    expect(hub.statuses()).toEqual([
      { key: 'broken', state: 'error', error: '端口被占' },
      { key: 'good', state: 'running', error: null },
    ])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('来源 broken 启动失败'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('端口被占'))
    expect(good.contexts).toHaveLength(1)
  })

  it('start 返回非函数 → 按启动失败隔离', async () => {
    const entry: SourceRegistryEntry = {
      key: 'bad-dispose',
      label: 'bad-dispose',
      manifest: MANIFEST('bad-dispose'),
      plugin: { start: async () => null as unknown as () => void },
    }
    const { hub } = harness({ entries: [entry] })

    await hub.startAll()

    expect(hub.statuses()[0].state).toBe('error')
    expect(hub.statuses()[0].error).toContain('dispose')
  })

  it('非 Error 抛错：String 兜底仍被隔离', async () => {
    const entry = fakeEntry('weird', {
      start: () => {
        throw '炸了'
      },
    })
    const { hub } = harness({ entries: [entry] })

    await hub.startAll()

    expect(hub.statuses()).toEqual([{ key: 'weird', state: 'error', error: '炸了' }])
  })
})

describe('source hub：停止', () => {
  it('stopAll abort + dispose，状态回 idle；可重复调用', async () => {
    const entry = fakeEntry('hook')
    const { hub } = harness({ entries: [entry] })
    await hub.startAll()

    await hub.stopAll()

    expect(entry.contexts[0].signal.aborted).toBe(true)
    expect(entry.disposed).toBe(1)
    expect(hub.statuses()).toEqual([{ key: 'hook', state: 'idle', error: null }])

    await hub.stopAll()
    expect(entry.disposed).toBe(1)
  })

  it('未启动时 stopAll 直接返回', async () => {
    const entry = fakeEntry('hook')
    const { hub } = harness({ entries: [entry] })

    await expect(hub.stopAll()).resolves.toBeUndefined()
    expect(entry.disposed).toBe(0)
  })

  it('stopAll 后 emit 丢弃并记日志（不产事件）', async () => {
    const entry = fakeEntry('hook')
    const { hub, dispatch, log } = harness({ entries: [entry] })
    await hub.startAll()
    const ctx = entry.contexts[0]

    await hub.stopAll()
    ctx.emit(event())

    expect(dispatch).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('已停止，丢弃事件'))
  })

  it('单个 dispose 抛错只记日志，其余照常关闭', async () => {
    const broken = fakeEntry('broken', {
      dispose: () => {
        throw new Error('dispose 失败')
      },
    })
    const good = fakeEntry('good')
    const { hub, log } = harness({ entries: [broken, good] })
    await hub.startAll()

    await expect(hub.stopAll()).resolves.toBeUndefined()

    expect(broken.disposed).toBe(1)
    expect(good.disposed).toBe(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('broken dispose 失败'))
  })

  it('stopAll 后可再次 startAll（重启装配根用）', async () => {
    const entry = fakeEntry('hook')
    const { hub } = harness({ entries: [entry] })

    await hub.startAll()
    await hub.stopAll()
    await hub.startAll()

    expect(entry.contexts).toHaveLength(2)
    expect(hub.statuses()).toEqual([{ key: 'hook', state: 'running', error: null }])
  })
})
