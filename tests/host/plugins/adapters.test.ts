// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../../src/protocol/entities'
import type { ChannelContext } from '../../../src/protocol/channels'
import type { PluginManifest } from '../../../src/protocol/manifest'
import { PLUGIN_HOST_PROTOCOL_VERSION } from '../../../src/protocol/plugin-host'
import type { RawEvent } from '../../../src/protocol/inputs'
import type { SourceContext } from '../../../src/sdk/types'
import type { Spawned, SpawnFn } from '../../../src/sdk/types'
import {
  createExternalChannelPlugin,
  createExternalSourcePlugin,
  type ExternalAdapterOptions,
} from '../../../src/host/plugins/adapters'
import type { ExternalPluginEntry } from '../../../src/host/plugins/discover'
import { fakeSdk } from '../../plugins/support/fake-sdk'

/**
 * 外部插件适配层（M7）：假 spawn + 假流，验证「帧 → SourcePlugin / ChannelPlugin 上下文」
 * 的转发与失败隔离；进程状态机本身由 `process.test.ts` 覆盖，这里不重复。
 */

interface FakeChild {
  spawned: Spawned
  stdout: EventEmitter
  stderr: EventEmitter
  frames: string[]
  close: (code: number | null, signal: string | null) => void
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(pid = 200): FakeChild {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const frames: string[] = []
  const closeCallbacks: Array<(code: number | null, signal: string | null) => void> = []
  const kill = vi.fn()
  const spawned: Spawned = {
    pid,
    stdin: {
      write: (chunk: string): boolean => {
        frames.push(chunk)
        return true
      },
    } as unknown as NodeJS.WritableStream,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    onError: () => undefined,
    onClose: (callback) => {
      closeCallbacks.push(callback)
    },
    kill,
  }
  return {
    spawned,
    stdout,
    stderr,
    frames,
    close: (code, signal) => {
      for (const callback of closeCallbacks) callback(code, signal)
    },
    kill,
  }
}

function spawnQueue(): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawn = vi.fn<SpawnFn>(() => {
    const child = fakeChild(200 + children.length)
    children.push(child)
    return child.spawned
  })
  return { spawn, children }
}

const framesOf = (child: FakeChild): Array<Record<string, unknown>> =>
  child.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>)

function entryOf(kind: 'source' | 'channel'): ExternalPluginEntry {
  const manifest: PluginManifest = {
    id: 'demo',
    kind,
    name: 'Demo',
    version: '1.0.0',
    capabilities: ['net'],
  }
  return {
    kind,
    id: 'demo',
    manifest,
    dir: `C:/userData/plugins/${kind}/demo`,
    entry: `C:/userData/plugins/${kind}/demo/plugin.mjs`,
    overridesBuiltin: false,
  }
}

const hello = (child: FakeChild): void => {
  child.stdout.emit(
    'data',
    `${JSON.stringify({
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'hello',
      id: 'demo',
      kind: 'source',
      version: '1.0.0',
      capabilities: ['net'],
    })}\n`,
  )
}

const helloChannel = (child: FakeChild): void => {
  child.stdout.emit(
    'data',
    `${JSON.stringify({
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'hello',
      id: 'demo',
      kind: 'channel',
      version: '1.0.0',
      capabilities: ['net'],
    })}\n`,
  )
}

const emitFrame = (child: FakeChild, frame: Record<string, unknown>): void => {
  child.stdout.emit('data', `${JSON.stringify({ v: PLUGIN_HOST_PROTOCOL_VERSION, ...frame })}\n`)
}

const disposers: Array<() => Promise<void> | void> = []
const controllers: AbortController[] = []

function optionsOf(
  spawn: SpawnFn,
  overrides: Partial<ExternalAdapterOptions> = {},
): ExternalAdapterOptions {
  return {
    execPath: 'C:/app/electron.exe',
    spawn,
    granted: ['net'],
    config: { port: 47_615 },
    log: () => undefined,
    killTree: () => true,
    helloTimeoutMs: 1_000,
    restartDelayMs: 1,
    stopGraceMs: 5,
    ...overrides,
  }
}

interface SourceHarness {
  ctx: SourceContext
  controller: AbortController
  emitted: RawEvent[]
}

function sourceHarness(): SourceHarness {
  const controller = new AbortController()
  controllers.push(controller)
  const emitted: RawEvent[] = []
  return {
    controller,
    emitted,
    ctx: {
      sdk: fakeSdk(),
      emit: (event) => emitted.push(event),
      signal: controller.signal,
    },
  }
}

interface ChannelHarness {
  ctx: ChannelContext
  controller: AbortController
  delivered: ReturnType<typeof vi.fn>
  answer: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  emitCard: (card: Card) => void
}

function channelHarness(): ChannelHarness {
  const controller = new AbortController()
  controllers.push(controller)
  let handler: ((card: Card) => void) | null = null
  const unsubscribe = vi.fn()
  const delivered = vi.fn(async () => undefined)
  const answer = vi.fn(async () => undefined)
  return {
    controller,
    delivered,
    answer,
    unsubscribe,
    emitCard: (card) => handler?.(card),
    ctx: {
      sdk: fakeSdk(),
      onCard: (callback) => {
        handler = callback
        return unsubscribe
      },
      delivered,
      answer,
      signal: controller.signal,
    },
  }
}

const card: Card = {
  id: 'card-1',
  runId: 'run-1',
  taskId: null,
  conversationId: null,
  title: '待审批',
  text: '正文',
  options: ['继续', '终止'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  for (const dispose of disposers.splice(0)) await dispose()
  vi.restoreAllMocks()
})

describe('createExternalSourcePlugin', () => {
  it('start 后 event 帧 → ctx.emit；log 帧走日志；dispose 停止子进程', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const killTree = vi.fn(() => true)
    const plugin = createExternalSourcePlugin(
      entryOf('source'),
      optionsOf(spawn, { log, killTree }),
    )
    const harness = sourceHarness()

    const started = plugin.start(harness.ctx)
    hello(children[0])
    const dispose = await started
    disposers.push(dispose)

    const event = { source: 'demo', type: 'issues.opened', subject: 'issue-1' }
    emitFrame(children[0], { type: 'event', event })
    expect(harness.emitted).toEqual([event])

    emitFrame(children[0], { type: 'log', line: '轮询开始' })
    expect(log).toHaveBeenCalledWith('[plugin:demo] 轮询开始')

    await dispose()
    expect(framesOf(children[0])).toContainEqual({
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'shutdown',
    })
    expect(killTree).toHaveBeenCalled()
  })

  it('source 收到 delivered/answer 帧只记日志（不猜测语义）', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const plugin = createExternalSourcePlugin(entryOf('source'), optionsOf(spawn, { log }))
    const harness = sourceHarness()
    const started = plugin.start(harness.ctx)
    hello(children[0])
    disposers.push(await started)

    emitFrame(children[0], { type: 'delivered', cardId: 'c1', version: 1, ref: 'x' })
    expect(log).toHaveBeenCalledWith('[plugin:demo] 忽略 source 不支持的帧：delivered')
  })

  it('ctx.emit 抛错只记日志，不打断子进程', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const plugin = createExternalSourcePlugin(entryOf('source'), optionsOf(spawn, { log }))
    const controller = new AbortController()
    controllers.push(controller)
    const ctx: SourceContext = {
      sdk: fakeSdk(),
      emit: () => {
        throw new Error('规则层异常')
      },
      signal: controller.signal,
    }
    const started = plugin.start(ctx)
    hello(children[0])
    disposers.push(await started)

    emitFrame(children[0], {
      type: 'event',
      event: { source: 'demo', type: 'issues.opened', subject: 'issue-1' },
    })
    expect(log).toHaveBeenCalledWith('[plugin:demo] 事件投递失败：规则层异常')
  })

  it('start 失败：返回空 dispose 并由 onStatus 上报 error', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      throw new Error('ENOENT')
    })
    const statuses: Array<{ status: string; error: string | null }> = []
    const log = vi.fn()
    const plugin = createExternalSourcePlugin(
      entryOf('source'),
      optionsOf(spawn, {
        restartMax: 0,
        log,
        onStatus: (status, error) => statuses.push({ status, error }),
      }),
    )
    const harness = sourceHarness()

    const dispose = await plugin.start(harness.ctx)
    expect(typeof dispose).toBe('function')
    expect(dispose()).toBeUndefined()
    expect(statuses.at(-1)?.status).toBe('error')
    expect(statuses.at(-1)?.error).toContain('启动失败')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('启动失败'))
  })

  it('ctx.signal abort 时停止子进程', async () => {
    const { spawn, children } = spawnQueue()
    const options = optionsOf(spawn)
    const plugin = createExternalSourcePlugin(entryOf('source'), options)
    const harness = sourceHarness()
    const started = plugin.start(harness.ctx)
    hello(children[0])
    disposers.push(await started)

    harness.controller.abort()
    await vi.waitFor(() =>
      expect(framesOf(children[0])).toContainEqual({
        v: PLUGIN_HOST_PROTOCOL_VERSION,
        type: 'shutdown',
      }),
    )
  })

  it('signal 已 abort：不 spawn，返回空 dispose', async () => {
    const { spawn } = spawnQueue()
    const plugin = createExternalSourcePlugin(entryOf('source'), optionsOf(spawn))
    const harness = sourceHarness()
    harness.controller.abort()

    const dispose = await plugin.start(harness.ctx)
    expect(spawn).not.toHaveBeenCalled()
    expect(dispose()).toBeUndefined()
  })

  it('kind 不匹配时构造即抛错（source 适配器只接 source）', () => {
    const { spawn } = spawnQueue()
    expect(() => createExternalSourcePlugin(entryOf('channel'), optionsOf(spawn))).toThrow(
      /adapter_kind_mismatch/,
    )
  })
})

describe('createExternalChannelPlugin', () => {
  it('start 后卡片 → card 帧；delivered / answer 帧 → 宿主回调', async () => {
    const { spawn, children } = spawnQueue()
    const plugin = createExternalChannelPlugin(entryOf('channel'), optionsOf(spawn))
    const harness = channelHarness()
    const started = plugin.start(harness.ctx)
    helloChannel(children[0])
    disposers.push(await started)

    harness.emitCard(card)
    expect(framesOf(children[0])).toContainEqual({
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'card',
      card,
    })

    emitFrame(children[0], { type: 'delivered', cardId: 'card-1', version: 2, ref: 'demo' })
    emitFrame(children[0], { type: 'answer', cardId: 'card-1', optionIndex: 1 })
    await vi.waitFor(() => expect(harness.delivered).toHaveBeenCalledWith('card-1', 2, 'demo'))
    await vi.waitFor(() => expect(harness.answer).toHaveBeenCalledWith('card-1', 1))
  })

  it('delivered / answer 回调失败只记日志（不打断进程）', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const plugin = createExternalChannelPlugin(entryOf('channel'), optionsOf(spawn, { log }))
    const harness = channelHarness()
    harness.delivered.mockRejectedValue(new Error('内核拒绝'))
    harness.answer.mockRejectedValue(new Error('卡片已关闭'))
    const started = plugin.start(harness.ctx)
    helloChannel(children[0])
    disposers.push(await started)

    emitFrame(children[0], { type: 'delivered', cardId: 'card-1', version: 1, ref: 'demo' })
    emitFrame(children[0], { type: 'answer', cardId: 'card-1', optionIndex: 0 })
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('投递回执失败')),
    )
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('答案回传失败')),
    )
  })

  it('channel 收到 event 帧只记日志（事件入口唯一）', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const plugin = createExternalChannelPlugin(entryOf('channel'), optionsOf(spawn, { log }))
    const harness = channelHarness()
    const started = plugin.start(harness.ctx)
    helloChannel(children[0])
    disposers.push(await started)

    emitFrame(children[0], {
      type: 'event',
      event: { source: 'demo', type: 'x.y', subject: 's' },
    })
    expect(log).toHaveBeenCalledWith('[plugin:demo] 忽略 channel 不支持的帧：event')
  })

  it('子进程未就绪时卡片帧丢弃并记日志', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const plugin = createExternalChannelPlugin(
      entryOf('channel'),
      optionsOf(spawn, { log, restartDelayMs: 1_000 }),
    )
    const harness = channelHarness()
    const started = plugin.start(harness.ctx)
    helloChannel(children[0])
    disposers.push(await started)

    // 崩溃后进入 starting：卡片帧发不出去
    children[0].close(1, null)
    harness.emitCard(card)
    expect(log).toHaveBeenCalledWith('[plugin:demo] 卡片帧未送达（子进程未就绪）')
  })

  it('dispose 退订卡片并停止子进程；可重复调用', async () => {
    const { spawn, children } = spawnQueue()
    const killTree = vi.fn(() => true)
    const plugin = createExternalChannelPlugin(entryOf('channel'), optionsOf(spawn, { killTree }))
    const harness = channelHarness()
    const started = plugin.start(harness.ctx)
    helloChannel(children[0])
    const dispose = await started

    await dispose()
    await dispose()
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1)
    expect(framesOf(children[0])).toContainEqual({
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'shutdown',
    })
    expect(killTree).toHaveBeenCalled()
  })

  it('start 失败返回空 dispose；abort 停止子进程', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      throw new Error('ENOENT')
    })
    const plugin = createExternalChannelPlugin(
      entryOf('channel'),
      optionsOf(spawn, { restartMax: 0 }),
    )
    const harness = channelHarness()
    const dispose = await plugin.start(harness.ctx)
    expect(typeof dispose).toBe('function')
    expect(dispose()).toBeUndefined()

    const { spawn: spawnOk, children } = spawnQueue()
    const pluginOk = createExternalChannelPlugin(entryOf('channel'), optionsOf(spawnOk))
    const harnessOk = channelHarness()
    const started = pluginOk.start(harnessOk.ctx)
    helloChannel(children[0])
    disposers.push(await started)
    harnessOk.controller.abort()
    await vi.waitFor(() =>
      expect(framesOf(children[0])).toContainEqual({
        v: PLUGIN_HOST_PROTOCOL_VERSION,
        type: 'shutdown',
      }),
    )
  })

  it('kind 不匹配时构造即抛错（channel 适配器只接 channel）', () => {
    const { spawn } = spawnQueue()
    expect(() => createExternalChannelPlugin(entryOf('source'), optionsOf(spawn))).toThrow(
      /adapter_kind_mismatch/,
    )
  })
})

describe('适配层覆盖率收口：缺省日志与边界', () => {
  it('缺省日志：source 启动失败落 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const spawn = vi.fn<SpawnFn>(() => {
      throw new Error('ENOENT')
    })
    const plugin = createExternalSourcePlugin(
      entryOf('source'),
      optionsOf(spawn, { restartMax: 0, log: undefined }),
    )

    const dispose = await plugin.start(sourceHarness().ctx)
    expect(typeof dispose).toBe('function')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('启动失败'))
  })

  it('缺省日志：channel 启动失败落 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const spawn = vi.fn<SpawnFn>(() => {
      throw new Error('ENOENT')
    })
    const plugin = createExternalChannelPlugin(
      entryOf('channel'),
      optionsOf(spawn, { restartMax: 0, log: undefined }),
    )

    const dispose = await plugin.start(channelHarness().ctx)
    expect(typeof dispose).toBe('function')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('启动失败'))
  })

  it('ctx.emit 抛非 Error：日志记录字符串值（不打断子进程）', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const plugin = createExternalSourcePlugin(entryOf('source'), optionsOf(spawn, { log }))
    const controller = new AbortController()
    controllers.push(controller)
    const ctx: SourceContext = {
      sdk: fakeSdk(),
      emit: () => {
        throw '字符串错误'
      },
      signal: controller.signal,
    }
    const started = plugin.start(ctx)
    hello(children[0])
    disposers.push(await started)

    emitFrame(children[0], {
      type: 'event',
      event: { source: 'demo', type: 'issues.opened', subject: 'issue-1' },
    })
    expect(log).toHaveBeenCalledWith('[plugin:demo] 事件投递失败：字符串错误')
  })

  it('channel 的 signal 已 abort：不 spawn，返回空 dispose', async () => {
    const { spawn } = spawnQueue()
    const plugin = createExternalChannelPlugin(entryOf('channel'), optionsOf(spawn))
    const harness = channelHarness()
    harness.controller.abort()

    const dispose = await plugin.start(harness.ctx)
    expect(spawn).not.toHaveBeenCalled()
    expect(dispose()).toBeUndefined()
  })
})
