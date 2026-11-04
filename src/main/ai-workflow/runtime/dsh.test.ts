// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../../shared/ai-workflow-api'
import {
  CANCEL_GRACE_MS,
  DSH_PROTOCOL_VERSION,
  KILL_GRACE_MS,
  MODELS_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  executeDshRun,
  listDshModels,
  parseModelId,
  probeDshRuntime,
  type DshDeps,
  type DshRunRequest,
} from './dsh'
import type { SpawnFn, SpawnedProcess } from './process'

/** 用 node 自身作为「存在的可执行文件」，避免依赖本机 dsh */
const NODE = process.execPath

class FakeChild implements SpawnedProcess {
  pid: number | undefined = 4242
  writes: string[] = []
  killed: string[] = []
  stdinEnded = false
  writeThrows = false
  stdin = {
    write: (chunk: string): boolean => {
      if (this.writeThrows) throw new Error('stdin closed')
      this.writes.push(chunk)
      return true
    },
    end: (): void => {
      this.stdinEnded = true
    },
  } as unknown as NodeJS.WritableStream
  stdout = new EventEmitter() as unknown as NodeJS.ReadableStream
  stderr = new EventEmitter() as unknown as NodeJS.ReadableStream
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
    ;(this.stdout as unknown as EventEmitter).emit('data', Buffer.from(text))
  }
  emitStderr(text: string): void {
    ;(this.stderr as unknown as EventEmitter).emit('data', Buffer.from(text))
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
  calls: Array<{ command: string; args: string[]; options: unknown }>
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

const runtime = (over: Partial<DshRunRequest['runtime']> = {}): DshRunRequest['runtime'] => ({
  command: NODE,
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  ...over,
})

function request(over: Partial<DshRunRequest> = {}, deps: Harness | null = null): DshRunRequest {
  void deps
  return {
    runtime: runtime(),
    requestId: 'req-1',
    prompt: '只回复 OK',
    signal: new AbortController().signal,
    ...over,
  }
}

const depsOf = (h: Harness, extra: DshDeps = {}): DshDeps => ({
  spawn: h.spawn,
  killTree: h.killTree,
  ...extra,
})

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
    const probe = await probeDshRuntime(
      { command: 'definitely-not-a-cmd-xyz', profile: 'multica' },
      depsOf(h),
    )
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
    const probe = await probeDshRuntime(
      { command: NODE, profile: 'multica' },
      depsOf(h, { now: () => (tick += 5) }),
    )
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
    const probe = await probeDshRuntime({ command: NODE, profile: 'multica' }, depsOf(h))
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
    const probe = await probeDshRuntime({ command: NODE, profile: 'multica' }, depsOf(h))
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
    const probe = await probeDshRuntime({ command: NODE, profile: 'multica' }, depsOf(h))
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
    const probe = await probeDshRuntime({ command: NODE, profile: 'multica' }, depsOf(h))
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
    const probe = await probeDshRuntime({ command: NODE, profile: 'multica' }, depsOf(h))
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
    const probe = await probeDshRuntime({ command: NODE, profile: 'nope' }, depsOf(h))
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
    const probe = await probeDshRuntime({ command: NODE, profile: 'multica' }, depsOf(h))
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('--probe')
  })

  it('探测超时：unavailable 并杀进程树', async () => {
    const h = harness()
    const probe = await probeDshRuntime(
      { command: NODE, profile: 'multica' },
      depsOf(h, { timeouts: { version: 5, probe: 5 } }),
    )
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('超时')
    expect(h.killedTrees.length).toBeGreaterThan(0)
  })

  it('spawn 抛错：unavailable', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn EPERM')
    }
    const probe = await probeDshRuntime(
      { command: NODE, profile: 'multica' },
      { spawn, timeouts: { version: 5, probe: 5 } },
    )
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('启动探测失败')
    expect(probe.error).toContain('EPERM')
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
    const models = await listDshModels({ command: NODE, profile: 'multica' }, depsOf(h))
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
    await expect(listDshModels({ command: NODE, profile: 'multica' }, depsOf(h))).rejects.toThrow(
      /模型目录为空/,
    )
  })

  it('非零退出：错误带 stderr', async () => {
    const h = harness((_args, child) => {
      child.emitStderr('boom\n')
      child.close(2)
    })
    await expect(listDshModels({ command: NODE, profile: 'multica' }, depsOf(h))).rejects.toThrow(
      /退出码 2[\s\S]*boom/,
    )
  })

  it('超时：抛错', async () => {
    const h = harness()
    await expect(
      listDshModels({ command: NODE, profile: 'multica' }, depsOf(h, { timeouts: { models: 5 } })),
    ).rejects.toThrow(`读取模型目录超时（5ms）`)
  })

  it('spawn 抛错：抛错', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('nope')
    }
    await expect(
      listDshModels({ command: NODE, profile: 'multica' }, { spawn, timeouts: { models: 5 } }),
    ).rejects.toThrow(/启动失败[\s\S]*nope/)
  })

  it('命令不存在：抛错', async () => {
    const h = harness()
    await expect(
      listDshModels({ command: 'missing-cmd-xyz', profile: 'multica' }, depsOf(h)),
    ).rejects.toThrow(/PATH/)
  })
})

describe('executeDshRun', () => {
  it('成功：写 execute 帧并按顺序发事件，汇总 usage/output/session', async () => {
    let tick = 0
    const h = harness()
    const events: RunEvent[] = []
    const controller = new AbortController()
    const running = executeDshRun(
      request({
        onEvent: (event) => events.push(event),
        runtime: runtime({
          model: 'magpie/workbuddy%2Fauto',
          reasoningEffort: 'high',
          workdir: 'C:/work',
        }),
        resumeSessionId: 'sess-prev',
        signal: controller.signal,
      }),
      depsOf(h, { now: () => (tick += 3), sessionRoot: 'C:/sessions' }),
    )
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
    expect((h.calls[0].options as { env: NodeJS.ProcessEnv }).env.DSH_PERMISSION_MODE).toBe(
      'workspace-write',
    )
    expect((h.calls[0].options as { env: NodeJS.ProcessEnv }).env.MULTICA_DSH_SESSION_ROOT).toBe(
      'C:/sessions',
    )

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

    const outcome = await running
    expect(outcome.status).toBe('succeeded')
    expect(outcome.output).toBe('你好')
    expect(outcome.errorCode).toBeNull()
    expect(outcome.exitCode).toBe(0)
    expect(outcome.sessionId).toBe('sess-1')
    expect(outcome.resumeRejected).toBe(false)
    expect(outcome.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    })
    expect(outcome.durationMs).toBeGreaterThan(0)
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
  })

  it('result 帧没有 output 时回退到 text 累计', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'text', content: 'abc' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed' }))
    child.close(0)
    expect((await running).output).toBe('abc')
  })

  it('result=failed：run_failed，错误取帧内 code/message', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
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
    const outcome = await running
    expect(outcome.status).toBe('failed')
    expect(outcome.errorCode).toBe('run_failed')
    expect(outcome.error).toBe('model_error: 额度不足')
  })

  it('result=failed 且无 error 文本：给兜底文案', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'failed' }))
    child.close(0)
    const outcome = await running
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('status=failed')
  })

  it('result=cancelled：cancelled', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'cancelled' }))
    child.close(0)
    const outcome = await running
    expect(outcome.status).toBe('cancelled')
    expect(outcome.errorCode).toBe('cancelled')
    expect(outcome.error).toBe('已取消')
  })

  it('result=timeout：timeout', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'timeout' }))
    child.close(0)
    expect((await running).status).toBe('timeout')
  })

  it('未知 result 状态：failed', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'weird' }))
    child.close(0)
    expect((await running).status).toBe('failed')
  })

  it('无 result + 非零退出：exit_nonzero，错误带 stderr 尾部', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStderr('fatal: bad config\n')
    child.close(7)
    const outcome = await running
    expect(outcome.status).toBe('failed')
    expect(outcome.errorCode).toBe('exit_nonzero')
    expect(outcome.error).toContain('退出码 7')
    expect(outcome.error).toContain('bad config')
  })

  it('无 result + 正常退出：no_result', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.close(0)
    const outcome = await running
    expect(outcome.errorCode).toBe('no_result')
    expect(outcome.error).toContain('终态结果')
  })

  it('未 ready 即退出：protocol_error', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    h.children[0].close(0)
    const outcome = await running
    expect(outcome.errorCode).toBe('protocol_error')
    expect(outcome.error).toContain('未就绪')
  })

  it('protocol_error 帧：protocol_error', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'protocol_error', code: 'bad', message: '帧坏了' }))
    child.close(0)
    const outcome = await running
    expect(outcome.errorCode).toBe('protocol_error')
    expect(outcome.error).toContain('bad: 帧坏了')
  })

  it('协议版本不符：protocol_error', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 2, type: 'ready', runtime: 'dsh' }))
    child.close(0)
    const outcome = await running
    expect(outcome.errorCode).toBe('protocol_error')
    expect(outcome.error).toContain('协议版本')
  })

  it('ready 帧 runtime 不是 dsh：protocol_error', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'other' }))
    child.close(0)
    expect((await running).errorCode).toBe('protocol_error')
  })

  it('忽略 request_id 不匹配、无效 JSON 与未知帧', async () => {
    const h = harness()
    const events: RunEvent[] = []
    const running = executeDshRun(request({ onEvent: (event) => events.push(event) }), depsOf(h))
    const child = h.children[0]
    child.emitStdout('not json\n')
    child.emitStdout(frame({ v: 1, type: 'text', request_id: 'other', content: 'x' }))
    child.emitStdout(frame({ v: 1, type: 'unknown', content: 'y' }))
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'ok' }))
    child.close(0)
    const outcome = await running
    expect(outcome.status).toBe('succeeded')
    expect(events).toEqual([])
  })

  it('订阅方抛错不影响执行', async () => {
    const h = harness()
    const running = executeDshRun(
      request({
        onEvent: () => {
          throw new Error('subscriber boom')
        },
      }),
      depsOf(h),
    )
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'text', content: 'x' }))
    child.emitStdout(frame({ v: 1, type: 'result', status: 'completed', output: 'x' }))
    child.close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('resume_rejected 透传给调用方', async () => {
    const h = harness()
    const running = executeDshRun(request({ resumeSessionId: 'dead-session' }), depsOf(h))
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
    const outcome = await running
    expect(outcome.resumeRejected).toBe(true)
    expect(outcome.sessionId).toBe('new-session')
  })

  it('取消：cancel 帧 → 宽限后 SIGTERM → SIGKILL，终态 cancelled', async () => {
    const h = harness()
    const events: RunEvent[] = []
    const controller = new AbortController()
    const running = executeDshRun(
      request({ signal: controller.signal, onEvent: (event) => events.push(event) }),
      depsOf(h, { grace: { cancel: 5, kill: 5 } }),
    )
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
    const outcome = await running
    expect(outcome.status).toBe('cancelled')
    expect(outcome.errorCode).toBe('cancelled')
  })

  it('超时：cancel 协议 + timeout 终态', async () => {
    const h = harness()
    const running = executeDshRun(
      request({ timeoutMs: 5 }),
      depsOf(h, { grace: { cancel: 5, kill: 5 } }),
    )
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    await new Promise((resolve) => setTimeout(resolve, 12))
    expect(child.frames().at(-1)).toMatchObject({ type: 'cancel' })
    child.close(null)
    const outcome = await running
    expect(outcome.status).toBe('timeout')
    expect(outcome.errorCode).toBe('timeout')
    expect(outcome.error).toContain('超时')
    expect(outcome.exitCode).toBeNull()
  })

  it('进程已关闭后不再杀进程树', async () => {
    const h = harness()
    const controller = new AbortController()
    const running = executeDshRun(
      request({ signal: controller.signal }),
      depsOf(h, { grace: { cancel: 5, kill: 5 } }),
    )
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
    const outcome = await executeDshRun(
      request({ runtime: runtime({ command: 'missing-cmd-xyz' }) }),
      depsOf(h),
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.errorCode).toBe('spawn_failed')
    expect(h.children).toHaveLength(0)
  })

  it('spawn 抛错：spawn_failed', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('EPERM')
    }
    const outcome = await executeDshRun(request(), { spawn })
    expect(outcome.errorCode).toBe('spawn_failed')
    expect(outcome.error).toContain('EPERM')
  })

  it('execute 帧写入失败：spawn_failed 并终止进程', async () => {
    const h = harness(undefined, (child) => {
      child.writeThrows = true
    })
    const outcome = await executeDshRun(request(), depsOf(h))
    expect(outcome.status).toBe('failed')
    expect(outcome.errorCode).toBe('spawn_failed')
    expect(outcome.error).toContain('execute 帧')
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: undefined }])
  })

  it('子进程没有 pid 时用 child.kill 兜底（取消 → SIGTERM → SIGKILL）', async () => {
    const h = harness(undefined, (child) => {
      child.pid = undefined
    })
    const controller = new AbortController()
    const running = executeDshRun(
      request({ signal: controller.signal }),
      depsOf(h, { grace: { cancel: 5, kill: 5 } }),
    )
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
    const outcome = await executeDshRun(request({ signal: controller.signal }), depsOf(h))
    expect(outcome.status).toBe('cancelled')
    expect(h.children).toHaveLength(0)
  })

  it('模型 id 非法：run_failed，不启动进程', async () => {
    const h = harness()
    const outcome = await executeDshRun(
      request({ runtime: runtime({ model: 'nomodel' }) }),
      depsOf(h),
    )
    expect(outcome.errorCode).toBe('run_failed')
    expect(outcome.error).toContain('provider/model')
    expect(h.children).toHaveLength(0)
  })

  it('子进程 error 事件：spawn_failed 并收尾', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    h.children[0].fail(new Error('EACCES'))
    const outcome = await running
    expect(outcome.errorCode).toBe('spawn_failed')
    expect(outcome.error).toContain('EACCES')
  })

  it('帧字段缺省：用空值兜底且不产生多余事件', async () => {
    const h = harness()
    const events: RunEvent[] = []
    const running = executeDshRun(request({ onEvent: (event) => events.push(event) }), depsOf(h))
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
    const outcome = await running
    expect(outcome.status).toBe('succeeded')
    expect(outcome.sessionId).toBeNull()
    expect(outcome.usage).toEqual({
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
    const probe = await probeDshRuntime(
      { command: NODE, profile: 'multica' },
      depsOf(h, { timeouts: { version: 5, probe: 5 } }),
    )
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
    const probe = await probeDshRuntime({ command: NODE, profile: 'multica' }, depsOf(h))
    expect(probe.error).toContain('探测退出码 null')
  })

  it('不注入 spawn 依赖时也能用默认实现并给出失败结论', async () => {
    const missing = 'missing-cmd-xyz'
    await expect(probeDshRuntime({ command: missing, profile: 'multica' })).resolves.toMatchObject({
      state: 'unavailable',
    })
    await expect(listDshModels({ command: missing, profile: 'multica' })).rejects.toThrow(/PATH/)
    const outcome = await executeDshRun(request({ runtime: runtime({ command: missing }) }))
    expect(outcome.errorCode).toBe('spawn_failed')
  })

  it('execute：error 之后再 close 只收口一次', async () => {
    const h = harness()
    const running = executeDshRun(request(), depsOf(h))
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.fail(new Error('pipe broken'))
    child.close(0)
    const outcome = await running
    expect(outcome.errorCode).toBe('spawn_failed')
  })

  it('execute：取消后立刻退出，宽限定时器发现已关闭就停手', async () => {
    const h = harness()
    const events: RunEvent[] = []
    const controller = new AbortController()
    const running = executeDshRun(
      request({ signal: controller.signal, onEvent: (event) => events.push(event) }),
      depsOf(h, { grace: { cancel: 5, kill: 5 } }),
    )
    const child = h.children[0]
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    controller.abort()
    child.close(0)
    const outcome = await running
    expect(outcome.status).toBe('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 16))
    expect(h.killedTrees).toEqual([])
  })

  it('execute：非对象 JSON、缺字段的 protocol_error/result、未知状态', async () => {
    const h = harness()
    const events: RunEvent[] = []
    const running = executeDshRun(request({ onEvent: (e) => events.push(e) }), depsOf(h))
    const child = h.children[0]
    child.emitStdout('null\n')
    child.emitStdout('[]\n')
    child.emitStdout(frame({ v: 1, type: 'ready', runtime: 'dsh' }))
    child.emitStdout(frame({ v: 1, type: 'protocol_error' }))
    child.emitStdout(frame({ v: 1, type: 'result' }))
    child.close(1)
    const outcome = await running
    // 最后一条 result 优先：状态缺省 → failed，错误兜底文案
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('status=')
    expect(events).toEqual([])
  })

  it('execute：写入失败且无 pid 时 child.kill 兜底', async () => {
    const h = harness(undefined, (child) => {
      child.pid = undefined
      child.writeThrows = true
    })
    const outcome = await executeDshRun(request(), depsOf(h))
    expect(outcome.errorCode).toBe('spawn_failed')
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
    const models = await listDshModels({ command: NODE, profile: 'multica' }, depsOf(h))
    expect(models[0].provider).toBe('')
    expect(models[0].label).toBe('nomodel')
    expect(models[1].label).toBe('a/b')
  })
})
