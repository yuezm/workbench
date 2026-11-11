// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent, Runtime } from '../../../../src/protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../../src/protocol/executor'
import type { ExecutorContext, SpawnFn, SpawnOptions, Spawned } from '../../../../src/sdk/types'
import {
  CANCEL_GRACE_MS,
  DSH_PROTOCOL_VERSION,
  KILL_GRACE_MS,
  MODELS_TIMEOUT_MS,
  OUTPUT_TAIL_LIMIT,
  PROBE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
} from '../../../../src/plugins/executors/dsh/constants'
import { listDshModels, providerOf } from '../../../../src/plugins/executors/dsh/models'
import { probeDshRuntime } from '../../../../src/plugins/executors/dsh/probe'
import {
  clearExecutorTimers,
  executeDshRun,
  type DshOptions,
} from '../../../../src/plugins/executors/dsh/run'
import { parseModelId } from '../../../../src/plugins/shared/model-id'
import { fakeSdk, type FakeSdkOverrides } from '../../support/fake-sdk'

/** 用 node 自身作为「存在的可执行文件」，避免依赖本机 dsh */
const NODE = process.execPath

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
  private readonly outStream = new FakeStream()
  private readonly errStream = new FakeStream()
  readonly stdin = {
    write: (chunk: string): boolean => {
      if (this.writeThrows) throw new Error('stdin closed')
      this.writes.push(chunk)
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
    configure?.(child)
    children.push(child)
    calls.push({ command, args, options })
    if (respond) queueMicrotask(() => respond(args, child))
    return child
  }
  const killTree = (pid: number, signal?: NodeJS.Signals): boolean => {
    killedTrees.push({ pid, signal })
    return true
  }
  return { spawn, killTree, children, killedTrees, calls }
}

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: NODE,
  profile: 'multica',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...over,
})

const turnOf = (over: Partial<Turn> = {}): Turn => ({
  runId: 'run-1',
  // 插件把 leaseId 当协议 request_id（每轮领取唯一）；夹具沿用旧测试的 'req-1'
  leaseId: 'req-1',
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
  options?: DshOptions
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
    running: executeDshRun(ctxOf(h, spec.runtime, spec.sdk), turnOf(spec.turn), io, spec.options),
    events,
  }
}

const frame = (value: Record<string, unknown>): string => JSON.stringify(value) + '\n'

describe('parseModelId', () => {
  it('拆分 provider/model 并解码百分号转义', () => {
    expect(parseModelId('magpie/workbuddy%2Fauto')).toEqual({
      provider: 'magpie',
      id: 'workbuddy/auto',
    })
    expect(parseModelId('  deepseek-account/deepseek-v4-pro ')).toEqual({
      provider: 'deepseek-account',
      id: 'deepseek-v4-pro',
    })
  })

  it('格式不合法返回 null', () => {
    expect(parseModelId('')).toBeNull()
    expect(parseModelId('   ')).toBeNull()
    expect(parseModelId('nomodel')).toBeNull()
    expect(parseModelId('/model')).toBeNull()
    expect(parseModelId('provider/')).toBeNull()
    // 非法百分号转义：按原文保留，不抛错
    expect(parseModelId('provider/%E0%A4%A')).toEqual({ provider: 'provider', id: '%E0%A4%A' })
  })
})

describe('probeDshRuntime', () => {
  it('命令解析不到：unavailable，path 为 null', async () => {
    const h = harness()
    const probe = await probeDshRuntime(ctxOf(h, { command: 'definitely-not-a-cmd-xyz' }))
    expect(probe.state).toBe('unavailable')
    expect(probe.path).toBeNull()
    expect(probe.error).toContain('PATH')
    expect(h.children).toHaveLength(0)
  })

  it('就绪：读版本 + --probe 帧，字段齐全', async () => {
    let tick = 0
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('0.2.1-rc.5\n')
        child.close(0)
        return
      }
      child.emitStdout(
        frame({
          v: 1,
          type: 'probe',
          runtime: 'dsh',
          protocol_version: 1,
          plugin_version: '0.2.0-private.1',
        }),
      )
      child.emitStderr('warning: something\n')
      child.close(0)
    })
    const probe = await probeDshRuntime(ctxOf(h, {}, { now: () => (tick += 5) }))
    expect(probe.state).toBe('ready')
    expect(probe.path).toBe(NODE)
    expect(probe.cliVersion).toBe('0.2.1-rc.5')
    expect(probe.protocolVersion).toBe(1)
    expect(probe.pluginVersion).toBe('0.2.0-private.1')
    expect(probe.error).toBeNull()
    expect(probe.elapsedMs).toBeGreaterThan(0)
    expect(probe.checkedAt).toBe(new Date(10).toISOString())
    expect(probe.output).toContain('warning')
    // --version 与 --probe 都用了 --profile
    expect(h.calls.map((c) => c.args)).toEqual([
      ['--profile', 'multica', '--version'],
      ['--profile', 'multica', '--probe'],
    ])
  })

  it('版本读取失败不阻断探测（cliVersion 为 null）', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.fail(new Error('version crashed'))
        return
      }
      child.emitStdout(frame({ v: 1, type: 'probe', runtime: 'dsh', protocol_version: 1 }))
      child.close(0)
    })
    const probe = await probeDshRuntime(ctxOf(h))
    expect(probe.state).toBe('ready')
    expect(probe.cliVersion).toBeNull()
    expect(probe.pluginVersion).toBeNull()
  })

  it('版本输出没有 semver：cliVersion 为 null 但探测仍成功', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('dsh (dev build)\n')
        child.close(0)
        return
      }
      child.emitStdout(frame({ v: 1, type: 'probe', runtime: 'dsh', protocol_version: 1 }))
      child.close(0)
    })
    const probe = await probeDshRuntime(ctxOf(h))
    expect(probe.state).toBe('ready')
    expect(probe.cliVersion).toBeNull()
  })

  it('probe 帧缺少 protocol_version：unavailable', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('0.2.1\n')
        child.close(0)
        return
      }
      child.emitStdout(frame({ v: 1, type: 'probe', runtime: 'dsh' }))
      child.close(0)
    })
    const probe = await probeDshRuntime(ctxOf(h))
    expect(probe.state).toBe('unavailable')
    expect(probe.protocolVersion).toBeNull()
  })

  it('协议版本不兼容：unavailable', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('0.2.1\n')
        child.close(0)
        return
      }
      child.emitStdout(frame({ v: 2, type: 'probe', runtime: 'dsh', protocol_version: 2 }))
      child.close(0)
    })
    const probe = await probeDshRuntime(ctxOf(h))
    expect(probe.state).toBe('unavailable')
    expect(probe.protocolVersion).toBe(2)
    expect(probe.error).toContain('协议版本')
  })

  it('runtime 不是 dsh：unavailable', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('0.2.1\n')
        child.close(0)
        return
      }
      child.emitStdout(frame({ v: 1, type: 'probe', runtime: 'other', protocol_version: 1 }))
      child.close(0)
    })
    const probe = await probeDshRuntime(ctxOf(h))
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('runtime')
  })

  it('没有 probe 帧且非零退出：unavailable，保留 stderr', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('0.2.1\n')
        child.close(0)
        return
      }
      child.emitStderr('profile not found\n')
      child.close(3)
    })
    const probe = await probeDshRuntime(ctxOf(h, { profile: 'nope' }))
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('退出码 3')
    expect(probe.error).toContain('profile not found')
  })

  it('没有 probe 帧但正常退出：unavailable 提示未提供 --probe', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('0.2.1\n')
        child.close(0)
        return
      }
      child.close(0)
    })
    const probe = await probeDshRuntime(ctxOf(h))
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('--probe')
  })

  it('探测超时：unavailable 并杀进程树', async () => {
    const h = harness()
    const probe = await probeDshRuntime(ctxOf(h), { timeouts: { version: 5, probe: 5 } })
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('超时')
    expect(h.killedTrees.length).toBeGreaterThan(0)
  })

  it('collect 收尾幂等：spawn 报错后再 close，finish 直接早退（T12b 覆盖率）', async () => {
    const h = harness()
    const probe = probeDshRuntime(ctxOf(h), { timeouts: { version: 50, probe: 50 } })
    // spawn 失败已 finish（并清掉自身定时器）；随后 close 再 finish → 直接早退
    h.children[0].fail(new Error('spawn 失败'))
    h.children[0].close(null)

    expect((await probe).state).toBe('unavailable')
  })

  it('spawn 抛错：unavailable', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn EPERM')
    }
    const probe = await probeDshRuntime(ctxOf(harness(), {}, { spawn }), {
      timeouts: { version: 5, probe: 5 },
    })
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('启动探测失败')
    expect(probe.error).toContain('EPERM')
  })
})

describe('providerOf', () => {
  it('provider 优先；缺失时从 id 前缀兜底；id 不是字符串时回落空串', () => {
    expect(providerOf({ provider: 'DeepSeek Account' })).toBe('DeepSeek Account')
    expect(providerOf({ id: 'magpie/workbuddy' })).toBe('magpie')
    // id 不是字符串：调用点（listDshModels）先过滤，这里直接构造输入覆盖兜底分支
    expect(providerOf({ id: 123 })).toBe('')
    // provider 只有空白且没有 id：同样回落空串
    expect(providerOf({ provider: '  ' })).toBe('')
  })
})

describe('listDshModels', () => {
  it('解析模型帧：thinking 两种形态、provider 兜底、默认标记', async () => {
    const h = harness((_args, child) => {
      child.emitStdout(
        frame({
          v: 1,
          type: 'models',
          models: [
            {
              id: 'deepseek-account/deepseek-v4-pro',
              label: 'DeepSeek-V4-Pro',
              provider: 'DeepSeek Account',
              default: true,
              thinking: {
                supported_levels: [{ value: 'low' }, { value: 'high' }, 'raw-level', {}],
                default_level: 'high',
              },
            },
            { id: 'magpie/workbuddy%2Fauto', label: 'Auto' },
            { id: '  ' },
            { label: '没有 id' },
          ],
        }),
      )
      // 非 models 帧与非 JSON 行忽略
      child.emitStdout('\n')
      child.emitStdout('not json\n')
      child.emitStdout(frame({ v: 1, type: 'other' }))
      child.close(0)
    })
    const models = await listDshModels(ctxOf(h))
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({
      id: 'deepseek-account/deepseek-v4-pro',
      label: 'DeepSeek-V4-Pro',
      provider: 'DeepSeek Account',
      default: true,
      thinkingLevels: ['low', 'high', 'raw-level'],
      defaultThinkingLevel: 'high',
    })
    expect(models[1].provider).toBe('magpie')
    expect(models[1].thinkingLevels).toEqual([])
    expect(models[1].default).toBe(false)
  })

  it('模型目录为空：抛错', async () => {
    const h = harness((_args, child) => {
      child.close(0)
    })
    await expect(listDshModels(ctxOf(h))).rejects.toThrow(/模型目录为空/)
  })

  it('非零退出：错误带 stderr', async () => {
    const h = harness((_args, child) => {
      child.emitStderr('boom\n')
      child.close(2)
    })
    await expect(listDshModels(ctxOf(h))).rejects.toThrow(/退出码 2[\s\S]*boom/)
  })

  it('超时：抛错', async () => {
    const h = harness()
    await expect(listDshModels(ctxOf(h), { timeouts: { models: 5 } })).rejects.toThrow(
      `读取模型目录超时（5ms）`,
    )
  })

  it('spawn 抛错：抛错', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('nope')
    }
    await expect(
      listDshModels(ctxOf(harness(), {}, { spawn }), { timeouts: { models: 5 } }),
    ).rejects.toThrow(/启动失败[\s\S]*nope/)
  })

  it('命令不存在：抛错', async () => {
    const h = harness()
    await expect(listDshModels(ctxOf(h, { command: 'missing-cmd-xyz' }))).rejects.toThrow(/PATH/)
  })

  it('被信号杀掉（退出码 null）且无模型帧：错误文案显示退出码 null', async () => {
    const h = harness((_args, child) => {
      child.close(null)
    })

    await expect(listDshModels(ctxOf(h))).rejects.toThrow('读取模型目录退出码 null')
  })
})

describe('clearExecutorTimers', () => {
  it('定时器都没设置时全部跳过，不抛错', () => {
    expect(() => clearExecutorTimers({})).not.toThrow()
    expect(() =>
      clearExecutorTimers({ timeout: undefined, cancelGrace: undefined, kill: undefined }),
    ).not.toThrow()
  })
})

describe('executeDshRun', () => {
  it('成功：写 execute 帧并按顺序发事件，汇总 usage/output/session', async () => {
    let tick = 0
    const h = harness()
    const controller = new AbortController()
    const sessionCalls: string[] = []
    const processCalls: number[] = []
    const { running, events } = startRun(h, {
      // 执行配置来自智能体（宿主折进 Turn）：模型已是 {provider,id}，强度 / cwd / env 同理
      turn: {
        model: { provider: 'magpie', id: 'workbuddy/auto' },
        effort: 'high',
        cwd: 'C:/work',
        env: { HTTP_PROXY: 'http://127.0.0.1:7890' },
        resumeSessionId: 'sess-prev',
        signal: controller.signal,
      },
      sdk: { now: () => (tick += 3), sessionRoot: 'C:/sessions' },
      io: {
        session: (id) => sessionCalls.push(id),
        process: (pid) => processCalls.push(pid),
      },
    })
    const child = h.children[0]
    expect(child.frames()).toEqual([
      {
        v: 1,
        type: 'execute',
        request_id: 'req-1',
        cwd: 'C:/work',
        prompt: '只回复 OK',
        mcp_servers: [],
        model: { provider: 'magpie', id: 'workbuddy/auto' },
        reasoning_effort: 'high',
        resume_session_id: 'sess-prev',
      },
    ])
    expect(h.calls[0].options.env.DSH_PERMISSION_MODE).toBe('workspace-write')
    expect(h.calls[0].options.env.MULTICA_DSH_SESSION_ROOT).toBe('C:/sessions')
    // 智能体的环境变量原样铺开（权限与会话根随后覆盖，智能体改不动权限）
    expect(h.calls[0].options.env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'session', session_id: 'sess-1' }))
    child.emitStdout(frame({ v: 1, type: 'text', content: '你' }))
    child.emitStdout(frame({ v: 1, type: 'thinking', content: '想一想' }))
    child.emitStdout(
      frame({
        v: 1,
        type: 'tool_call',
        call_id: 'c1',
        name: 'read',
        arguments: '{"path":"a"}',
      }),
    )
    child.emitStdout(
      frame({
        v: 1,
        type: 'tool_result',
        call_id: 'c1',
        name: 'read',
        output: 'content',
        is_error: true,
      }),
    )
    child.emitStdout(
      frame({
        v: 1,
        type: 'usage',
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 2,
        cache_write_tokens: 1,
      }),
    )
    child.emitStdout(frame({ v: 1, type: 'text', content: '好' }))
    child.emitStdout(
      frame({
        v: 1,
        type: 'result',
        status: 'completed',
        output: '你好',
        session_id: 'sess-1',
      }),
    )
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe('你好')
    expect(receipt.errorCode).toBeUndefined()
    expect(receipt.exitCode).toBe(0)
    expect(receipt.sessionId).toBe('sess-1')
    expect(receipt.resumeRejected).toBeUndefined()
    expect(receipt.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    })
    expect(receipt.durationMs).toBeGreaterThan(0)
    expect(receipt.leaseId).toBe('req-1')
    expect(receipt.turn).toBe(1)
    expect(events.map((e) => e.type)).toEqual([
      'status',
      'text',
      'thinking',
      'tool_call',
      'tool_result',
      'text',
    ])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events[3]).toMatchObject({
      type: 'tool_call',
      tool: 'read',
      callId: 'c1',
      input: '{"path":"a"}',
    })
    expect(events[4]).toMatchObject({ type: 'tool_result', isError: true, output: 'content' })
    expect(child.stdinEnded).toBe(true)
    // 旁路通道：pid 立即上报、会话 id 经 io.session 回报
    expect(processCalls).toEqual([4242])
    expect(sessionCalls).toEqual(['sess-1'])
  })

  it('宿主没配 sessionRoot：智能体写的同名会话根被删掉（路径只由宿主决定）', async () => {
    const h = harness()
    const { running } = startRun(h, {
      turn: { env: { MULTICA_DSH_SESSION_ROOT: 'C:/agent-sessions' } },
      sdk: { sessionRoot: null },
    })
    const child = h.children[0]

    expect(h.calls[0].options.env.MULTICA_DSH_SESSION_ROOT).toBeUndefined()
    expect(h.calls[0].options.env.DSH_PERMISSION_MODE).toBe('workspace-write')

    // 正常收尾：不留下悬空的执行器 Promise
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(
      frame({ v: 1, type: 'result', status: 'completed', output: 'ok', session_id: 'sess-1' }),
    )
    child.close(0)
    await running
  })

  it('result 帧没有 output 时回退到 text 累计', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'text', content: 'abc' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed' }))
    child.close(0)
    expect((await running).output).toBe('abc')
  })

  it('result=failed：run_failed，错误取帧内 code/message', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(
      frame({
        v: 1,
        type: 'result',
        status: 'failed',
        error: { code: 'model_error', message: '额度不足' },
      }),
    )
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toBe('model_error: 额度不足')
  })

  it('result=failed 且无 error 文本：给兜底文案', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'failed' }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.error).toContain('status=failed')
  })

  it('result=cancelled：cancelled', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'cancelled' }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(receipt.error).toBe('已取消')
  })

  it('result=timeout：回执折成 failed + errorCode=timeout', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'timeout' }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('timeout')
  })

  it('未知 result 状态：failed', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'weird' }))
    child.close(0)
    expect((await running).status).toBe('failed')
  })

  it('无 result + 非零退出：exit_nonzero，错误带 stderr 尾部', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStderr('fatal: bad config\n')
    child.close(7)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('exit_nonzero')
    expect(receipt.error).toContain('退出码 7')
    expect(receipt.error).toContain('bad config')
  })

  it('无 result + 正常退出：no_result', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.close(0)
    const receipt = await running
    expect(receipt.errorCode).toBe('no_result')
    expect(receipt.error).toContain('终态结果')
  })

  it('未 ready 即退出：protocol_error', async () => {
    const h = harness()
    const { running } = startRun(h)
    h.children[0].close(0)
    const receipt = await running
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('未就绪')
  })

  it('protocol_error 帧：protocol_error', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'protocol_error', code: 'bad', message: '帧坏了' }))
    child.close(0)
    const receipt = await running
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('bad: 帧坏了')
  })

  it('协议版本不符：protocol_error', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 2, type: 'ready', runtime: 'dsh' }))
    child.close(0)
    const receipt = await running
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('协议版本')
  })

  it('ready 帧 runtime 不是 dsh：protocol_error', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'other' }))
    child.close(0)
    expect((await running).errorCode).toBe('protocol_error')
  })

  it('忽略 request_id 不匹配、无效 JSON 与未知帧', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout('not json\n')
    child.emitStdout(frame({ v: 1, type: 'text', request_id: 'other', content: 'x' }))
    child.emitStdout(frame({ v: 1, type: 'unknown', content: 'y' }))
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(events).toEqual([])
  })

  it('订阅方抛错不影响执行', async () => {
    const h = harness()
    const { running } = startRun(h, {
      io: {
        emit: () => {
          throw new Error('subscriber boom')
        },
      },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'text', content: 'x' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'x' }))
    child.close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('resume_rejected 透传给调用方', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { resumeSessionId: 'dead-session' } })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(
      frame({
        v: 1,
        type: 'result',
        status: 'failed',
        resume_rejected: true,
        session_id: 'new-session',
        error: { code: 'resume_rejected', message: '会话已失效' },
      }),
    )
    child.close(0)
    const receipt = await running
    expect(receipt.resumeRejected).toBe(true)
    expect(receipt.sessionId).toBe('new-session')
  })

  it('取消：cancel 帧 → 宽限后 SIGTERM → SIGKILL，终态 cancelled', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 5, kill: 5 } },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    controller.abort()
    expect(child.frames().at(-1)).toEqual({ v: 1, type: 'cancel', request_id: 'req-1' })
    await new Promise((resolve) => setTimeout(resolve, 8))
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    await new Promise((resolve) => setTimeout(resolve, 8))
    expect(h.killedTrees).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ])
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
  })

  it('超时：cancel 协议 + failed/timeout 终态', async () => {
    const h = harness()
    const { running } = startRun(h, {
      turn: { timeoutMs: 5 },
      options: { grace: { cancel: 5, kill: 5 } },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    await new Promise((resolve) => setTimeout(resolve, 12))
    expect(child.frames().at(-1)).toMatchObject({ type: 'cancel' })
    child.close(null)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain('超时')
    expect(receipt.exitCode).toBeUndefined()
  })

  it('超时已收尾后子进程才 close：finish 幂等（T12b 覆盖率）', async () => {
    const h = harness()
    const { running } = startRun(h, {
      turn: { timeoutMs: 5 },
      options: { grace: { cancel: 5, kill: 5 } },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    await new Promise((resolve) => setTimeout(resolve, 12))
    child.close(null)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('timeout')

    // 已收尾后再 close：第二次 finish 直接早退
    child.close(null)
  })

  it('关闭收尾 flush 期间再 abort：terminate 看到 closed 直接返回（T14bc 覆盖率）', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 5, kill: 5 } },
      io: { emit: () => controller.abort() },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    // 半行文本帧留在缓冲：close 时 lines.flush() 解析 → io.emit 同步 abort
    child.emitStdout(frame({ v: 1, type: 'text', content: 'x' }).slice(0, -1))
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('failed')
    // 已关闭的进程不再杀进程树
    expect(h.killedTrees).toEqual([])
  })

  it('进程已关闭后不再杀进程树', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 5, kill: 5 } },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.close(0)
    await running
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(h.killedTrees).toEqual([])
  })

  it('命令解析不到：spawn_failed，不发事件', async () => {
    const h = harness()
    const { running, events } = startRun(h, { runtime: { command: 'missing-cmd-xyz' } })
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(h.children).toHaveLength(0)
    expect(events).toEqual([])
  })

  it('spawn 抛错：spawn_failed', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('EPERM')
    }
    const h = harness()
    const { running } = startRun(h, { sdk: { spawn } })
    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('EPERM')
  })

  it('execute 帧写入失败：spawn_failed 并终止进程', async () => {
    const h = harness(undefined, (child) => {
      child.writeThrows = true
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('execute 帧')
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: undefined }])
  })

  it('子进程没有 pid 时用 child.kill 兜底（取消 → SIGTERM → SIGKILL）', async () => {
    const h = harness(undefined, (child) => {
      child.pid = undefined
    })
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 5, kill: 5 } },
    })
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 40))
    const child = h.children[0]
    child.close(0)
    expect((await running).status).toBe('cancelled')
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('signal 已取消：直接返回 cancelled，不启动进程', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    const { running } = startRun(h, { turn: { signal: controller.signal } })
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(h.children).toHaveLength(0)
  })

  it('宿主给 null 模型：execute 帧不带 model / reasoning_effort，按 CLI 默认跑', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { model: null, effort: null } })
    const frameIn = h.children[0].frames()[0]
    expect(frameIn).not.toHaveProperty('model')
    expect(frameIn).not.toHaveProperty('reasoning_effort')

    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    child.close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('智能体的 env 不能覆盖宿主判定的权限模式（DSH_PERMISSION_MODE 由 Turn.access 决定）', async () => {
    const h = harness()
    const { running } = startRun(h, {
      turn: { access: 'read', env: { DSH_PERMISSION_MODE: 'danger-full-access' } },
    })
    expect(h.calls[0].options.env.DSH_PERMISSION_MODE).toBe('read-only')

    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    child.close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('子进程 error 事件：spawn_failed 并收尾', async () => {
    const h = harness()
    const { running } = startRun(h)
    h.children[0].fail(new Error('EACCES'))
    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('EACCES')
  })

  it('帧字段缺省：用空值兜底且不产生多余事件', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'session' }))
    child.emitStdout(frame({ v: 1, type: 'text' }))
    child.emitStdout(frame({ v: 1, type: 'thinking' }))
    child.emitStdout(frame({ v: 1, type: 'tool_call' }))
    child.emitStdout(frame({ v: 1, type: 'tool_result' }))
    child.emitStdout(frame({ v: 1, type: 'usage' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed' }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.sessionId).toBeUndefined()
    expect(receipt.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(events.map((event) => event.type)).toEqual(['status', 'tool_call', 'tool_result'])
    expect(events[1]).toMatchObject({ tool: '', callId: '', input: '' })
    expect(events[2]).toMatchObject({ output: '', isError: false })
  })

  it('常量与协议版本对齐 Multica（v1）', () => {
    expect(DSH_PROTOCOL_VERSION).toBe(1)
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(MODELS_TIMEOUT_MS).toBeGreaterThan(0)
    expect(RUN_TIMEOUT_MS).toBeGreaterThan(0)
    expect(CANCEL_GRACE_MS).toBeGreaterThan(0)
    expect(KILL_GRACE_MS).toBeGreaterThan(0)
  })
})

describe('缺省与异常帧（补充分支）', () => {
  it('parseModelId：两侧空白段视为非法', () => {
    expect(parseModelId('%20/a')).toBeNull()
    expect(parseModelId('a/%20')).toBeNull()
  })

  it('探测：子进程无 pid 时用 child.kill 兜底', async () => {
    const h = harness(undefined, (child) => {
      child.pid = undefined
    })
    const probe = await probeDshRuntime(ctxOf(h), { timeouts: { version: 5, probe: 5 } })
    expect(probe.state).toBe('unavailable')
    expect(h.children[0].killed).toContain('SIGKILL')
  })

  it('探测：被信号杀掉（退出码 null）时错误文案可读', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('0.2.1\n')
        child.close(0)
        return
      }
      child.close(null)
    })
    const probe = await probeDshRuntime(ctxOf(h))
    expect(probe.error).toContain('探测退出码 null')
  })

  it('sdk 解析不到命令：probe/models/run 三条路径都给出可读失败（等价于 CLI 未安装）', async () => {
    // 原「不注入 spawn 时用默认实现」在插件化后不再适用：sdk 必注入。
    // 等价覆盖「本机没有 CLI」：resolve 返回 null，三条入口都应失败且不 spawn。
    const h = harness()
    const ctx = ctxOf(h, { command: 'missing-cmd-xyz' })
    await expect(probeDshRuntime(ctx)).resolves.toMatchObject({ state: 'unavailable' })
    await expect(listDshModels(ctx)).rejects.toThrow(/PATH/)
    const receipt = await executeDshRun(ctx, turnOf(), { emit: () => undefined })
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(h.children).toHaveLength(0)
  })

  it('execute：error 之后再 close 只收口一次', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.fail(new Error('pipe broken'))
    child.close(0)
    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
  })

  it('execute：取消后立刻退出，宽限定时器发现已关闭就停手', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { cancel: 5, kill: 5 } },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    controller.abort()
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 16))
    expect(h.killedTrees).toEqual([])
  })

  it('execute：非对象 JSON、缺字段的 protocol_error/result、未知状态', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout('null\n')
    child.emitStdout('[]\n')
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'protocol_error' }))
    child.emitStdout(frame({ v: 1, type: 'result' }))
    child.close(1)
    const receipt = await running
    // 最后一条 result 优先：状态缺省 → failed，错误兜底文案
    expect(receipt.status).toBe('failed')
    expect(receipt.error).toContain('status=')
    expect(events).toEqual([])
  })

  it('execute：写入失败且无 pid 时 child.kill 兜底', async () => {
    const h = harness(undefined, (child) => {
      child.pid = undefined
      child.writeThrows = true
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(h.children[0].killed).toEqual(['SIGKILL'])
  })

  it('models：无斜杠 id 的 provider 兜底为空、非字符串 label 回落 id', async () => {
    const h = harness((_args, child) => {
      child.emitStdout(
        frame({
          v: 1,
          type: 'models',
          models: [
            { id: 'nomodel', label: 123 },
            { id: 'a/b', label: '' },
          ],
        }),
      )
      child.close(0)
    })
    const models = await listDshModels(ctxOf(h))
    expect(models[0].provider).toBe('')
    expect(models[0].label).toBe('nomodel')
    expect(models[1].label).toBe('a/b')
  })
})

describe('诊断输出与脏帧边界（补充分支）', () => {
  it('stderr 超长：诊断只保留尾部并加省略号', async () => {
    const h = harness((_args, child) => {
      child.emitStderr('x'.repeat(OUTPUT_TAIL_LIMIT + 10))
      child.close(1)
    })

    const probe = await probeDshRuntime(ctxOf(h))

    expect(probe.state).toBe('unavailable')
    expect(String(probe.error)).toContain('…')
    expect(String(probe.error).endsWith('x'.repeat(10))).toBe(true)
  })

  it('空行与纯空白行不是帧：被忽略', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout('\n\r\n   \n')
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    child.close(0)

    const receipt = await running

    expect(receipt.status).toBe('succeeded')
    expect(events).toEqual([])
  })

  it('thinking 兼容脏数据：非字符串/非对象项忽略，空 default_level 归 null', async () => {
    const h = harness((_args, child) => {
      child.emitStdout(
        frame({
          v: 1,
          type: 'models',
          models: [
            {
              id: 'solo',
              thinking: {
                supported_levels: [null, 7, 'low', { value: '  ' }, { value: 'high' }],
                default_level: '  ',
              },
            },
          ],
        }),
      )
      child.close(0)
    })

    const models = await listDshModels(ctxOf(h))

    expect(models).toEqual([
      {
        id: 'solo',
        label: 'solo',
        provider: '',
        default: false,
        thinkingLevels: ['low', 'high'],
        defaultThinkingLevel: null,
      },
    ])
  })

  it('turn.timeoutMs 非正数：回退到 options.timeouts.run 的超时', async () => {
    const h = harness()
    const { running } = startRun(h, {
      turn: { timeoutMs: 0 },
      options: { timeouts: { run: 5 } },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    await new Promise((resolve) => setTimeout(resolve, 12))

    expect(child.frames().at(-1)).toMatchObject({ type: 'cancel' })
    child.close(null)
    const receipt = await running
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain('5ms')
  })

  it('spawn 抛非 Error：错误文案按 String 归一', async () => {
    const spawn: SpawnFn = () => {
      throw 'EPERM-literal'
    }
    const h = harness()

    const { running } = startRun(h, { sdk: { spawn } })

    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('EPERM-literal')
  })

  it('解析不到命令且没有 error 文案：run / probe / models 都用「找不到可执行文件」兜底', async () => {
    const resolve = (): { path: null; error: null } => ({ path: null, error: null })
    const h = harness()

    const { running } = startRun(h, { sdk: { resolve } })
    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('找不到可执行文件：' + NODE)

    const probe = await probeDshRuntime(ctxOf(h, {}, { resolve }))
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('找不到可执行文件：')

    await expect(listDshModels(ctxOf(h, {}, { resolve }))).rejects.toThrow('找不到可执行文件：')
  })
})

describe('取消/超时终止的定时器收尾（假定时器）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('超时与取消各挂一条宽限链：进程已关闭后孤儿宽限定时器不再杀进程树', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal, timeoutMs: 10 },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    // 超时先终止一次（宽限 1）；取消再终止一次（宽限 2 覆盖句柄，宽限 1 成为孤儿定时器）
    vi.advanceTimersByTime(10)
    controller.abort()
    child.close(0)
    const receipt = await running

    expect(receipt.errorCode).toBe('timeout')
    // 进程已关闭：孤儿宽限到点直接返回，不杀进程树
    vi.advanceTimersByTime(CANCEL_GRACE_MS)
    expect(h.killedTrees).toEqual([])
  })

  it('两条宽限链的强杀等待：进程已关闭后孤儿强杀定时器不再 SIGKILL', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal, timeoutMs: 10 },
    })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    vi.advanceTimersByTime(10)
    controller.abort()
    // 两条宽限都到点：各发一次 SIGTERM；后一条覆盖强杀句柄，前一条成为孤儿
    vi.advanceTimersByTime(CANCEL_GRACE_MS)
    expect(h.killedTrees).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGTERM' },
    ])
    child.close(0)
    const receipt = await running
    expect(receipt.errorCode).toBe('timeout')
    // 收尾只清掉最新强杀句柄；孤儿强杀定时器到点时进程已关闭，不再 SIGKILL
    vi.advanceTimersByTime(KILL_GRACE_MS)
    expect(h.killedTrees).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGTERM' },
    ])
  })

  it('turn.timeoutMs 非正数且未注入 options.timeouts：回退到 RUN_TIMEOUT_MS 超时', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { timeoutMs: 0 } })
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))

    vi.advanceTimersByTime(RUN_TIMEOUT_MS)

    expect(child.frames().at(-1)).toMatchObject({ type: 'cancel' })
    child.close(null)
    const receipt = await running
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain(`${RUN_TIMEOUT_MS}ms`)
  })
})

describe('工作目录来自 Turn（内核按「项目文件夹 > 智能体工作目录」写入 run.cwd）', () => {
  it('turn.cwd 有值就用它；空串回落到主进程当前目录（execute.cwd 不省略）', async () => {
    // turn.cwd=''：回落到 sdk.paths.cwd，spawn 与 execute 帧都用它
    const h = harness()
    const first = startRun(h, {
      turn: { cwd: '' },
      sdk: { cwd: 'D:/main-cwd' },
    })
    expect(h.calls[0].options.cwd).toBe('D:/main-cwd')
    expect(h.children[0].frames()[0].cwd).toBe('D:/main-cwd')
    h.children[0].emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    h.children[0].emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    h.children[0].close(0)
    expect((await first.running).status).toBe('succeeded')

    // turn.cwd 有值：它同时是 spawn 的 cwd 与 execute 帧的 cwd
    const hMid = harness()
    const mid = startRun(hMid, {
      turn: { cwd: 'C:/work' },
      sdk: { cwd: 'D:/main-cwd' },
    })
    expect(hMid.calls[0].options.cwd).toBe('C:/work')
    expect(hMid.children[0].frames()[0].cwd).toBe('C:/work')
    hMid.children[0].emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    hMid.children[0].emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    hMid.children[0].close(0)
    expect((await mid.running).status).toBe('succeeded')
  })
})

describe('回执块解析（M4）', () => {
  const outputWith = (value: unknown): string =>
    ['执行完成。', '```json', JSON.stringify(value), '```'].join('\n')

  /** 五字段齐全的合法回执块 */
  const fullBlock = {
    ask: [{ title: '选一个', text: '用哪个方案？', options: ['A', 'B'], key: 'plan' }],
    notices: ['已完成依赖安装'],
    resolves: ['card-0'],
    later: '2026-11-06T09:00:00.000Z',
    events: [{ source: 'agent', type: 'issues.opened', subject: 'issue-1', summary: '发现新问题' }],
  }

  it('result 帧 output 里的回执块：Receipt 五字段齐全，output 原文不变', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    const output = outputWith(fullBlock)
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output }))
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe(output)
    expect(receipt.ask).toEqual(fullBlock.ask)
    expect(receipt.notices).toEqual(fullBlock.notices)
    expect(receipt.resolves).toEqual(fullBlock.resolves)
    expect(receipt.later).toBe(fullBlock.later)
    expect(receipt.events).toEqual(fullBlock.events)
  })

  it('闸门判定（M11）：result 帧里的 verdict / checks 写进回执', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    const checks = [
      { cmd: 'git tag', exitCode: 0 },
      { cmd: 'npm whoami', exitCode: 1 },
    ]
    const output = outputWith({ verdict: 'fail', checks, notices: ['三项量级缺两项'] })
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output }))
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.verdict).toBe('fail')
    expect(receipt.checks).toEqual(checks)
    expect(receipt.notices).toEqual(['三项量级缺两项'])
  })

  it('回执块解析失败：五字段缺失，终态 / 错误 / output 不变', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    const output = outputWith({ ask: 1 })
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(
      frame({
        v: 1,
        type: 'result',
        status: 'failed',
        output,
        error: { code: 'model_error', message: '额度不足' },
      }),
    )
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toBe('model_error: 额度不足')
    expect(receipt.output).toBe(output)
    expect(receipt.ask).toBeUndefined()
    expect(receipt.notices).toBeUndefined()
    expect(receipt.resolves).toBeUndefined()
    expect(receipt.later).toBeUndefined()
    expect(receipt.events).toBeUndefined()
  })
})

describe('工具通道（M24）：tool_call 带回执参数', () => {
  /** 一条回执工具调用帧 */
  const toolCall = (value: unknown, name = 'workbench.receipt'): string =>
    frame({ v: 1, type: 'tool_call', name, call_id: 'call-1', arguments: JSON.stringify(value) })

  it('模型调了回执工具：结构化参数直接进回执，正文不需要围栏块', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(
      toolCall({
        verdict: 'pass',
        checks: [{ cmd: 'pnpm check', exitCode: 0 }],
        notices: ['来自工具'],
      }),
    )
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: '做完了。' }))
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe('做完了。')
    expect(receipt.verdict).toBe('pass')
    expect(receipt.checks).toEqual([{ cmd: 'pnpm check', exitCode: 0 }])
    expect(receipt.notices).toEqual(['来自工具'])
  })

  it('两条通道都有：工具通道优先（不吃「最后一块围栏块」的歧义）', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    const output = ['```json', JSON.stringify({ notices: ['来自文本'] }), '```'].join('\n')
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(toolCall({ notices: ['来自工具'] }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output }))
    child.close(0)

    const receipt = await running
    expect(receipt.notices).toEqual(['来自工具'])
  })

  it('工具名不认 / 参数非法 / 参数里没有回执键：工具通道不生效，退回文本块', async () => {
    const cases: Array<() => string> = [
      () => toolCall({ notices: ['工具'] }, 'mcp__other__receipt'),
      () => frame({ v: 1, type: 'tool_call', name: 'workbench.receipt', arguments: '{坏 JSON' }),
      () => toolCall({ foo: 1 }),
      () => toolCall({ ask: 1 }),
    ]
    for (const make of cases) {
      const h = harness()
      const { running } = startRun(h)
      const child = h.children[0]
      const output = ['```json', JSON.stringify({ notices: ['来自文本'] }), '```'].join('\n')
      child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
      child.emitStdout(make())
      child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output }))
      child.close(0)

      expect((await running).notices).toEqual(['来自文本'])
    }
  })

  it('工具调用照常进事件流（run.frames 审计面不丢）', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(toolCall({ notices: ['来自工具'] }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    child.close(0)
    await running

    const call = events.find((event) => event.type === 'tool_call')
    expect(call).toMatchObject({ tool: 'workbench.receipt', callId: 'call-1' })
    expect(call?.input).toContain('来自工具')
  })
})

describe('启动失败的兜底文案（spawn 返回空）', () => {
  it('sdk.process.spawn 返回空子进程、无 error 文案：回执走 spawn_failed + 「启动失败」', async () => {
    // 宿主缺陷：resolve 命中但 spawn 没给进程对象；startProcess 返回 { process: undefined }
    const spawn: SpawnFn = () => undefined as unknown as Spawned
    const h = harness()
    const { running, events } = startRun(h, { sdk: { spawn } })

    const receipt = await running

    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toBe('启动失败')
    expect(events).toEqual([])
  })

  it('宿主未提供默认 cwd 且 turn.cwd 为空：execute 帧省略 cwd（不写入 undefined 字段）', async () => {
    const h = harness()
    const base = fakeSdk({ spawn: h.spawn, killTree: h.killTree })
    const ctx: ExecutorContext = {
      runtime: runtime(),
      sdk: { ...base, paths: { sessionRoot: null, cwd: undefined as unknown as string } },
    }

    const running = executeDshRun(ctx, turnOf({ cwd: '' }), { emit: () => undefined })
    const child = h.children[0]

    expect(child.frames()[0]).not.toHaveProperty('cwd')

    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    child.close(0)
    expect((await running).status).toBe('succeeded')
  })
})
