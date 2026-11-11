// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, Runtime } from '../../../../src/protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../../src/protocol/executor'
import type { ExecutorContext, SpawnFn, SpawnOptions, Spawned } from '../../../../src/sdk/types'
import {
  ACP_PROTOCOL_VERSION,
  CANCEL_GRACE_MS,
  KILL_GRACE_MS,
  MODELS_TIMEOUT_MS,
  OUTPUT_TAIL_LIMIT,
  PROBE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
} from '../../../../src/plugins/executors/hermes/constants'
import { connect, stopLink, type AcpLink } from '../../../../src/plugins/executors/hermes/wire'
import { detectHermes } from '../../../../src/plugins/executors/hermes/detect'
import {
  decidePermission,
  handleSessionUpdate,
  type HermesRunState,
} from '../../../../src/plugins/executors/hermes/frames'
import {
  createAcpClient,
  feedLine,
  type AcpClient,
  type AcpHandlers,
} from '../../../../src/plugins/executors/hermes/acp'
import { hermesManifest, hermesPlugin } from '../../../../src/plugins/executors/hermes/index'
import {
  listHermesModels,
  providerOfModel,
  toRuntimeModelId,
} from '../../../../src/plugins/executors/hermes/models'
import { readCliVersion } from '../../../../src/plugins/executors/hermes/process'
import { probeHermesRuntime } from '../../../../src/plugins/executors/hermes/probe'
import { executeHermesRun, type HermesOptions } from '../../../../src/plugins/executors/hermes/run'
import { readSessionState } from '../../../../src/plugins/executors/hermes/session'
import { fakeSdk, type FakeSdkOverrides } from '../../support/fake-sdk'

/** 用 node 自身作为「存在的可执行文件」，避免依赖本机 hermes */
const NODE = process.execPath

/** 延迟（真实定时器；宽限/超时用毫秒级注入值） */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 假流：只实现插件用到的 `on('data')`，避免测试依赖 node:events */
class FakeStream {
  private readonly handlers: Array<(chunk: Buffer) => void> = []
  on(_event: string, listener: (chunk: Buffer) => void): this {
    this.handlers.push(listener)
    return this
  }
  emit(text: string): void {
    for (const handler of this.handlers) handler(Buffer.from(text))
  }
}

class FakeChild implements Spawned {
  pid: number | undefined = 4242
  writes: string[] = []
  killed: string[] = []
  stdinEnded = false
  writeThrows = false
  /** 被杀后是否模拟进程退出（真实进程收到 SIGTERM 会退） */
  closeOnKill = true
  /** 收到请求帧时的应答器（按方法名回帧） */
  handler: ((frame: Record<string, unknown>) => void) | null = null
  /** 收到「我方回的应答帧」时的钩子（审批往返用） */
  onResponse: ((frame: Record<string, unknown>) => void) | null = null
  private readonly outStream = new FakeStream()
  private readonly errStream = new FakeStream()
  readonly stdin = {
    write: (chunk: string): boolean => {
      if (this.writeThrows) throw new Error('stdin closed')
      this.writes.push(chunk)
      const frame = JSON.parse(chunk) as Record<string, unknown>
      const handler = this.handler
      if (frame.method !== undefined && handler !== null) queueMicrotask(() => handler(frame))
      const onResponse = this.onResponse
      if (frame.method === undefined && onResponse !== null) {
        queueMicrotask(() => onResponse(frame))
      }
      return true
    },
    end: (): void => {
      this.stdinEnded = true
    },
  } as unknown as NodeJS.WritableStream
  readonly stdout = this.outStream as unknown as NodeJS.ReadableStream
  readonly stderr = this.errStream as unknown as NodeJS.ReadableStream
  private errorCb: ((error: Error) => void) | null = null
  private closeCb: ((code: number | null, signal: string | null) => void) | null = null

  onError(cb: (error: Error) => void): void {
    this.errorCb = cb
  }
  onClose(cb: (code: number | null, signal: string | null) => void): void {
    this.closeCb = cb
  }
  kill(signal: NodeJS.Signals): void {
    this.killed.push(signal)
  }
  emitStdout(text: string): void {
    this.outStream.emit(text)
  }
  emitStderr(text: string): void {
    this.errStream.emit(text)
  }
  close(code: number | null = 0): void {
    this.closeCb?.(code, null)
  }
  fail(error: Error): void {
    this.errorCb?.(error)
  }
  frames(): Array<Record<string, unknown>> {
    return this.writes.map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  /** 已发出的请求方法名（按发送顺序，不含通知与应答） */
  methods(): string[] {
    return this.frames()
      .map((frame) => frame.method)
      .filter((method): method is string => typeof method === 'string')
  }
}

interface Harness {
  spawn: SpawnFn
  killTree: (pid: number, signal?: NodeJS.Signals) => boolean
  children: FakeChild[]
  killedTrees: Array<{ pid: number; signal: string | undefined }>
  calls: Array<{ command: string; args: string[]; options: SpawnOptions }>
}

/** 假 spawn：每次调用返回一个可手动驱动的子进程 */
function harness(
  respond?: (args: string[], child: FakeChild) => void,
  configure?: (child: FakeChild) => void,
): Harness {
  const children: FakeChild[] = []
  const killedTrees: Array<{ pid: number; signal: string | undefined }> = []
  const calls: Harness['calls'] = []
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild()
    // 每个子进程一个独立 pid：killTree 按 pid 找进程，多子进程时不能撞号
    child.pid = 4242 + children.length
    configure?.(child)
    children.push(child)
    calls.push({ command, args, options })
    if (respond) queueMicrotask(() => respond(args, child))
    return child
  }
  const killTree = (pid: number, signal?: NodeJS.Signals): boolean => {
    killedTrees.push({ pid, signal })
    const child = children.find((item) => item.pid === pid)
    // 真实进程被杀就会退：模拟 close，让回执按「进程已退出」收尾
    if (child !== undefined && child.closeOnKill) queueMicrotask(() => child.close(0))
    return true
  }
  return { spawn, killTree, children, killedTrees, calls }
}

/** 一行 JSONL（帧） */
const line = (value: Record<string, unknown>): string => JSON.stringify(value) + '\n'

const replyResult = (
  child: FakeChild,
  id: number | string,
  result: Record<string, unknown>,
): void => {
  child.emitStdout(line({ jsonrpc: '2.0', id, result }))
}

const replyError = (child: FakeChild, id: number | string, code: number, message: string): void => {
  child.emitStdout(line({ jsonrpc: '2.0', id, error: { code, message } }))
}

const notify = (child: FakeChild, method: string, params: Record<string, unknown>): void => {
  child.emitStdout(line({ jsonrpc: '2.0', method, params }))
}

/** `session/update` 通知 */
const update = (child: FakeChild, sessionId: string, value: Record<string, unknown>): void => {
  notify(child, 'session/update', { sessionId, update: value })
}

const initializeResult = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocolVersion: 1,
  agentInfo: { name: 'hermes-agent', version: '0.22.5' },
  agentCapabilities: { loadSession: true },
  ...over,
})

const DEFAULT_MODELS = {
  availableModels: [
    { modelId: 'opencode-go:kimi-k3', name: 'Kimi K3', description: '默认编码模型' },
    { modelId: 'custom:magpie:minimax-code/x', name: 'MiniMax', description: '自定义供应商' },
  ],
  currentModelId: 'custom:magpie:minimax-code/x',
}

const DEFAULT_MODES = {
  availableModes: [
    { id: 'default', name: 'Default', description: '只读提问' },
    { id: 'accept_edits', name: 'Accept edits', description: '可改工作区' },
    { id: 'dont_ask', name: 'Don’t ask', description: '全权' },
  ],
  currentModeId: 'default',
}

const sessionResult = (sessionId = 'sess-1'): Record<string, unknown> => ({
  sessionId,
  models: DEFAULT_MODELS,
  modes: DEFAULT_MODES,
})

type Overrides = Partial<
  Record<string, (frame: Record<string, unknown>, child: FakeChild, id: number | string) => void>
>

/** 按方法名自动回帧：默认全部成功，个别方法由 `overrides` 改写 */
function responderFor(child: FakeChild, overrides: Overrides = {}) {
  return (frame: Record<string, unknown>): void => {
    const method = typeof frame.method === 'string' ? frame.method : null
    const id = frame.id
    if (method === null) return
    if (typeof id !== 'number' && typeof id !== 'string') return
    const override = overrides[method]
    if (override !== undefined) {
      override(frame, child, id)
      return
    }
    switch (method) {
      case 'initialize':
        replyResult(child, id, initializeResult())
        return
      case 'session/new':
        replyResult(child, id, sessionResult())
        return
      case 'session/load':
        replyResult(child, id, sessionResult('sess-loaded'))
        return
      case 'session/set_mode':
      case 'session/set_model':
        replyResult(child, id, {})
        return
      case 'session/prompt':
        replyResult(child, id, { stopReason: 'end_turn' })
        return
      default:
        return
    }
  }
}

/**
 * hermes 专用夹具：`--version` 那次 spawn 直接吐版本，`acp` 那次挂上自动应答器。
 * `overrides` 用来改写某个方法的回帧（错误、自定义结果、不回帧……）。
 */
function acpHarness(overrides: Overrides = {}, configure?: (child: FakeChild) => void): Harness {
  return harness(
    (args, child) => {
      if (!args.includes('--version')) return
      child.emitStdout('Hermes Agent v0.22.5 (2026.9.24) · stable\n')
      child.close(0)
    },
    (child) => {
      // 应答器必须在 spawn 返回前就位：插件拿到子进程后会立刻写 initialize
      child.handler = responderFor(child, overrides)
      configure?.(child)
    },
  )
}

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 hermes',
  executorKey: 'hermes',
  argsTemplate: '',
  command: NODE,
  profile: '',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...over,
})

const turnOf = (over: Partial<Turn> = {}): Turn => ({
  runId: 'run-1',
  leaseId: 'lease-1',
  turn: 1,
  purpose: 'stage',
  prompt: '只回复 OK',
  cwd: 'C:/work',
  access: 'edit',
  timeoutMs: 30 * 60_000,
  signal: new AbortController().signal,
  ...over,
})

/** 执行器上下文：运行时行 + 假 sdk（spawn/killTree 默认取 harness） */
const ctxOf = (
  h: Harness,
  runtimeOver: Partial<Runtime> = {},
  sdkOverrides: FakeSdkOverrides = {},
): ExecutorContext => ({
  runtime: runtime(runtimeOver),
  sdk: fakeSdk({ spawn: h.spawn, killTree: h.killTree, ...sdkOverrides }),
})

interface RunSpec {
  runtime?: Partial<Runtime>
  turn?: Partial<Turn>
  sdk?: FakeSdkOverrides
  options?: HermesOptions
  io?: Partial<ExecutorIO>
}

/** 起一轮执行：返回 promise 与事件收集数组 */
function startRun(
  h: Harness,
  spec: RunSpec = {},
): { running: Promise<Receipt>; events: RunEvent[] } {
  const events: RunEvent[] = []
  const io: ExecutorIO = { emit: (event) => events.push(event), ...spec.io }
  return {
    running: executeHermesRun(
      ctxOf(h, spec.runtime, spec.sdk),
      turnOf(spec.turn),
      io,
      spec.options,
    ),
    events,
  }
}

/** 起一轮并等到收尾：返回回执、已发帧与事件 */
async function runWith(
  overrides: Overrides,
  spec: RunSpec = {},
  configure?: (child: FakeChild) => void,
): Promise<{ receipt: Receipt; frames: Array<Record<string, unknown>>; events: RunEvent[] }> {
  const h = acpHarness(overrides, configure)
  const { running, events } = startRun(h, spec)
  const receipt = await running
  return { receipt, frames: h.children[0].frames(), events }
}

/** 等某个方法帧出现（握手是异步往返） */
async function waitForMethod(child: FakeChild, method: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (child.methods().includes(method)) return
    await delay(1)
  }
  throw new Error(`没有等到帧：${method}`)
}

describe('detectHermes', () => {
  it('命中：返回 hermes 候选（executorKey/supported 由注册表回填）', () => {
    const sdk = fakeSdk({
      scanDirs: () => ['C:/bin'],
      findInDirs: (command) => (command === 'hermes' ? 'C:/bin/hermes.cmd' : null),
    })
    expect(detectHermes({ sdk })).toEqual([
      {
        command: 'hermes',
        label: 'Hermes Agent',
        path: 'C:/bin/hermes.cmd',
        executorKey: '',
        supported: false,
      },
    ])
  })

  it('未命中：返回空数组', () => {
    const sdk = fakeSdk({ scanDirs: () => ['C:/bin'] })
    expect(detectHermes({ sdk })).toEqual([])
  })
})

describe('模型 id 还原', () => {
  it('把第一个冒号换回斜杠，其余原样保留', () => {
    expect(toRuntimeModelId('opencode-go:kimi-k3')).toBe('opencode-go/kimi-k3')
    expect(toRuntimeModelId('custom:magpie:minimax-code/x')).toBe('custom/magpie:minimax-code/x')
    // 没有冒号 / 冒号在首尾：原样返回（不造假的 provider 段）
    expect(toRuntimeModelId('plain')).toBe('plain')
    expect(toRuntimeModelId(':weird')).toBe(':weird')
    expect(toRuntimeModelId('weird:')).toBe('weird:')
  })

  it('provider 取第一个冒号之前那段；没有前缀为空串', () => {
    expect(providerOfModel('opencode-go:kimi-k3')).toBe('opencode-go')
    expect(providerOfModel('custom:magpie:x/y')).toBe('custom')
    expect(providerOfModel('plain')).toBe('')
    expect(providerOfModel(':weird')).toBe('')
  })
})

describe('probeHermesRuntime', () => {
  it('就绪：版本 + ACP 握手（protocolVersion=1），探测后杀掉子进程', async () => {
    let tick = 0
    const h = acpHarness()
    const probe = await probeHermesRuntime(ctxOf(h, {}, { now: () => (tick += 5) }))

    expect(probe.state).toBe('ready')
    expect(probe.path).toBe(NODE)
    expect(probe.cliVersion).toBe('0.22.5')
    expect(probe.protocolVersion).toBe(1)
    expect(probe.pluginVersion).toBe('1.0.0')
    expect(probe.error).toBeNull()
    expect(probe.elapsedMs).toBeGreaterThan(0)
    expect(probe.checkedAt).toBe(new Date(10).toISOString())
    // 第一次 --version，第二次 acp
    expect(h.calls.map((call) => call.args)).toEqual([['--version'], ['acp']])
    expect(h.killedTrees.length).toBeGreaterThan(0)
    expect(h.children[1].methods()).toEqual(['initialize'])
  })

  it('--version 读不到 semver：cliVersion 用 agentInfo.version 兜底', async () => {
    const h = harness(
      (args, child) => {
        if (!args.includes('--version')) return
        child.emitStdout('Hermes Agent (dev build)\n')
        child.close(0)
      },
      (child) => {
        child.handler = responderFor(child)
      },
    )
    const probe = await probeHermesRuntime(ctxOf(h))
    expect(probe.state).toBe('ready')
    expect(probe.cliVersion).toBe('0.22.5')
  })

  it('协议版本不兼容：unavailable 且文案带实际版本', async () => {
    const h = acpHarness({
      initialize: (_frame, child, id) =>
        replyResult(child, id, initializeResult({ protocolVersion: 2 })),
    })
    const probe = await probeHermesRuntime(ctxOf(h))
    expect(probe.state).toBe('unavailable')
    expect(probe.protocolVersion).toBe(2)
    expect(probe.error).toContain('协议版本')
    expect(probe.error).toContain('2')
  })

  it('找不到可执行文件：unavailable，path 为 null，不 spawn', async () => {
    const h = acpHarness()
    const probe = await probeHermesRuntime(ctxOf(h, { command: 'definitely-not-a-cmd-xyz' }))
    expect(probe.state).toBe('unavailable')
    expect(probe.path).toBeNull()
    expect(probe.error).toContain('PATH')
    expect(h.children).toHaveLength(0)
  })

  it('spawn 抛错：unavailable 提示启动探测失败', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn EPERM')
    }
    const h = acpHarness()
    const probe = await probeHermesRuntime(ctxOf(h, {}, { spawn }))
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('启动探测失败')
    expect(probe.error).toContain('EPERM')
  })

  it('握手超时：unavailable 并杀进程树', async () => {
    // 只回 --version，acp 那次一个帧都不回
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('Hermes Agent v0.22.5 (2026.9.24)\n')
        child.close(0)
      }
    })
    const probe = await probeHermesRuntime(ctxOf(h), { timeouts: { probe: 5 } })
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('超时')
    expect(h.killedTrees.length).toBeGreaterThan(0)
  })

  it('initialize 没给 protocolVersion：unavailable 报缺失', async () => {
    const h = acpHarness({
      initialize: (_frame, child, id) => replyResult(child, id, {}),
    })
    const probe = await probeHermesRuntime(ctxOf(h))
    expect(probe.state).toBe('unavailable')
    expect(probe.protocolVersion).toBeNull()
    expect(probe.error).toContain('缺失')
  })

  it('探测进程不理会 SIGTERM：宽限后 SIGKILL 收尾', async () => {
    const h = acpHarness({}, (child) => {
      child.closeOnKill = false
    })
    const probe = await probeHermesRuntime(ctxOf(h), { grace: { kill: 5 } })
    expect(probe.state).toBe('ready')
    expect(h.killedTrees).toEqual([
      { pid: 4243, signal: 'SIGTERM' },
      { pid: 4243, signal: 'SIGKILL' },
    ])
  })

  it('spawn 返回空进程：unavailable 提示「启动失败」', async () => {
    const h = acpHarness()
    // 第一次是 --version（正常），第二次是 acp：宿主没给进程对象
    let calls = 0
    const spawn: SpawnFn = (command, args, options) => {
      calls += 1
      if (calls === 2) return undefined as unknown as Spawned
      return h.spawn(command, args, options)
    }
    const probe = await probeHermesRuntime(ctxOf(h, {}, { spawn }))
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('启动失败')
  })

  it('resolve 返回 null 且无错误文案：用「找不到可执行文件」兜底', async () => {
    const h = acpHarness()
    const probe = await probeHermesRuntime(
      ctxOf(h, {}, { resolve: () => ({ path: null, error: null }) }),
    )
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain(`找不到可执行文件：${NODE}`)
  })
})

describe('listHermesModels', () => {
  it('解析 availableModels：还原 provider/model、默认标记、无 thinking level', async () => {
    const h = acpHarness()
    const models = await listHermesModels(ctxOf(h))

    expect(models).toEqual([
      {
        id: 'opencode-go/kimi-k3',
        label: 'Kimi K3',
        provider: 'opencode-go',
        default: false,
        thinkingLevels: [],
        defaultThinkingLevel: null,
      },
      {
        id: 'custom/magpie:minimax-code/x',
        label: 'MiniMax',
        provider: 'custom',
        default: true,
        thinkingLevels: [],
        defaultThinkingLevel: null,
      },
    ])
    // 临时会话：initialize → session/new，读完立刻杀进程
    expect(h.children[0].methods()).toEqual(['initialize', 'session/new'])
    expect(h.killedTrees.length).toBeGreaterThan(0)
  })

  it('模型目录为空：抛可读错误', async () => {
    const h = acpHarness({
      'session/new': (_frame, child, id) =>
        replyResult(child, id, { sessionId: 'sess-2', models: { availableModels: [] } }),
    })
    await expect(listHermesModels(ctxOf(h))).rejects.toThrow(/模型目录为空/)
  })

  it('协议版本不兼容：抛错', async () => {
    const h = acpHarness({
      initialize: (_frame, child, id) => replyResult(child, id, { protocolVersion: 2 }),
    })
    await expect(listHermesModels(ctxOf(h))).rejects.toThrow(/协议版本/)
  })

  it('RPC 错误：错误文案带 code', async () => {
    const h = acpHarness({
      'session/new': (_frame, child, id) => replyError(child, id, -32000, 'cwd 不可用'),
    })
    await expect(listHermesModels(ctxOf(h))).rejects.toThrow(/-32000: cwd 不可用/)
  })

  it('读目录超时：抛错', async () => {
    const h = harness()
    await expect(listHermesModels(ctxOf(h), { timeouts: { models: 5 } })).rejects.toThrow(
      `等待 initialize 回帧超时（5ms）`,
    )
  })

  it('命令不存在 / spawn 抛错：都抛可读错误', async () => {
    const h = acpHarness()
    await expect(listHermesModels(ctxOf(h, { command: 'missing-cmd-xyz' }))).rejects.toThrow(/PATH/)

    const spawn: SpawnFn = () => {
      throw new Error('nope')
    }
    await expect(listHermesModels(ctxOf(h, {}, { spawn }))).rejects.toThrow(/nope/)
  })

  it('startProcess 失败且没有错误文案：用「找不到可执行文件」兜底', async () => {
    const h = acpHarness()
    await expect(
      listHermesModels(ctxOf(h, {}, { resolve: () => ({ path: null, error: null }) })),
    ).rejects.toThrow(`找不到可执行文件：${NODE}`)
  })

  it('initialize 没给 protocolVersion：报缺失', async () => {
    const h = acpHarness({ initialize: (_frame, child, id) => replyResult(child, id, {}) })
    await expect(listHermesModels(ctxOf(h))).rejects.toThrow(/协议版本：缺失/)
  })

  it('session/new 没有 models：报模型目录为空', async () => {
    const h = acpHarness({
      'session/new': (_frame, child, id) => replyResult(child, id, { sessionId: 's-2' }),
    })
    await expect(listHermesModels(ctxOf(h))).rejects.toThrow(/模型目录为空/)
  })

  it('spawn 返回空进程：抛「找不到可执行文件」（startProcess 没给错误文案时）', async () => {
    const h = acpHarness()
    const spawn: SpawnFn = () => undefined as unknown as Spawned
    await expect(listHermesModels(ctxOf(h, {}, { spawn }))).rejects.toThrow(
      `找不到可执行文件：${NODE}`,
    )
  })

  it('服务端没给 currentModelId：所有模型都不是默认', async () => {
    const h = acpHarness({
      'session/new': (_frame, child, id) =>
        replyResult(child, id, {
          sessionId: 's-4',
          models: { availableModels: [{ modelId: 'p:m', name: 'M' }] },
        }),
    })
    const models = await listHermesModels(ctxOf(h))
    expect(models[0].default).toBe(false)
  })

  it('没有 name 的模型用 modelId 当 label；cwd 缺失时 session/new 不带 cwd', async () => {
    const h = acpHarness({
      'session/new': (_frame, child, id) =>
        replyResult(child, id, {
          sessionId: 's-3',
          models: { availableModels: [{ modelId: 'plain' }], currentModelId: 'other:model' },
        }),
    })
    // 宿主未注入默认目录：paths.cwd 为 undefined（fakeSdk 的缺省会被 ?? 兜住，这里手工构造）
    const base = fakeSdk({ spawn: h.spawn, killTree: h.killTree })
    const ctx: ExecutorContext = {
      runtime: runtime(),
      sdk: { ...base, paths: { sessionRoot: null, cwd: undefined as unknown as string } },
    }

    const models = await listHermesModels(ctx)

    expect(models).toEqual([
      {
        id: 'plain',
        label: 'plain',
        provider: '',
        default: false,
        thinkingLevels: [],
        defaultThinkingLevel: null,
      },
    ])
    expect(h.children[0].frames()[1].params).toEqual({ mcpServers: [] })
  })
})

describe('executeHermesRun：成功路径', () => {
  it('initialize → session/new → set_mode → set_model → prompt，事件与回执齐全', async () => {
    const h = acpHarness({
      'session/prompt': (_frame, child, id) => {
        // 非本会话的更新：忽略
        update(child, 'sess-other', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '别的会话' },
        })
        update(child, 'sess-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '你' },
        })
        update(child, 'sess-1', {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: '想一想' },
        })
        update(child, 'sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'read file',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'a.ts' },
        })
        // 中间态不发卡片
        update(child, 'sess-1', {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'in_progress',
        })
        update(child, 'sess-1', {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          title: 'read file',
          rawOutput: 'content',
        })
        // 同一调用重复的终态：去重，只发一张卡
        update(child, 'sess-1', {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          title: 'read file',
          rawOutput: 'content',
        })
        // 不翻译的更新类型
        update(child, 'sess-1', { sessionUpdate: 'plan', entries: [] })
        update(child, 'sess-1', { sessionUpdate: 'current_mode_update', currentModeId: 'dont_ask' })
        update(child, 'sess-1', {
          sessionUpdate: 'available_commands_update',
          availableCommands: [],
        })
        update(child, 'sess-1', { sessionUpdate: 'config_option_update', configOptions: [] })
        update(child, 'sess-1', {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: '只回复 OK' },
        })
        update(child, 'sess-1', { sessionUpdate: 'future_update', payload: 1 })
        // usage_update 只有上下文窗口读数：used 当 input 下界
        update(child, 'sess-1', { sessionUpdate: 'usage_update', size: 200_000, used: 120 })
        update(child, 'sess-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '好' },
        })
        replyResult(child, id, {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 10,
            outputTokens: 7,
            cachedReadTokens: 3,
            cachedWriteTokens: 1,
            thoughtTokens: 2,
            totalTokens: 20,
          },
        })
      },
    })

    const sessionCalls: string[] = []
    const processCalls: number[] = []
    const { running, events } = startRun(h, {
      // 执行配置来自智能体（宿主折进 Turn）：set_model 由 turn.model 拼 provider:id
      turn: {
        model: { provider: 'opencode-go', id: 'kimi-k3' },
        env: { HTTP_PROXY: 'http://127.0.0.1:7890' },
      },
      io: { session: (id) => sessionCalls.push(id), process: (pid) => processCalls.push(pid) },
    })
    const receipt = await running
    const child = h.children[0]

    // 帧顺序与参数
    expect(h.calls[0].args).toEqual(['acp'])
    expect(h.calls[0].command).toBe(NODE)
    // 智能体配的环境变量原样进 spawn（宿主基线由 sdk 合并）
    expect(h.calls[0].options.env).toEqual({ HTTP_PROXY: 'http://127.0.0.1:7890' })
    expect(child.frames()).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'workbench', version: '1.0.0' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { mcpServers: [], cwd: 'C:/work' },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/set_mode',
        params: { sessionId: 'sess-1', modeId: 'accept_edits' },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'session/set_model',
        params: { sessionId: 'sess-1', modelId: 'opencode-go:kimi-k3' },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: '只回复 OK' }] },
      },
    ])

    // 事件序列
    expect(events.map((event) => event.type)).toEqual([
      'text',
      'thinking',
      'tool_call',
      'tool_result',
      'text',
    ])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(events[0]).toMatchObject({ type: 'text', text: '你' })
    expect(events[1]).toMatchObject({ type: 'thinking', text: '想一想' })
    expect(events[2]).toMatchObject({
      type: 'tool_call',
      tool: 'read file',
      callId: 'c1',
      input: '{"path":"a.ts"}',
    })
    expect(events[3]).toMatchObject({
      type: 'tool_result',
      tool: 'read file',
      callId: 'c1',
      output: 'content',
      isError: false,
    })
    expect(events[4]).toMatchObject({ type: 'text', text: '好' })

    // 回执
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe('你好')
    expect(receipt.error).toBeUndefined()
    expect(receipt.errorCode).toBeUndefined()
    expect(receipt.exitCode).toBe(0)
    expect(receipt.sessionId).toBe('sess-1')
    expect(receipt.resumeRejected).toBeUndefined()
    expect(receipt.usage).toEqual({
      inputTokens: 120,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    })
    expect(receipt.leaseId).toBe('lease-1')
    expect(receipt.turn).toBe(1)
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0)
    // 旁路：pid 立即上报、会话 id 建好就上报
    expect(processCalls).toEqual([4242])
    expect(sessionCalls).toEqual(['sess-1'])
  })

  it('tool_call 缺 title 时用 kind 兜底、rawInput 缺省为空串', async () => {
    const { events } = await runWith({
      'session/prompt': (_frame, child, id) => {
        update(child, 'sess-1', { sessionUpdate: 'tool_call', toolCallId: 'c2', kind: 'execute' })
        update(child, 'sess-1', {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c2',
          kind: 'execute',
          status: 'failed',
        })
        // 没有 toolCallId 的终态：按工具名兜底去重，重复也只发一次
        update(child, 'sess-1', {
          sessionUpdate: 'tool_call_update',
          title: 'shell',
          status: 'completed',
        })
        update(child, 'sess-1', {
          sessionUpdate: 'tool_call_update',
          title: 'shell',
          status: 'completed',
        })
        replyResult(child, id, { stopReason: 'end_turn' })
      },
    })
    expect(events[0]).toMatchObject({ type: 'tool_call', tool: 'execute', callId: 'c2', input: '' })
    expect(events[1]).toMatchObject({
      type: 'tool_result',
      tool: 'execute',
      isError: true,
      output: '',
    })
    expect(events[2]).toMatchObject({
      type: 'tool_result',
      tool: 'shell',
      callId: '',
      isError: false,
    })
    expect(events).toHaveLength(3)
  })

  it('成功收尾时对端不退：SIGTERM 后宽限 SIGKILL，回执仍成功', async () => {
    const h = acpHarness({}, (child) => {
      child.closeOnKill = false
    })
    const { running } = startRun(h, { options: { grace: { cancel: 2, kill: 5 } } })
    const receipt = await running

    expect(receipt.status).toBe('succeeded')
    expect(h.killedTrees).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ])
    // 强杀后不再等 close：退出码留空
    expect(receipt.exitCode).toBeUndefined()
  })
})

describe('executeHermesRun：stopReason 归一', () => {
  const runStopReason = async (stopReason: string): Promise<Receipt> => {
    const { receipt } = await runWith({
      'session/prompt': (_frame, child, id) => replyResult(child, id, { stopReason }),
    })
    return receipt
  }

  it('end_turn → succeeded，无错误文案', async () => {
    const receipt = await runStopReason('end_turn')
    expect(receipt.status).toBe('succeeded')
    expect(receipt.error).toBeUndefined()
    expect(receipt.errorCode).toBeUndefined()
  })

  it('max_tokens → succeeded（截断），error 记一句说明', async () => {
    const receipt = await runStopReason('max_tokens')
    expect(receipt.status).toBe('succeeded')
    expect(receipt.errorCode).toBeUndefined()
    expect(receipt.error).toContain('截断')
  })

  it('max_turn_requests → succeeded（截断），error 记一句说明', async () => {
    const receipt = await runStopReason('max_turn_requests')
    expect(receipt.status).toBe('succeeded')
    expect(receipt.error).toContain('单轮请求上限')
  })

  it('refusal → failed + run_failed', async () => {
    const receipt = await runStopReason('refusal')
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toContain('refusal')
  })

  it('cancelled → cancelled', async () => {
    const receipt = await runStopReason('cancelled')
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(receipt.error).toBe('已取消')
  })

  it('未知 stopReason → failed', async () => {
    const receipt = await runStopReason('weird')
    expect(receipt.status).toBe('failed')
    expect(receipt.error).toContain('weird')
  })

  it('结果里没有 stopReason：按失败收口，文案显示「空」', async () => {
    const { receipt } = await runWith({
      'session/prompt': (_frame, child, id) => replyResult(child, id, {}),
    })
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toContain('stopReason=空')
  })
})

describe('executeHermesRun：审批往返（session/request_permission）', () => {
  interface PermissionRun {
    receipt: Receipt
    responses: Array<Record<string, unknown>>
    events: RunEvent[]
    logs: string[]
    methods: string[]
  }

  /** 让 prompt 期间冒出一次服务端请求，收到我方回帧后再收尾 */
  const runServerRequest = async (
    method: string,
    params: Record<string, unknown>,
    turnOver: Partial<Turn> = {},
  ): Promise<PermissionRun> => {
    const responses: Array<Record<string, unknown>> = []
    const logs: string[] = []
    let promptId: number | string = 0
    let pending = false
    const h = acpHarness(
      {
        'session/prompt': (_frame, child, id) => {
          promptId = id
          pending = true
          child.emitStdout(line({ jsonrpc: '2.0', id: 'srv-1', method, params }))
        },
      },
      (child) => {
        child.onResponse = (response) => {
          responses.push(response)
          if (!pending) return
          pending = false
          replyResult(child, promptId, { stopReason: 'end_turn' })
        }
      },
    )
    const { running, events } = startRun(h, {
      turn: turnOver,
      sdk: { log: (message) => logs.push(message) },
    })
    const receipt = await running
    return { receipt, responses, events, logs, methods: h.children[0].methods() }
  }

  const permissionParams = (options: Array<Record<string, unknown>>): Record<string, unknown> => ({
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'perm-1', title: 'Run shell command', kind: 'execute' },
    options,
  })

  it('有 allow 选项：回 selected，并发一条 tool_call 事件', async () => {
    const run = await runServerRequest(
      'session/request_permission',
      permissionParams([
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ]),
    )

    expect(run.responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 'srv-1',
        result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      },
    ])
    expect(run.events).toEqual([
      {
        seq: 1,
        type: 'tool_call',
        tool: 'Run shell command',
        callId: 'perm-1',
        input: JSON.stringify({ options: ['Allow once', 'Always allow', 'Reject'] }),
      },
    ])
    expect(run.logs.some((message) => message.includes('允许'))).toBe(true)
    expect(run.receipt.status).toBe('succeeded')
  })

  it('只有 reject 选项：按 DeniedOutcome 形状回拒绝帧', async () => {
    const run = await runServerRequest(
      'session/request_permission',
      permissionParams([{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }]),
    )

    // acp/schema.py：DeniedOutcome{outcome: Literal["cancelled"]}
    expect(run.responses).toEqual([
      { jsonrpc: '2.0', id: 'srv-1', result: { outcome: { outcome: 'cancelled' } } },
    ])
    expect(run.logs.some((message) => message.includes('拒绝'))).toBe(true)
    expect(run.receipt.status).toBe('succeeded')
  })

  it('只读运行（Turn.access=read）下出现审批请求：仍然回拒绝', async () => {
    const run = await runServerRequest(
      'session/request_permission',
      permissionParams([{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]),
      { access: 'read' },
    )
    expect(run.responses).toEqual([
      { jsonrpc: '2.0', id: 'srv-1', result: { outcome: { outcome: 'cancelled' } } },
    ])
  })

  it('未知的服务端请求：回 -32601 错误帧，不挂死', async () => {
    const run = await runServerRequest('fs/read_text_file', { sessionId: 'sess-1', path: '/etc/x' })
    expect(run.responses).toEqual([
      { jsonrpc: '2.0', id: 'srv-1', error: { code: -32601, message: 'method not found' } },
    ])
    expect(run.receipt.status).toBe('succeeded')
  })

  it('脏 params：非对象选项与缺 optionId 的选项都跳过（回拒绝，工具名为空）', async () => {
    const run = await runServerRequest('session/request_permission', {
      sessionId: 'sess-1',
      options: [null, 7, { kind: 'allow_once' }, { optionId: 'r1', kind: 'reject_once' }],
    })

    expect(run.responses).toEqual([
      { jsonrpc: '2.0', id: 'srv-1', result: { outcome: { outcome: 'cancelled' } } },
    ])
    expect(run.events[0]).toMatchObject({
      type: 'tool_call',
      tool: '',
      callId: '',
      input: JSON.stringify({ options: [] }),
    })
  })
})

describe('executeHermesRun：会话建立与配置', () => {
  it('给了 resumeSessionId：走 session/load，不再 session/new', async () => {
    const { receipt, frames } = await runWith({}, { turn: { resumeSessionId: 'sess-prev' } })

    expect(frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/load',
      'session/set_mode',
      'session/prompt',
    ])
    expect(frames[1].params).toEqual({
      mcpServers: [],
      cwd: 'C:/work',
      sessionId: 'sess-prev',
    })
    // 续接以服务端回的 sessionId 为准
    expect(receipt.sessionId).toBe('sess-loaded')
    expect(receipt.resumeRejected).toBeUndefined()
  })

  it('session/load 失败：resumeRejected=true、run_failed，且不发 prompt', async () => {
    const { receipt, frames } = await runWith(
      {
        'session/load': (_frame, child, id) => replyError(child, id, -32000, 'session not found'),
      },
      { turn: { resumeSessionId: 'dead-session' } },
    )

    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.resumeRejected).toBe(true)
    expect(receipt.error).toContain('续接会话被拒')
    expect(receipt.error).toContain('-32000')
    expect(frames.map((frame) => frame.method)).toEqual(['initialize', 'session/load'])
  })

  it('session/new 没有 sessionId：protocol_error', async () => {
    const { receipt } = await runWith({
      'session/new': (_frame, child, id) => replyResult(child, id, { models: DEFAULT_MODELS }),
    })
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('sessionId')
  })

  it('initialize 的 protocolVersion=2：protocol_error，文案带实际版本', async () => {
    const { receipt, frames } = await runWith({
      initialize: (_frame, child, id) =>
        replyResult(child, id, initializeResult({ protocolVersion: 2 })),
    })
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('协议版本')
    expect(receipt.error).toContain('2')
    expect(frames.map((frame) => frame.method)).toEqual(['initialize'])
  })

  it('initialize 回 RPC error：protocol_error 且文案带 code', async () => {
    const { receipt } = await runWith({
      initialize: (_frame, child, id) => replyError(child, id, -32603, 'initialize 失败'),
    })
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('-32603: initialize 失败')
  })

  it('服务端没声明目标 mode：跳过 set_mode 并记日志（不算失败）', async () => {
    const logs: string[] = []
    const h = acpHarness({
      'session/new': (_frame, child, id) =>
        replyResult(child, id, {
          sessionId: 'sess-1',
          models: DEFAULT_MODELS,
          modes: { availableModes: [{ id: 'plan' }], currentModeId: 'plan' },
        }),
    })
    const { running } = startRun(h, { sdk: { log: (message) => logs.push(message) } })
    const receipt = await running

    expect(receipt.status).toBe('succeeded')
    expect(h.children[0].methods()).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(logs.some((message) => message.includes('未声明模式'))).toBe(true)
  })

  it('服务端没声明 modes：跳过 set_mode 并记日志', async () => {
    const logs: string[] = []
    const h = acpHarness({
      'session/new': (_frame, child, id) =>
        replyResult(child, id, { sessionId: 'sess-1', models: DEFAULT_MODELS }),
    })
    const { running } = startRun(h, { sdk: { log: (message) => logs.push(message) } })
    await running
    expect(h.children[0].methods()).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(logs.some((message) => message.includes('未声明 modes'))).toBe(true)
  })

  it('没声明目标 mode 且没有 currentModeId：日志里当前模式显示「未知」', async () => {
    const logs: string[] = []
    const h = acpHarness({
      'session/new': (_frame, child, id) =>
        replyResult(child, id, {
          sessionId: 'sess-1',
          models: DEFAULT_MODELS,
          modes: { availableModes: [{ id: 'plan' }] },
        }),
    })
    const { running } = startRun(h, { sdk: { log: (message) => logs.push(message) } })
    await running
    expect(logs.some((message) => message.includes('未知'))).toBe(true)
    expect(h.children[0].methods()).toEqual(['initialize', 'session/new', 'session/prompt'])
  })

  it('当前模式已是目标模式：跳过 set_mode', async () => {
    const { frames } = await runWith({
      'session/new': (_frame, child, id) =>
        replyResult(child, id, {
          sessionId: 'sess-1',
          models: DEFAULT_MODELS,
          modes: { availableModes: [{ id: 'accept_edits' }], currentModeId: 'accept_edits' },
        }),
    })
    expect(frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ])
  })

  it('当前模型已是目标模型：跳过 set_model', async () => {
    const { frames } = await runWith(
      {
        'session/new': (_frame, child, id) =>
          replyResult(child, id, {
            sessionId: 'sess-1',
            models: {
              availableModels: DEFAULT_MODELS.availableModels,
              currentModelId: 'opencode-go:kimi-k3',
            },
            modes: DEFAULT_MODES,
          }),
      },
      { turn: { model: { provider: 'opencode-go', id: 'kimi-k3' } } },
    )
    expect(frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_mode',
      'session/prompt',
    ])
  })

  it('没配模型 / 思考强度：不拼任何额外帧与参数', async () => {
    const { frames } = await runWith({}, { turn: { model: null, effort: 'high' } })
    expect(frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_mode',
      'session/prompt',
    ])
  })

  it('完全访问（Turn.access=full）映射到 dont_ask', async () => {
    const { frames } = await runWith({}, { turn: { access: 'full' } })
    expect(frames[2]).toMatchObject({
      method: 'session/set_mode',
      params: { sessionId: 'sess-1', modeId: 'dont_ask' },
    })
  })
})

describe('executeHermesRun：失败与终态兜底', () => {
  it('spawn 抛错：spawn_failed', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('EPERM')
    }
    const h = acpHarness()
    const { running } = startRun(h, { sdk: { spawn } })
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('EPERM')
  })

  it('命令解析不到：spawn_failed，不 spawn、不发事件', async () => {
    const h = acpHarness()
    const { running, events } = startRun(h, { runtime: { command: 'missing-cmd-xyz' } })
    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(h.children).toHaveLength(0)
    expect(events).toEqual([])
  })

  it('子进程 error 事件：spawn_failed', async () => {
    const h = acpHarness({
      'session/prompt': (_frame, child) => child.fail(new Error('EACCES')),
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('EACCES')
  })

  it('非零退出且没拿到 stopReason：exit_nonzero（带 stderr 尾部）', async () => {
    const h = acpHarness({
      'session/prompt': (_frame, child) => {
        child.emitStderr('fatal: bad config\n')
        child.close(7)
      },
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('exit_nonzero')
    expect(receipt.error).toContain('退出码 7')
    expect(receipt.error).toContain('bad config')
  })

  it('正常退出且没拿到 stopReason：no_result', async () => {
    const h = acpHarness({
      'session/prompt': (_frame, child) => child.close(0),
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(receipt.errorCode).toBe('no_result')
    expect(receipt.error).toContain('终态结果')
  })

  it('prompt 回 RPC error：failed + run_failed（文案带 code）', async () => {
    const h = acpHarness({
      'session/prompt': (_frame, child, id) => replyError(child, id, -32603, '内容过长'),
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toContain('-32603: 内容过长')
  })

  it('宿主给 null 模型：不拼 session/set_model，按 CLI 默认模型跑', async () => {
    const h = acpHarness()
    const { running } = startRun(h, { turn: { model: null } })
    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(h.children[0].methods()).not.toContain('session/set_model')
  })

  it('signal 已取消：直接返回 cancelled，不启动进程', async () => {
    const h = acpHarness()
    const controller = new AbortController()
    controller.abort()
    const { running } = startRun(h, { turn: { signal: controller.signal } })
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(h.children).toHaveLength(0)
  })

  it('stderr 超长：诊断只保留尾部', async () => {
    const h = acpHarness({
      'session/prompt': (_frame, child) => {
        child.emitStderr('x'.repeat(OUTPUT_TAIL_LIMIT + 10))
        child.close(1)
      },
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(String(receipt.error)).toContain('…')
    expect(String(receipt.error).endsWith('x'.repeat(10))).toBe(true)
  })

  it('写帧失败（stdin 已关）：protocol_error', async () => {
    const h = acpHarness({}, (child) => {
      child.writeThrows = true
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('无法写入 initialize 帧')
  })
})

describe('executeHermesRun：取消与超时', () => {
  it('abort：先发 session/cancel 通知，宽限后 SIGTERM，再宽限 SIGKILL', async () => {
    const h = acpHarness(
      // prompt 不回帧：模拟长任务
      { 'session/prompt': () => undefined },
      (child) => {
        child.closeOnKill = false
      },
    )
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 20, kill: 60 } },
    })
    const child = h.children[0]
    await waitForMethod(child, 'session/prompt')

    controller.abort()
    expect(child.frames().at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'sess-1' },
    })

    await delay(35)
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: 'SIGTERM' }])

    await delay(60)
    expect(h.killedTrees).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ])

    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(receipt.error).toBe('已取消')
    expect(receipt.sessionId).toBe('sess-1')
  })

  it('取消期间到达的 update 仍入事件流，但终态保持 cancelled', async () => {
    const h = acpHarness(
      {
        'session/prompt': (_frame, child) => {
          update(child, 'sess-1', {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '已经开跑' },
          })
          // 之后不再回帧
        },
      },
      (child) => {
        child.closeOnKill = false
      },
    )
    const controller = new AbortController()
    const { running, events } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 2, kill: 2 } },
    })
    await waitForMethod(h.children[0], 'session/prompt')
    controller.abort()
    const receipt = await running

    expect(events.map((event) => event.type)).toEqual(['text'])
    expect(receipt.status).toBe('cancelled')
    expect(receipt.output).toBe('已经开跑')
  })

  it('超时：errorCode=timeout', async () => {
    const h = acpHarness({ 'session/prompt': () => undefined })
    const { running } = startRun(h, {
      turn: { timeoutMs: 5 },
      options: { grace: { cancel: 2, kill: 2 } },
    })
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain('5ms')
    expect(h.killedTrees.length).toBeGreaterThan(0)
  })

  it('turn.timeoutMs 非正数：回退到注入的 run 超时', async () => {
    const h = acpHarness({ 'session/prompt': () => undefined })
    const { running } = startRun(h, {
      turn: { timeoutMs: 0 },
      options: { timeouts: { run: 5 }, grace: { cancel: 2, kill: 2 } },
    })
    const receipt = await running
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain('5ms')
  })

  it('不带 pid 的子进程：用 child.kill 兜底（SIGTERM → SIGKILL）', async () => {
    const h = acpHarness({ 'session/prompt': () => undefined }, (child) => {
      child.pid = undefined
      child.closeOnKill = false
    })
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 2, kill: 2 } },
    })
    const child = h.children[0]
    await waitForMethod(child, 'session/prompt')
    controller.abort()
    const receipt = await running

    expect(receipt.status).toBe('cancelled')
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL'])
    expect(h.killedTrees).toEqual([])
  })
})

describe('hermesPlugin 装配', () => {
  it('manifest 字段与四个能力都接上（注册表加一行即可用）', async () => {
    expect(hermesManifest.id).toBe('hermes')
    expect(hermesManifest.name).toBe('Hermes Agent')
    expect(hermesManifest.kind).toBe('executor')
    expect(hermesManifest.capabilities).toEqual(['spawn'])
    expect(hermesManifest.config?.map((field) => field.key)).toEqual([
      'command',
      'profile',
      'permissionMode',
      'model',
      'reasoningEffort',
      'workdir',
    ])

    expect(hermesPlugin.run).toBeTypeOf('function')
    expect(hermesPlugin.probe).toBeTypeOf('function')
    expect(hermesPlugin.models).toBeTypeOf('function')

    // detect 经插件对象走一遍（找不到命令 → 空数组）
    const sdk = fakeSdk({ scanDirs: () => ['C:/bin'], findInDirs: () => null })
    expect(await Promise.resolve(hermesPlugin.detect?.({ sdk }))).toEqual([])

    // probe / models 经插件对象走一遍
    expect((await hermesPlugin.probe?.(ctxOf(acpHarness())))?.state).toBe('ready')
    expect(await hermesPlugin.models?.(ctxOf(acpHarness()))).toHaveLength(2)

    // run 经插件对象走一遍
    const h = acpHarness()
    const receipt = await hermesPlugin.run(ctxOf(h), turnOf(), { emit: () => undefined })
    expect(receipt.status).toBe('succeeded')
  })
})

describe('readCliVersion（一次性命令收集）', () => {
  it('命令解析不到：返回 null', async () => {
    const sdk = fakeSdk({ resolve: () => ({ path: null, error: null }) })
    expect(await readCliVersion(sdk, 'hermes', 5)).toBeNull()
  })

  it('版本子进程超时：杀进程树后返回 null', async () => {
    const h = harness()
    const sdk = fakeSdk({ spawn: h.spawn, killTree: h.killTree })
    expect(await readCliVersion(sdk, NODE, 5)).toBeNull()
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: undefined }])
  })

  it('版本子进程超时且没有 pid：child.kill 兜底', async () => {
    const h = harness(undefined, (child) => {
      child.pid = undefined
    })
    const sdk = fakeSdk({ spawn: h.spawn, killTree: h.killTree })
    expect(await readCliVersion(sdk, NODE, 5)).toBeNull()
    expect(h.children[0].killed).toEqual(['SIGKILL'])
  })

  it('spawn 抛错 / 子进程报错：都返回 null（探测不因版本失败中断）', async () => {
    const throwing: SpawnFn = () => {
      throw new Error('boom')
    }
    expect(await readCliVersion(fakeSdk({ spawn: throwing }), NODE, 5)).toBeNull()

    const h = harness((_args, child) => {
      child.emitStderr('warn: something\n')
      child.fail(new Error('EACCES'))
    })
    expect(await readCliVersion(fakeSdk({ spawn: h.spawn }), NODE, 5)).toBeNull()
  })

  it('正常输出：取第一段 semver（忽略括号里的日期）', async () => {
    const h = harness((_args, child) => {
      child.emitStdout('Hermes Agent v0.22.5 (2026.9.24) · stable · python3.13\n')
      child.emitStderr('warn: ignored\n')
      child.close(0)
    })
    expect(await readCliVersion(fakeSdk({ spawn: h.spawn }), NODE, 50)).toBe('0.22.5')
  })

  it('解析到 .cmd/.bat 时经 shell 启动；.exe 不经 shell', async () => {
    const h = harness((_args, child) => {
      child.emitStdout('Hermes Agent v0.22.5 (2026.9.24)\n')
      child.close(0)
    })
    const cmdSdk = fakeSdk({
      spawn: h.spawn,
      resolve: () => ({ path: 'C:/bin/hermes.cmd', error: null }),
    })
    expect(await readCliVersion(cmdSdk, 'hermes', 50)).toBe('0.22.5')
    expect(h.calls[0].command).toBe('C:/bin/hermes.cmd')
    expect(h.calls[0].options.shell).toBe(true)

    const exeSdk = fakeSdk({
      spawn: h.spawn,
      resolve: () => ({ path: 'C:/bin/hermes.exe', error: null }),
    })
    expect(await readCliVersion(exeSdk, 'hermes', 50)).toBe('0.22.5')
    expect(h.calls[1].options.shell).toBe(false)
  })
})

describe('readSessionState（脏数据归一）', () => {
  it('缺字段与非对象一律归 null / 空数组', () => {
    expect(readSessionState({})).toEqual({ sessionId: null, models: null, modes: null })
    expect(readSessionState({ sessionId: '  ', models: 'nope', modes: [1, 2] })).toEqual({
      sessionId: null,
      models: null,
      modes: null,
    })
  })

  it('目录项混入非对象 / 缺 id 时逐项跳过', () => {
    expect(
      readSessionState({
        sessionId: 's-1',
        models: {
          availableModels: [null, 7, { name: '没有 id' }, { modelId: 'p:m', name: '  ' }],
        },
        modes: { availableModes: [null, { name: '没有 id' }, { id: 'default' }] },
      }),
    ).toEqual({
      sessionId: 's-1',
      models: { available: [{ modelId: 'p:m', name: '' }], current: null },
      modes: { available: ['default'], current: null },
    })
  })

  it('availableModels / availableModes 不是数组：归空数组', () => {
    expect(
      readSessionState({
        models: { availableModels: 'x' },
        modes: { availableModes: 1 },
      }),
    ).toEqual({
      sessionId: null,
      models: { available: [], current: null },
      modes: { available: [], current: null },
    })
  })
})

describe('createAcpClient（JSON-RPC 最小客户端）', () => {
  interface ClientFixture {
    client: AcpClient
    writes: Array<Record<string, unknown>>
  }

  const clientWith = (handlers: Partial<AcpHandlers> = {}): ClientFixture => {
    const writes: Array<Record<string, unknown>> = []
    const client = createAcpClient({
      write: (frame) => {
        writes.push(frame)
        return true
      },
      ...handlers,
    })
    return { client, writes }
  }

  it('请求 → 应答：result 派发给等待方，非对象 result 归空对象', async () => {
    const { client, writes } = clientWith()
    const first = client.request('initialize', { a: 1 }, 1000)
    const second = client.request('session/new', {}, 1000)

    expect(writes).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
    ])

    client.feed({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    client.feed({ jsonrpc: '2.0', id: 2, result: 'not-an-object' })

    await expect(first).resolves.toEqual({ protocolVersion: 1 })
    await expect(second).resolves.toEqual({})
  })

  it('error 应答：有 code 时文案带 code，缺 code 时用兜底文案', async () => {
    const { client } = clientWith()
    const withCode = client.request('initialize', {}, 1000)
    client.feed({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } })
    await expect(withCode).rejects.toThrow('-32000: boom')

    const noCode = client.request('session/new', {}, 1000)
    client.feed({ jsonrpc: '2.0', id: 2, error: { message: '   ' } })
    await expect(noCode).rejects.toThrow('JSON-RPC 错误')
  })

  it('error 帧没有字符串 message：detail 用兜底文案，code 仍保留', async () => {
    const { client } = clientWith()
    const pending = client.request('initialize', {}, 1000)
    client.feed({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 7 } })
    await expect(pending).rejects.toThrow('-1: JSON-RPC 错误')
  })

  it('未知 id 的应答与没有 method 的帧都忽略（客户端不被打断）', async () => {
    const { client, writes } = clientWith()
    client.feed({ jsonrpc: '2.0', id: 99, result: {} })
    client.feed({ jsonrpc: '2.0' })

    const next = client.request('initialize', {}, 1000)
    client.feed({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    await expect(next).resolves.toEqual({ ok: true })
    expect(writes).toHaveLength(1)
  })

  it('dispose：在途请求 reject，之后的请求立即失败', async () => {
    const { client } = clientWith()
    const pending = client.request('session/prompt', {}, 1000)
    client.dispose('子进程已退出')

    await expect(pending).rejects.toThrow('子进程已退出')
    await expect(client.request('initialize', {}, 1000)).rejects.toThrow('子进程已退出')
  })

  it('通知走 onNotify；服务端请求必须回帧（认不出的回 -32601）', () => {
    const notified: Array<{ method: string; params: Record<string, unknown> }> = []
    const { client, writes } = clientWith({
      onNotify: (method, params) => notified.push({ method, params }),
      onRequest: (method) =>
        method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : null,
    })

    client.feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's' } })
    // params 不是对象：按空对象处理
    client.feed({ jsonrpc: '2.0', method: 'session/update', params: 'nope' })
    client.feed({ jsonrpc: '2.0', id: 'srv-1', method: 'session/request_permission', params: {} })
    client.feed({ jsonrpc: '2.0', id: 'srv-2', method: 'fs/read_text_file', params: {} })

    expect(notified).toEqual([
      { method: 'session/update', params: { sessionId: 's' } },
      { method: 'session/update', params: {} },
    ])
    expect(writes).toEqual([
      { jsonrpc: '2.0', id: 'srv-1', result: { outcome: { outcome: 'cancelled' } } },
      { jsonrpc: '2.0', id: 'srv-2', error: { code: -32601, message: 'method not found' } },
    ])
  })

  it('没挂 onRequest / onNotify：服务端请求仍回 -32601，通知忽略', () => {
    const { client, writes } = clientWith()
    client.feed({ jsonrpc: '2.0', method: 'session/update', params: {} })
    client.feed({ jsonrpc: '2.0', id: 7, method: 'unknown/method' })
    expect(writes).toEqual([
      { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'method not found' } },
    ])
  })

  it('feedLine：非 JSON 行与非对象行都不是帧', () => {
    const { client, writes } = clientWith()
    feedLine(client, 'not json')
    feedLine(client, '[1,2]')
    feedLine(client, '{"jsonrpc":"2.0"}')
    expect(writes).toEqual([])
  })
})

describe('工具通道（M24）：tool_call 里的回执', () => {
  const stateOf = (): HermesRunState => ({
    sessionId: 'sess-1',
    text: '',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolResults: new Set<string>(),
    receipt: null,
    result: null,
    resumeRejected: false,
  })

  const feed = (state: HermesRunState, update: Record<string, unknown>): void => {
    handleSessionUpdate({ sessionId: 'sess-1', update }, state, () => undefined)
  }

  it('回执工具（mcp__workbench__receipt）：rawInput 写进 state.receipt', () => {
    const state = stateOf()
    feed(state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'mcp__workbench__receipt',
      kind: 'other',
      status: 'pending',
      rawInput: { verdict: 'pass', checks: [{ cmd: 'pnpm check', exitCode: 0 }] },
    })
    expect(state.receipt).toEqual({ verdict: 'pass', checks: [{ cmd: 'pnpm check', exitCode: 0 }] })
  })

  it('别的工具 / 参数非法 / 参数里没有回执键：state.receipt 保持 null', () => {
    for (const [name, rawInput] of [
      ['read file', { path: 'a.ts' }],
      ['mcp__other__receipt', { notices: ['x'] }],
      ['mcp__workbench__receipt', { ask: 1 }],
      ['mcp__workbench__receipt', { foo: 1 }],
    ] as const) {
      const state = stateOf()
      feed(state, {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: name,
        kind: 'other',
        status: 'pending',
        rawInput,
      })
      expect(state.receipt).toBeNull()
    }
  })

  it('工具调用照常发 tool_call 事件（审计面不丢）', () => {
    const state = stateOf()
    const events: Array<Omit<RunEvent, 'seq'>> = []
    handleSessionUpdate(
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'mcp__workbench__receipt',
          kind: 'other',
          status: 'pending',
          rawInput: { notices: ['来自工具'] },
        },
      },
      state,
      (event) => events.push(event),
    )
    expect(events).toEqual([
      {
        type: 'tool_call',
        tool: 'mcp__workbench__receipt',
        callId: 'c1',
        input: '{"notices":["来自工具"]}',
      },
    ])
  })

  it('整轮执行：prompt 期间的工具调用写进回执（工具通道优先于文本）', async () => {
    const { receipt } = await runWith({
      'session/prompt': (_frame, child, id) => {
        update(child, 'sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'mcp__workbench__receipt',
          kind: 'other',
          status: 'pending',
          rawInput: { notices: ['来自工具'] },
        })
        // 正文里也写一份围栏块：工具通道应当赢
        update(child, 'sess-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '```json\n{"notices":["来自文本"]}\n```' },
        })
        replyResult(child, id, { stopReason: 'end_turn' })
      },
    })

    expect(receipt.notices).toEqual(['来自工具'])
    expect(receipt.status).toBe('succeeded')
  })
})

describe('handleSessionUpdate / decidePermission（脏数据）', () => {
  const stateOf = (): HermesRunState => ({
    sessionId: 'sess-1',
    text: '',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolResults: new Set<string>(),
    receipt: null,
    result: null,
    resumeRejected: false,
  })

  it('非对象 update、缺 sessionUpdate、非文本块、空文本都不产生事件', () => {
    const state = stateOf()
    const events: Array<Omit<RunEvent, 'seq'>> = []
    const emit = (event: Omit<RunEvent, 'seq'>): void => {
      events.push(event)
    }

    handleSessionUpdate({ sessionId: 'sess-1', update: 'nope' }, state, emit)
    handleSessionUpdate({ sessionId: 'sess-1' }, state, emit)
    handleSessionUpdate({ sessionId: 'sess-1', update: {} }, state, emit)
    handleSessionUpdate(
      { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk' } },
      state,
      emit,
    )
    handleSessionUpdate(
      {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } },
      },
      state,
      emit,
    )
    handleSessionUpdate(
      {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } },
      },
      state,
      emit,
    )
    handleSessionUpdate(
      { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call_update', status: 'pending' } },
      state,
      emit,
    )
    // 不是本轮的会话
    handleSessionUpdate(
      {
        sessionId: 'other',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      },
      state,
      emit,
    )

    expect(events).toEqual([])
    expect(state.text).toBe('')
    expect(state.usage.inputTokens).toBe(0)
  })

  it('usage_update 只有 size 没有 used：不写用量', () => {
    const state = stateOf()
    handleSessionUpdate(
      { sessionId: 'sess-1', update: { sessionUpdate: 'usage_update', size: 200_000 } },
      state,
      () => undefined,
    )
    expect(state.usage.inputTokens).toBe(0)
  })

  it('文本块缺 text、缺 sessionId、tool_call 缺 toolCallId、tool_call_update 缺 status', () => {
    const state = stateOf()
    const events: Array<Omit<RunEvent, 'seq'>> = []
    const emit = (event: Omit<RunEvent, 'seq'>): void => {
      events.push(event)
    }

    // content 是 text 块但没有 text 字段
    handleSessionUpdate(
      {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text' } },
      },
      state,
      emit,
    )
    // params 里没有 sessionId（非字符串）
    handleSessionUpdate(
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } },
      state,
      emit,
    )
    // tool_call 缺 toolCallId
    handleSessionUpdate(
      { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', title: 'read' } },
      state,
      emit,
    )
    // tool_call_update 缺 status：不是终态，跳过
    handleSessionUpdate(
      { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c9' } },
      state,
      emit,
    )

    expect(events).toEqual([{ type: 'tool_call', tool: 'read', callId: '', input: '' }])
    expect(state.text).toBe('')
  })

  it('decidePermission：选项没有 kind 不算 allow（回拒绝）', () => {
    expect(
      decidePermission(
        {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 'p1', title: 'Run' },
          options: [{ optionId: 'a1', name: 'Allow（缺 kind）' }],
        },
        'workspace-write',
      ),
    ).toEqual({
      result: { outcome: { outcome: 'cancelled' } },
      allowed: false,
      tool: 'Run',
      callId: 'p1',
      options: ['Allow（缺 kind）'],
    })
  })

  it('decidePermission：options 不是数组、toolCall 不是对象 → 回拒绝且工具名为空', () => {
    expect(decidePermission({ options: 'nope', toolCall: 'nope' }, 'workspace-write')).toEqual({
      result: { outcome: { outcome: 'cancelled' } },
      allowed: false,
      tool: '',
      callId: '',
      options: [],
    })
  })
})

describe('常量和选项缺省', () => {
  it('协议版本、超时与宽限都是正数', () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1)
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(MODELS_TIMEOUT_MS).toBeGreaterThan(0)
    expect(RUN_TIMEOUT_MS).toBeGreaterThan(0)
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CANCEL_GRACE_MS).toBeGreaterThan(0)
    expect(KILL_GRACE_MS).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 覆盖率补口：一次性进程收尾（stopLink / connect）
// ---------------------------------------------------------------------------

describe('wire：connect 与 stopLink', () => {
  interface LinkFixture {
    link: AcpLink
    h: Harness
    child: FakeChild
  }

  /** 直接用 connect 造 link（探针 / 模型目录的收尾只走这一条路径） */
  const makeLink = (configure?: (child: FakeChild) => void): LinkFixture => {
    const h = harness(undefined, configure)
    const sdk = fakeSdk({ spawn: h.spawn, killTree: h.killTree })
    const child = sdk.process.spawn(NODE, ['acp'], { env: {} })
    return { link: connect(sdk, child), h, child: h.children[0] }
  }

  it('进程不退：SIGTERM 后宽限到点补 SIGKILL，stopLink 不悬挂', async () => {
    const { link, h } = makeLink((child) => {
      child.closeOnKill = false
    })

    await stopLink(link, 5)

    expect(h.killedTrees).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ])
    // 强杀后不再等 close：stopLink 已经返回，进程状态仍未关闭
    expect(link.closed()).toBe(false)
  })

  it('进程已退出：stopLink 直接返回，不杀进程树', async () => {
    const { link, h, child } = makeLink((item) => {
      item.closeOnKill = false
    })
    child.close(0)
    expect(link.closed()).toBe(true)

    await stopLink(link, 5)

    expect(h.killedTrees).toEqual([])
  })

  it('宽限内正常退出：只发 SIGTERM，SIGKILL 的定时器被清掉', async () => {
    const { link, h } = makeLink()

    await stopLink(link, 50)
    await delay(10)

    expect(h.killedTrees).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    expect(link.closed()).toBe(true)
  })

  it('连接关闭时在途请求被拒绝（不会挂到请求超时）', async () => {
    const { link, child } = makeLink((item) => {
      item.closeOnKill = false
    })

    const pending = link.acp.request('initialize', {}, 60_000)
    child.close(0)

    await expect(pending).rejects.toThrow('子进程已退出')
    expect(link.exitCode()).toBe(0)
    expect(link.error()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 覆盖率补口：run 的条件分支（协议版本缺失 / cwd 回落 / 空进程 / 通知过滤 / 取消边界）
// ---------------------------------------------------------------------------

describe('executeHermesRun：条件分支补口', () => {
  it('initialize 没给 protocolVersion：protocol_error 文案报「缺失」', async () => {
    const { receipt, frames } = await runWith({
      initialize: (_frame, child, id) => replyResult(child, id, {}),
    })
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('缺失')
    expect(frames.map((frame) => frame.method)).toEqual(['initialize'])
  })

  it('turn.cwd 为空：回落宿主默认目录（spawn 与 session/new 都用它）', async () => {
    const h = acpHarness()
    const { running } = startRun(h, {
      turn: { cwd: '' },
      sdk: { cwd: 'D:/main-cwd' },
    })
    expect(h.calls[0].options.cwd).toBe('D:/main-cwd')

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(h.children[0].frames()[1].params).toEqual({ mcpServers: [], cwd: 'D:/main-cwd' })
  })

  it('spawn 返回空进程：spawn_failed「启动失败」，不发事件', async () => {
    const h = acpHarness()
    const spawn: SpawnFn = () => undefined as unknown as Spawned
    const { running, events } = startRun(h, { sdk: { spawn } })

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toBe('启动失败')
    expect(events).toEqual([])
  })

  it('spawn 抛非 Error 值：文案按 String 归一（errMsg 的保底分支）', async () => {
    const h = acpHarness()
    const spawn: SpawnFn = () => {
      throw 'EPERM-literal'
    }
    const { running } = startRun(h, { sdk: { spawn } })

    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('EPERM-literal')
  })

  it('非 session/update 的通知：忽略（不进事件流）', async () => {
    const { events } = await runWith({
      'session/prompt': (_frame, child, id) => {
        notify(child, 'hermes/heartbeat', { at: 1 })
        update(child, 'sess-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'x' },
        })
        replyResult(child, id, { stopReason: 'end_turn' })
      },
    })
    expect(events.map((event) => event.type)).toEqual(['text'])
  })

  it('会话还没建立就取消：不发 session/cancel，宽限后 SIGTERM 收尾', async () => {
    // 握手不回帧 → sessionId 永远为空
    const h = acpHarness({ initialize: () => undefined })
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 2, kill: 2 } },
    })
    const child = h.children[0]

    controller.abort()
    const receipt = await running

    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    // 只有 initialize：没有 session/cancel（还不知道会话 id）
    expect(child.methods()).toEqual(['initialize'])
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
  })

  it('进程已退出后才 abort：不发取消通知，也不杀已退出的进程树', async () => {
    const h = acpHarness({ 'session/prompt': () => undefined }, (child) => {
      child.closeOnKill = false
    })
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 2, kill: 2 } },
    })
    const child = h.children[0]
    await waitForMethod(child, 'session/prompt')

    child.close(0)
    controller.abort()
    const receipt = await running

    expect(receipt.status).toBe('cancelled')
    expect(h.killedTrees).toEqual([])
    expect(child.methods()).not.toContain('session/cancel')
  })

  it('turn.timeoutMs 非正数且没注入 run 超时：回退到 RUN_TIMEOUT_MS（假定时器）', async () => {
    vi.useFakeTimers()
    try {
      const h = acpHarness({ 'session/prompt': () => undefined })
      const { running } = startRun(h, {
        turn: { timeoutMs: 0 },
        options: { grace: { cancel: 1, kill: 1 } },
      })

      await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(5)
      const receipt = await running

      expect(receipt.status).toBe('failed')
      expect(receipt.errorCode).toBe('timeout')
      expect(receipt.error).toContain(`${RUN_TIMEOUT_MS}ms`)
    } finally {
      vi.useRealTimers()
    }
  })
})
