// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from '../../../src/protocol/manifest'
import { PLUGIN_HOST_LIMITS, PLUGIN_HOST_PROTOCOL_VERSION } from '../../../src/protocol/plugin-host'
import {
  createExternalPluginProcess,
  type ExternalPluginProcess,
  type ExternalPluginProcessOptions,
} from '../../../src/host/plugins/process'
import type { Spawned, SpawnFn } from '../../../src/sdk/types'

/**
 * 外部插件子进程宿主（M7 D2）：用假 spawn / 假流覆盖 hello 握手、帧收发、崩溃重拉与停止，
 * **不真起进程**。时间参数全部缩短（hello 20 ms、重拉 1 ms、停止宽限 5 ms）。
 */

const manifest: PluginManifest = {
  id: 'demo',
  kind: 'source',
  name: 'Demo',
  version: '1.0.0',
  capabilities: ['net'],
}

const DIR = 'C:/userData/plugins/source/demo'
const EXEC_PATH = 'C:/app/electron.exe'

type StdinMode = 'ok' | 'throw' | 'none'

interface FakeChild {
  spawned: Spawned
  stdout: EventEmitter
  stderr: EventEmitter
  /** 宿主写入子进程 stdin 的帧（原样文本，含换行） */
  frames: string[]
  /** 切换为 true 后 stdin.write 抛错（模拟管道断开） */
  setThrowWrites: (value: boolean) => void
  close: (code: number | null, signal: string | null) => void
  emitError: (error: Error) => void
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(pid = 100, stdinMode: StdinMode = 'ok'): FakeChild {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const frames: string[] = []
  const closeCallbacks: Array<(code: number | null, signal: string | null) => void> = []
  const errorCallbacks: Array<(error: Error) => void> = []
  let throwWrites = stdinMode === 'throw'
  const stdin =
    stdinMode === 'none'
      ? null
      : ({
          write: (chunk: string): boolean => {
            if (throwWrites) throw new Error('EPIPE')
            frames.push(chunk)
            return true
          },
        } as unknown as NodeJS.WritableStream)
  const kill = vi.fn()
  const spawned: Spawned = {
    pid,
    stdin,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    onError: (callback) => {
      errorCallbacks.push(callback)
    },
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
    setThrowWrites: (value) => {
      throwWrites = value
    },
    close: (code, signal) => {
      for (const callback of closeCallbacks) callback(code, signal)
    },
    emitError: (error) => {
      for (const callback of errorCallbacks) callback(error)
    },
    kill,
  }
}

/** 依次返回假子进程的 spawn：每次调用产出一个新 child。 */
function spawnQueue(stdinMode: StdinMode = 'ok'): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawn = vi.fn<SpawnFn>(() => {
    const child = fakeChild(100 + children.length, stdinMode)
    children.push(child)
    return child.spawned
  })
  return { spawn, children }
}

const helloFrame = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PLUGIN_HOST_PROTOCOL_VERSION,
  type: 'hello',
  id: manifest.id,
  kind: manifest.kind,
  version: manifest.version,
  capabilities: [...manifest.capabilities],
  ...overrides,
})

const sendLine = (child: FakeChild, value: unknown): void => {
  child.stdout.emit('data', `${JSON.stringify(value)}\n`)
}

const sendHello = (child: FakeChild, overrides: Record<string, unknown> = {}): void => {
  sendLine(child, helloFrame(overrides))
}

/** 已下发到 stdin 的帧（JSON.parse 后）。 */
const framesOf = (child: FakeChild): Array<Record<string, unknown>> =>
  child.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>)

const processes: ExternalPluginProcess[] = []

function makeProcess(overrides: Partial<ExternalPluginProcessOptions> = {}): ExternalPluginProcess {
  const process = createExternalPluginProcess({
    manifest,
    dir: DIR,
    execPath: EXEC_PATH,
    spawn: spawnQueue().spawn,
    helloTimeoutMs: 20,
    restartDelayMs: 1,
    stopGraceMs: 5,
    killTree: () => true,
    log: () => undefined,
    ...overrides,
  })
  processes.push(process)
  return process
}

afterEach(async () => {
  for (const process of processes.splice(0)) await process.dispose()
  vi.restoreAllMocks()
})

describe('外部插件子进程启动与 hello 握手', () => {
  it('spawn 参数：execPath + plugin.mjs、cwd 为插件目录、环境含 ELECTRON_RUN_AS_NODE', async () => {
    const { spawn, children } = spawnQueue()
    const process = makeProcess({ spawn })

    const started = process.start()
    expect(spawn).toHaveBeenCalledWith(EXEC_PATH, ['plugin.mjs'], {
      cwd: DIR,
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
      shell: false,
    })
    expect(process.status()).toBe('starting')

    sendHello(children[0])
    await started
    expect(process.status()).toBe('ready')
  })

  it('hello 通过后下发 welcome（授权能力 + config），secret 只走管道', async () => {
    const { spawn, children } = spawnQueue()
    const process = makeProcess({ spawn, config: { port: 47_615, token: 'secret-value' } })

    const started = process.start()
    sendHello(children[0])
    await started

    expect(framesOf(children[0])).toEqual([
      {
        v: PLUGIN_HOST_PROTOCOL_VERSION,
        type: 'welcome',
        pluginId: 'demo',
        granted: ['net'],
        config: { port: 47_615, token: 'secret-value' },
      },
    ])
  })

  it('hello 自报身份与 manifest 不一致：终止且不重拉（协议违规）', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const killTree = vi.fn(() => true)
    const process = makeProcess({ spawn, log, killTree })

    const started = process.start()
    sendHello(children[0], { version: '2.0.0' })

    await expect(started).rejects.toThrow(/plugin_start_failed.*version/)
    expect(process.status()).toBe('error')
    expect(children).toHaveLength(1)
    expect(killTree).toHaveBeenCalledWith(children[0].spawned.pid, 'SIGKILL')
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('hello 自报的 version 与 manifest 不一致'),
    )
  })

  it('hello 超时按崩溃处理：重拉上限内重试，耗尽后 status=error 且 start reject', async () => {
    const { spawn, children } = spawnQueue()
    const process = makeProcess({ spawn, helloTimeoutMs: 5, restartDelayMs: 1, restartMax: 2 })

    await expect(process.start()).rejects.toThrow(/plugin_start_failed.*hello 超时/)
    expect(process.status()).toBe('error')
    // 首次 + 2 次重拉
    expect(children).toHaveLength(3)
    expect(process.lastError()).toContain('插件连续失败 3 次')
  })

  it('spawn 同步抛错同样按失败重拉，耗尽后 error', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      throw new Error('ENOENT')
    })
    const process = makeProcess({ spawn, restartMax: 1, restartDelayMs: 1 })
    await expect(process.start()).rejects.toThrow(/plugin_start_failed.*启动失败.*ENOENT/)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(process.status()).toBe('error')
  })

  it('子进程 stdin 不可用：hello 后无法下发 welcome，按协议失败终止', async () => {
    const { spawn, children } = spawnQueue('none')
    const killTree = vi.fn(() => true)
    const process = makeProcess({ spawn, killTree })
    const started = process.start()
    sendHello(children[0])
    await expect(started).rejects.toThrow(/plugin_start_failed.*stdin/)
    expect(process.status()).toBe('error')
    expect(killTree).toHaveBeenCalledWith(children[0].spawned.pid, 'SIGKILL')
  })

  it('重复 hello 被忽略并记日志', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const process = makeProcess({ spawn, log })
    const started = process.start()
    sendHello(children[0])
    await started
    sendHello(children[0])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('忽略重复 hello'))
  })

  it('start 幂等：已 ready 时再次调用直接 resolve', async () => {
    const { spawn, children } = spawnQueue()
    const process = makeProcess({ spawn })
    const started = process.start()
    sendHello(children[0])
    await started
    await expect(process.start()).resolves.toBeUndefined()
    expect(children).toHaveLength(1)
  })
})

describe('帧收发', () => {
  async function readyProcess(
    overrides: Partial<ExternalPluginProcessOptions> = {},
  ): Promise<{ process: ExternalPluginProcess; child: FakeChild; children: FakeChild[] }> {
    const { spawn, children } = spawnQueue()
    const process = makeProcess({ spawn, ...overrides })
    const started = process.start()
    sendHello(children[0])
    await started
    return { process, child: children[0], children }
  }

  it('log 帧经宿主日志通道并加插件前缀；非法帧只记长度不落原文', async () => {
    const log = vi.fn()
    const { child } = await readyProcess({ log })

    sendLine(child, { v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'log', line: '轮询开始' })
    expect(log).toHaveBeenCalledWith('[plugin:demo] 轮询开始')

    child.stdout.emit('data', 'not-json\n')
    expect(log).toHaveBeenCalledWith('[plugin:demo] 丢弃非法帧（8 字节）')
  })

  it('event / delivered / answer 帧交给 onFrame；log 帧不上抛', async () => {
    const onFrame = vi.fn()
    const { child } = await readyProcess({ onFrame })

    const event = { source: 'demo', type: 'issues.opened', subject: 'issue-1' }
    sendLine(child, { v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'event', event })
    sendLine(child, {
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'delivered',
      cardId: 'c1',
      version: 2,
      ref: 'demo',
    })
    sendLine(child, {
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'answer',
      cardId: 'c1',
      optionIndex: 1,
    })
    sendLine(child, { v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'log', line: 'x' })

    expect(onFrame).toHaveBeenCalledTimes(3)
    expect(onFrame).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'event' }))
    expect(onFrame).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'delivered' }))
    expect(onFrame).toHaveBeenNthCalledWith(3, expect.objectContaining({ type: 'answer' }))
  })

  it('onFrame 抛错只记日志，不影响后续帧', async () => {
    const log = vi.fn()
    const onFrame = vi.fn(() => {
      throw new Error('上层失败')
    })
    const { child } = await readyProcess({ log, onFrame })
    sendLine(child, {
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'delivered',
      cardId: 'c1',
      version: 1,
      ref: 'x',
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('帧处理失败（delivered）'))
  })

  it('超长输出行在行缓冲层丢弃（不无限积累），只记一条告警', async () => {
    const log = vi.fn()
    const onFrame = vi.fn()
    const { child } = await readyProcess({ log, onFrame })

    child.stdout.emit('data', 'x'.repeat(64 * 1024 + 1))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('丢弃超过 65536 字节的输出行'))
    // 同一超长行后续分片不再重复告警
    child.stdout.emit('data', 'tail')
    child.stdout.emit('data', '\n')
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('stderr 行与超长行都经日志通道（截断，不落正文）', async () => {
    const log = vi.fn()
    const { child } = await readyProcess({ log })

    child.stderr.emit('data', 'warning: 慢\n')
    expect(log).toHaveBeenCalledWith('[plugin:demo] stderr: warning: 慢')

    child.stderr.emit('data', 'y'.repeat(2_001))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('丢弃超长 stderr 行'))
  })

  it('流 end 时 flush 剩余半行（按非法帧丢弃）', async () => {
    const log = vi.fn()
    const { child } = await readyProcess({ log })
    child.stdout.emit('data', '{"v":1')
    child.stdout.emit('end')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('丢弃非法帧'))
  })

  it('send：未就绪返回 false；就绪后写入 stdin；写失败返回 false 并记日志', async () => {
    const log = vi.fn()
    const { process, child } = await readyProcess({ log })

    const shutdown = { v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'shutdown' } as const
    expect(process.send(shutdown)).toBe(true)
    expect(framesOf(child)).toContainEqual(shutdown)

    // 管道断开：send 返回 false 且只记日志（不抛给上层）
    child.setThrowWrites(true)
    expect(process.send(shutdown)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('帧写入失败'))
  })
})

describe('崩溃重拉', () => {
  it('非 0 退出后按间隔重拉，新子进程 hello 后恢复 ready', async () => {
    const { spawn, children } = spawnQueue()
    // 重拉后的子进程等测试手动发 hello（避免 hello 超时再次触发重拉）
    const process = makeProcess({ spawn, helloTimeoutMs: 10_000 })
    const started = process.start()
    sendHello(children[0])
    await started

    children[0].close(1, null)
    await vi.waitFor(() => expect(children).toHaveLength(2))
    sendHello(children[1])
    await vi.waitFor(() => expect(process.status()).toBe('ready'))
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('重拉耗尽后 status=error 并通知上层（已 ready 的 start 不受影响）', async () => {
    const { spawn, children } = spawnQueue()
    const statuses: string[] = []
    const process = makeProcess({
      spawn,
      helloTimeoutMs: 10_000,
      restartMax: 2,
      restartDelayMs: 1,
      onStatusChange: (status) => statuses.push(status),
    })
    const started = process.start()
    sendHello(children[0])
    await started

    children[0].close(1, null)
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1].close(1, null)
    await vi.waitFor(() => expect(children).toHaveLength(3))
    children[2].close(1, null)

    await vi.waitFor(() => expect(process.status()).toBe('error'))
    expect(process.lastError()).toContain('插件连续失败 3 次')
    expect(statuses).toContain('error')
  })

  it('子进程 error 事件按崩溃处理', async () => {
    const { spawn, children } = spawnQueue()
    const process = makeProcess({ spawn, helloTimeoutMs: 10_000 })
    const started = process.start()
    sendHello(children[0])
    await started

    children[0].emitError(new Error('spawn EPERM'))
    await vi.waitFor(() => expect(children).toHaveLength(2))
  })

  it('上层状态回调抛错不打断状态机', async () => {
    const { spawn, children } = spawnQueue()
    const log = vi.fn()
    const process = makeProcess({
      spawn,
      log,
      onStatusChange: () => {
        throw new Error('回调炸了')
      },
    })
    const started = process.start()
    sendHello(children[0])
    await started
    expect(log).toHaveBeenCalledWith(expect.stringContaining('状态回调失败'))
    expect(process.status()).toBe('ready')
  })

  it('停止后取消待执行的重拉（不再起新进程）', async () => {
    const { spawn, children } = spawnQueue()
    const process = makeProcess({ spawn, restartDelayMs: 10 })
    const started = process.start()
    sendHello(children[0])
    await started

    children[0].close(1, null)
    await process.stop()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(children).toHaveLength(1)
    expect(process.status()).toBe('stopped')
  })
})

describe('停止与释放', () => {
  async function readyProcess(
    overrides: Partial<ExternalPluginProcessOptions> = {},
  ): Promise<{
    process: ExternalPluginProcess
    child: FakeChild
    killTree: ReturnType<typeof vi.fn>
  }> {
    const { spawn, children } = spawnQueue()
    const killTree = vi.fn(() => true)
    const process = makeProcess({ spawn, killTree, ...overrides })
    const started = process.start()
    sendHello(children[0])
    await started
    return { process, child: children[0], killTree }
  }

  it('宽限内不退出：shutdown → SIGTERM → killTree 逐级升级', async () => {
    const { process, child, killTree } = await readyProcess()

    await process.stop()

    expect(framesOf(child)).toContainEqual({ v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'shutdown' })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(killTree).toHaveBeenCalledWith(child.spawned.pid, 'SIGKILL')
    expect(process.status()).toBe('stopped')
  })

  it('SIGTERM 后子进程退出：不再整树强杀', async () => {
    const { spawn, children } = spawnQueue()
    const killTree = vi.fn(() => true)
    const process = makeProcess({ spawn, killTree })
    const started = process.start()
    sendHello(children[0])
    await started
    const child = children[0]
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') child.close(null, signal)
    })

    await process.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(killTree).not.toHaveBeenCalled()
    expect(process.status()).toBe('stopped')
  })

  it('stop 幂等；stop 时未启动不报错', async () => {
    const process = makeProcess()
    await expect(process.stop()).resolves.toBeUndefined()
    await expect(process.stop()).resolves.toBeUndefined()
    expect(process.status()).toBe('stopped')
  })

  it('stop 时 shutdown 帧写失败只记日志（继续终止流程）', async () => {
    const log = vi.fn()
    const { spawn, children } = spawnQueue()
    const killTree = vi.fn(() => true)
    const process = makeProcess({ spawn, killTree, log })
    const started = process.start()
    sendHello(children[0])
    await started
    children[0].setThrowWrites(true)

    await process.stop()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('shutdown 帧写入失败'))
    expect(killTree).toHaveBeenCalled()
  })

  it('dispose 后再 start 直接 reject；dispose 幂等', async () => {
    const { process } = await readyProcess()
    await process.dispose()
    await expect(process.start()).rejects.toThrow(/plugin_disposed/)
    await expect(process.dispose()).resolves.toBeUndefined()
  })

  it('启动中被停止：start reject，状态 stopped', async () => {
    const { spawn, children } = spawnQueue()
    const process = makeProcess({ spawn, helloTimeoutMs: 1_000 })
    const started = process.start()
    // 先挂 reject 断言再停止，避免未处理拒绝
    const rejection = expect(started).rejects.toThrow(/plugin_stopped/)
    await process.stop()
    await rejection
    expect(process.status()).toBe('stopped')
    expect(children).toHaveLength(1)
  })

  it('子进程 close 事件在停止流程中不再触发重拉', async () => {
    const { process, child } = await readyProcess()
    child.close(0, null)
    await process.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(process.status()).toBe('stopped')
  })
})

describe('覆盖率收口：缺省值与边界', () => {
  it('缺省选项：默认日志落 console.warn；hello 自报 id 不一致即终止', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { spawn, children } = spawnQueue()
    const process = createExternalPluginProcess({ manifest, dir: DIR, execPath: EXEC_PATH, spawn })
    processes.push(process)

    const started = process.start()
    sendHello(children[0], { id: 'other' })
    await expect(started).rejects.toThrow(/plugin_start_failed.*id/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hello 自报的 id'))
    await process.stop()
  })

  it('缺省 killTree：POSIX 分支按 pid 终止进程树', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const { spawn, children } = spawnQueue()
      const proc = createExternalPluginProcess({
        manifest,
        dir: DIR,
        execPath: EXEC_PATH,
        spawn,
        stopGraceMs: 5,
      })
      processes.push(proc)
      const started = proc.start()
      sendHello(children[0])
      await started

      await proc.stop()
      expect(kill).toHaveBeenCalledWith(-(children[0].spawned.pid as number), 'SIGKILL')
    } finally {
      Object.defineProperty(process, 'platform', descriptor as PropertyDescriptor)
    }
  })

  it('killTree 返回 false：回退单进程 SIGKILL', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, killTree: () => false })
    const started = proc.start()
    sendHello(children[0])
    await started

    await proc.stop()
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('pid 缺失：跳过 killTree，直接单进程 SIGKILL', async () => {
    const child = fakeChild()
    child.spawned.pid = undefined
    const proc = makeProcess({ spawn: () => child.spawned })
    const started = proc.start()
    sendHello(child)
    await started

    await proc.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('killTree 抛非 Error：记日志并继续（不抛给调用方）', async () => {
    const log = vi.fn()
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({
      spawn,
      log,
      killTree: () => {
        throw 'tree boom'
      },
    })
    const started = proc.start()
    sendHello(children[0])
    await started

    await proc.stop()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('终止子进程失败'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('tree boom'))
  })

  it('超长输出行带换行：整行丢弃（含行内分段判定）并只告警一次', async () => {
    const log = vi.fn()
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, log })
    const started = proc.start()
    sendHello(children[0])
    await started

    children[0].stdout.emit('data', `${'x'.repeat(PLUGIN_HOST_LIMITS.frameBytes + 1)}\n`)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('丢弃超过'))
  })

  it('hello 超时期间子进程同步退出：失败只处理一次（迟到的 close 不再触发）', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, killTree: () => false, helloTimeoutMs: 5, restartMax: 0 })
    const started = proc.start()
    children[0].kill.mockImplementation(() => children[0].close(1, null))

    await expect(started).rejects.toThrow(/plugin_start_failed.*子进程退出/)
    expect(proc.status()).toBe('error')
    expect(children).toHaveLength(1)
  })

  it('旧代际输出行被丢弃（迟到的帧不进入 onFrame）', async () => {
    const onFrame = vi.fn()
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, onFrame, helloTimeoutMs: 10_000 })
    const started = proc.start()
    sendHello(children[0])
    await started

    children[0].close(1, null)
    await vi.waitFor(() => expect(children).toHaveLength(2))
    sendLine(children[0], {
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'delivered',
      cardId: 'c1',
      version: 1,
      ref: 'x',
    })
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('start 复用进行中的启动 Promise（不重复 spawn）', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn })
    const first = proc.start()
    const second = proc.start()
    expect(second).toBe(first)
    sendHello(children[0])
    await first
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('停止中调用 start：直接 reject（plugin_stopping）', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn })
    const started = proc.start()
    sendHello(children[0])
    await started

    const stopping = proc.stop()
    await expect(proc.start()).rejects.toThrow(/plugin_stopping/)
    await stopping
  })

  it('dispose 之后 stop 幂等返回', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn })
    const started = proc.start()
    sendHello(children[0])
    await started

    await proc.dispose()
    await expect(proc.stop()).resolves.toBeUndefined()
  })

  it('SIGTERM 抛错：记日志并继续整树强杀', async () => {
    const log = vi.fn()
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, log })
    const started = proc.start()
    sendHello(children[0])
    await started
    children[0].kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') throw new Error('kill boom')
    })

    await proc.stop()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SIGTERM 失败'))
  })

  it('并发 stop：第二次直接返回（幂等，不重复终止）', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn })
    const started = proc.start()
    sendHello(children[0])
    await started

    await Promise.all([proc.stop(), proc.stop()])
    expect(proc.status()).toBe('stopped')
  })

  it('未就绪时 send 返回 false（不写 stdin）', () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn })
    expect(proc.send({ v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'shutdown' })).toBe(false)
    expect(children).toHaveLength(0)
  })

  it('stderr 半行在流结束时 flush 并截断', async () => {
    const log = vi.fn()
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, log })
    const started = proc.start()
    sendHello(children[0])
    await started

    children[0].stderr.emit('data', 'tail without newline')
    children[0].stderr.emit('end')
    expect(log).toHaveBeenCalledWith('[plugin:demo] stderr: tail without newline')
  })

  it('显式 env：只补 ELECTRON_RUN_AS_NODE，其它键原样传入', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, env: { PATH: 'D:/bin' } })
    const started = proc.start()
    sendHello(children[0])
    await started

    expect(spawn).toHaveBeenCalledWith(EXEC_PATH, ['plugin.mjs'], {
      cwd: DIR,
      env: { PATH: 'D:/bin', ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
    })
  })

  it('hello kind / capabilities 不一致：终止且不重拉', async () => {
    for (const overrides of [{ kind: 'channel' }, { capabilities: [] }]) {
      const { spawn, children } = spawnQueue()
      const proc = makeProcess({ spawn })
      const started = proc.start()
      sendHello(children[0], overrides)
      await expect(started).rejects.toThrow(/plugin_start_failed/)
      expect(children).toHaveLength(1)
    }
  })

  it('空行与流结束时无剩余半行：不产生帧、不告警', async () => {
    const log = vi.fn()
    const onFrame = vi.fn()
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, log, onFrame })
    const started = proc.start()
    sendHello(children[0])
    await started

    children[0].stdout.emit('data', '\n')
    children[0].stdout.emit('end')
    expect(onFrame).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('非法帧'))
  })

  it('stdout / stderr 缺失的子进程：不挂流监听，hello 超时按失败处理', async () => {
    const child = fakeChild()
    child.spawned.stdout = null
    child.spawned.stderr = null
    const proc = makeProcess({ spawn: () => child.spawned, helloTimeoutMs: 5, restartMax: 0 })
    await expect(proc.start()).rejects.toThrow(/plugin_start_failed.*hello 超时/)
    expect(proc.status()).toBe('error')
  })

  it('重拉等待期间调用 start：复用等待，不重复 spawn', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn, helloTimeoutMs: 10_000, restartDelayMs: 5 })
    const started = proc.start()
    sendHello(children[0])
    await started

    children[0].close(1, null)
    // 崩溃后进入 starting（重启定时器待执行）：此时的 start 只等就绪，不再触发 spawn
    const restarted = proc.start()
    await vi.waitFor(() => expect(children).toHaveLength(2))
    sendHello(children[1])
    await restarted
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('shutdown 帧发出后子进程即退出：不再发 SIGTERM', async () => {
    const { spawn, children } = spawnQueue()
    const proc = makeProcess({ spawn })
    const started = proc.start()
    sendHello(children[0])
    await started
    const stdin = children[0].spawned.stdin as unknown as { write: (chunk: string) => boolean }
    stdin.write = () => {
      children[0].close(0, null)
      return true
    }

    await proc.stop()
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(proc.status()).toBe('stopped')
  })
})
