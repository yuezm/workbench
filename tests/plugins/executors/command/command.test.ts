// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent, Runtime } from '../../../../src/protocol/entities'
import type { ExecutorIO, Turn } from '../../../../src/protocol/executor'
import type {
  ExecutorContext,
  ResolvedExecutable,
  SpawnFn,
  SpawnOptions,
  Spawned,
} from '../../../../src/sdk/types'
import { commandManifest } from '../../../../src/plugins/executors/command/manifest'
import { commandPlugin } from '../../../../src/plugins/executors/command/index'
import {
  executeCommandRun,
  type CommandOptions,
} from '../../../../src/plugins/executors/command/run'
import { fakeSdk, type FakeSdkOverrides } from '../../support/fake-sdk'

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

/** 假子进程：由用例手动驱动 stdout/stderr/退出，不真 spawn */
class FakeChild implements Spawned {
  pid: number | undefined = 4242
  writes: string[] = []
  killed: string[] = []
  stdinEnded = false
  writeThrows = false
  endThrows = false
  private readonly outStream = new FakeStream()
  private readonly errStream = new FakeStream()
  readonly stdin = {
    write: (chunk: string): boolean => {
      if (this.writeThrows) throw new Error('stdin closed')
      this.writes.push(chunk)
      return true
    },
    end: (): void => {
      if (this.endThrows) throw new Error('stdin already ended')
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
  close(code: number | null = 0, signal: string | null = null): void {
    this.closeCb?.(code, signal)
  }
  fail(error: Error): void {
    this.errorCb?.(error)
  }
}

interface Harness {
  spawn: SpawnFn
  killTree: (pid: number, signal?: NodeJS.Signals) => boolean
  resolve: (command: string) => ResolvedExecutable
  children: FakeChild[]
  killedTrees: Array<{ pid: number; signal: string | undefined }>
  calls: Array<{ command: string; args: string[]; options: SpawnOptions }>
}

/** 假 spawn：每次调用返回一个可手动驱动的子进程；resolve 默认把命令解析成给定路径 */
function harness(
  resolvedPath = 'C:/tools/agent.exe',
  configure?: (child: FakeChild) => void,
): Harness {
  const children: FakeChild[] = []
  const killedTrees: Harness['killedTrees'] = []
  const calls: Harness['calls'] = []
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild()
    configure?.(child)
    children.push(child)
    calls.push({ command, args, options })
    return child
  }
  const killTree = (pid: number, signal?: NodeJS.Signals): boolean => {
    killedTrees.push({ pid, signal })
    return true
  }
  const resolve = (): ResolvedExecutable => ({ path: resolvedPath, error: null })
  return { spawn, killTree, resolve, children, killedTrees, calls }
}

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机命令',
  executorKey: 'command',
  command: 'agent',
  profile: '',
  argsTemplate: '',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...over,
})

const turnOf = (over: Partial<Turn> = {}): Turn => ({
  runId: 'run-1',
  leaseId: 'lease-1',
  turn: 2,
  purpose: 'stage',
  prompt: '只回复 OK',
  cwd: 'C:/work',
  access: 'edit',
  timeoutMs: 60_000,
  signal: new AbortController().signal,
  ...over,
})

const ctxOf = (
  h: Harness,
  runtimeOver: Partial<Runtime> = {},
  sdkOverrides: FakeSdkOverrides = {},
): ExecutorContext => ({
  runtime: runtime(runtimeOver),
  sdk: fakeSdk({
    spawn: h.spawn,
    killTree: h.killTree,
    resolve: h.resolve,
    ...sdkOverrides,
  }),
})

interface RunSpec {
  runtime?: Partial<Runtime>
  turn?: Partial<Turn>
  sdk?: FakeSdkOverrides
  options?: CommandOptions
  io?: Partial<ExecutorIO>
}

/** 起一轮执行：返回 promise 与事件收集数组 */
function startRun(
  h: Harness,
  spec: RunSpec = {},
): { running: Promise<Awaited<ReturnType<typeof executeCommandRun>>>; events: RunEvent[] } {
  const events: RunEvent[] = []
  const io: ExecutorIO = { emit: (event) => events.push(event), ...spec.io }
  return {
    running: executeCommandRun(
      ctxOf(h, spec.runtime, spec.sdk),
      turnOf(spec.turn),
      io,
      spec.options,
    ),
    events,
  }
}

const template = (items: string[]): string => JSON.stringify(items)

describe('command manifest 与插件装配', () => {
  it('manifest：id/kind/name/capabilities 与表单默认值（command/profile/argsTemplate 空串）', () => {
    expect(commandManifest.id).toBe('command')
    expect(commandManifest.kind).toBe('executor')
    expect(commandManifest.name).toBe('命令')
    expect(commandManifest.capabilities).toEqual(['spawn'])

    const config = commandManifest.config ?? []
    const defaults = Object.fromEntries(config.map((field) => [field.key, field.default]))
    expect(defaults).toEqual({ command: '', profile: '', argsTemplate: '' })
    expect(new Set(config.map((field) => field.key)).size).toBe(config.length)
    for (const field of config) {
      expect(field.label.length).toBeGreaterThan(0)
      expect(field.help?.length).toBeGreaterThan(0)
    }
  })

  it('插件只实现 run（D12：不给 detect/probe）', () => {
    expect(commandPlugin.run).toBeTypeOf('function')
    expect(commandPlugin.probe).toBeUndefined()
    expect(commandPlugin.detect).toBeUndefined()
  })
})

describe('executeCommandRun 成功路径', () => {
  it('模板含 {prompt}：提示词是独立 argv 元素，不进任何拼接字符串、不写 stdin', async () => {
    const h = harness()
    const prompt = '把 "a b" && rm -rf / 写进文件'
    const events: RunEvent[] = []
    const processCalls: number[] = []
    let tick = 0
    const running = commandPlugin.run(
      ctxOf(h, { argsTemplate: template(['--print', '{prompt}']) }, { now: () => (tick += 4) }),
      turnOf({ prompt }),
      { emit: (event) => events.push(event), process: (pid) => processCalls.push(pid) },
    )

    const child = h.children[0]
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]
    expect(call.command).toBe('C:/tools/agent.exe')
    expect(call.args).toEqual(['--print', prompt])
    expect(call.options).toEqual({ cwd: 'C:/work', env: {}, shell: false })
    // prompt 只以第二个 argv 元素出现一次：命令与其它参数都不含它
    expect(call.args.filter((arg) => arg.includes(prompt))).toEqual([prompt])
    expect(call.args[0]).not.toContain(prompt)
    expect(call.command).not.toContain(prompt)
    expect(child.writes).toEqual([])

    child.emitStdout('done')
    child.close(0)
    const receipt = await running
    expect(receipt).toMatchObject({
      status: 'succeeded',
      leaseId: 'lease-1',
      turn: 2,
      output: 'done',
      exitCode: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    expect(receipt.error).toBeUndefined()
    expect(receipt.errorCode).toBeUndefined()
    expect(receipt.durationMs).toBe(4)
    expect(events).toEqual([{ seq: 1, type: 'text', text: 'done' }])
    expect(processCalls).toEqual([4242])
    expect(child.stdinEnded).toBe(true)
  })

  it('模板无 {prompt}：提示词写 stdin 且不进 argv', async () => {
    const h = harness()
    const { running } = startRun(h, {
      runtime: { argsTemplate: template(['--batch']) },
      turn: { prompt: '只回复 OK' },
    })
    const child = h.children[0]
    expect(h.calls[0].args).toEqual(['--batch'])
    expect(h.calls[0].args.join(' ')).not.toContain('只回复 OK')
    expect(child.writes).toEqual(['只回复 OK'])
    expect(child.stdinEnded).toBe(true)

    child.close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('{model}/{effort}/{cwd}/{context} 逐项替换，仍是独立元素', async () => {
    const h = harness()
    const { running } = startRun(h, {
      runtime: {
        argsTemplate: template([
          '--model',
          '{model}',
          '--effort={effort}',
          '--dir',
          '{cwd}',
          '--context',
          '{context}',
        ]),
        model: 'magpie/auto',
        reasoningEffort: 'high',
        workdir: 'D:/repo',
      },
      turn: { contextFile: 'C:/refs/brief.md' },
    })

    expect(h.calls[0].args).toEqual([
      '--model',
      'magpie/auto',
      '--effort=high',
      '--dir',
      'D:/repo',
      '--context',
      'C:/refs/brief.md',
    ])
    expect(h.calls[0].options.cwd).toBe('D:/repo')

    h.children[0].close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('变量缺失折成空串；turn.cwd 为空串时回落到宿主默认目录', async () => {
    const h = harness()
    const { running } = startRun(h, {
      runtime: { argsTemplate: template(['{model}', '{effort}', '{cwd}', '{context}']) },
      turn: { cwd: '' },
      sdk: { cwd: 'D:/default' },
    })

    expect(h.calls[0].args).toEqual(['', '', 'D:/default', ''])
    expect(h.calls[0].options.cwd).toBe('D:/default')

    h.children[0].close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('Windows .cmd（大小写不敏感）经 cmd.exe /c 固定包装，提示词走 stdin', async () => {
    const h = harness('C:\\Program Files\\nodejs\\agent-tool.CMD')
    const { running } = startRun(h, {
      runtime: { argsTemplate: template(['run']) },
      turn: { prompt: '只回复 OK' },
    })

    expect(h.calls[0].command).toBe('cmd.exe')
    expect(h.calls[0].args).toEqual(['/c', 'C:\\Program Files\\nodejs\\agent-tool.CMD', 'run'])
    expect(h.calls[0].options).toEqual({ cwd: 'C:/work', env: {}, shell: false })
    expect(h.children[0].writes).toEqual(['只回复 OK'])

    h.children[0].close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('Windows .cmd/.bat 禁止 {prompt}：直接失败且不 spawn（BatBadBut 防护）', async () => {
    for (const resolvedPath of [
      'C:\\Program Files\\nodejs\\agent-tool.CMD',
      'C:\\tools\\agent.bat',
    ]) {
      const h = harness(resolvedPath)
      const { running } = startRun(h, {
        runtime: { argsTemplate: template(['--print', '{prompt}']) },
        turn: { prompt: 'hi & calc' },
      })

      const receipt = await running
      expect(receipt.status).toBe('failed')
      expect(receipt.errorCode).toBe('run_failed')
      expect(receipt.error).toContain('.cmd/.bat')
      expect(h.calls).toEqual([])
    }
  })

  it('非 Windows 路径的 .cmd 不包装（直接 spawn 解析结果）', async () => {
    const h = harness('/usr/local/bin/agent.CMD')
    const { running } = startRun(h, { runtime: { argsTemplate: template(['run']) } })

    expect(h.calls[0].command).toBe('/usr/local/bin/agent.CMD')
    expect(h.calls[0].args).toEqual(['run'])
    expect(h.calls[0].options.shell).toBe(false)

    h.children[0].close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('订阅方 emit 抛错不打断执行', async () => {
    const h = harness()
    const running = executeCommandRun(ctxOf(h, { argsTemplate: template(['x']) }), turnOf(), {
      emit: () => {
        throw new Error('subscriber boom')
      },
    })

    h.children[0].emitStdout('out')
    h.children[0].close(0)
    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe('out')
  })

  it('pid 旁路通道抛错不影响执行', async () => {
    const h = harness()
    const running = executeCommandRun(ctxOf(h, { argsTemplate: template(['x']) }), turnOf(), {
      emit: () => undefined,
      process: () => {
        throw new Error('registry boom')
      },
    })

    h.children[0].close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('收尾关闭 stdin 抛错不影响回执', async () => {
    const h = harness('C:/tools/agent.exe', (child) => {
      child.endThrows = true
    })
    const { running } = startRun(h, { runtime: { argsTemplate: template(['{prompt}']) } })

    h.children[0].close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('启动前已取消：cancelled，不 spawn', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    const { running } = startRun(h, { turn: { signal: controller.signal } })

    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(receipt.error).toBe('已取消')
    expect(h.calls).toEqual([])
  })
})

describe('executeCommandRun 失败归一', () => {
  it('解析不到可执行文件：failed + spawn_failed，取 resolve 的错误文案', async () => {
    const h = harness()
    const { running } = startRun(h, {
      sdk: {
        resolve: () => ({ path: null, error: '在 PATH 中找不到命令：agent' }),
      },
    })

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('在 PATH 中找不到命令：agent')
    expect(h.calls).toEqual([])
  })

  it('resolve 没给错误文案时用兜底文案', async () => {
    const h = harness()
    const { running } = startRun(h, { sdk: { resolve: () => ({ path: null, error: null }) } })

    const receipt = await running
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('找不到可执行文件：agent')
  })

  it('spawn 抛非 Error：错误文案按 String 归一', async () => {
    const h = harness()
    const throwing: SpawnFn = () => {
      throw 'EACCES-literal'
    }
    const { running } = startRun(h, { sdk: { spawn: throwing } })

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('启动失败：EACCES-literal')
    expect(h.calls).toEqual([])
  })

  it('模板非法 JSON：failed + run_failed，不 spawn', async () => {
    const h = harness()
    const { running } = startRun(h, { runtime: { argsTemplate: '--print hi' } })

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toContain('argsTemplate 不是合法的 JSON 文本')
    expect(h.calls).toEqual([])
  })

  it('非零退出：failed + exit_nonzero，stderr 截尾进 error', async () => {
    const h = harness()
    const { running } = startRun(h, { runtime: { argsTemplate: template([]) } })
    const child = h.children[0]
    child.emitStdout('partial')
    child.emitStderr('boom\n')
    child.close(3)

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('exit_nonzero')
    expect(receipt.exitCode).toBe(3)
    expect(receipt.output).toBe('partial')
    expect(receipt.error).toContain('退出码 3')
    expect(receipt.error).toContain('[command stderr]')
    expect(receipt.error).toContain('boom')
  })

  it('stderr 超过 4000 字符时只保留尾部', async () => {
    const h = harness()
    const { running } = startRun(h, {})
    const child = h.children[0]
    child.emitStderr('A'.repeat(5_000))
    child.close(1)

    const receipt = await running
    expect(receipt.errorCode).toBe('exit_nonzero')
    expect(receipt.error).toContain('…')
    expect(receipt.error?.length).toBeLessThan(5_000)
  })

  it('子进程流错误：failed + spawn_failed', async () => {
    const h = harness()
    const { running } = startRun(h, {})
    h.children[0].fail(new Error('EPIPE'))

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('EPIPE')
    expect(receipt.exitCode).toBeUndefined()

    // 关闭回调晚到：已归一，不再二次结算
    h.children[0].close(0)
  })

  it('写 stdin 抛错：failed + spawn_failed，并终止子进程', async () => {
    const h = harness('C:/tools/agent.exe', (child) => {
      child.writeThrows = true
    })
    const { running } = startRun(h, { runtime: { argsTemplate: template(['--batch']) } })

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('写入 stdin 失败：stdin closed')
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: undefined }])
  })

  it('没有退出码且非超时/取消：failed + run_failed（带 signal）', async () => {
    const h = harness()
    const first = startRun(h, {})
    h.children[0].close(null, 'SIGTERM')
    const receipt = await first.running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toContain('signal=SIGTERM')
    expect(receipt.exitCode).toBeUndefined()

    const h2 = harness()
    const second = startRun(h2, {})
    h2.children[0].close(null, null)
    const receipt2 = await second.running
    expect(receipt2.errorCode).toBe('run_failed')
    expect(receipt2.error).toContain('进程异常结束')
    expect(receipt2.error).not.toContain('signal=')
  })
})

describe('取消/超时终止的定时器收尾（假定时器）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('超时：killTree 后按超时归一，收尾清掉定时器与 abort 监听', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, { turn: { signal: controller.signal, timeoutMs: 50 } })
    const child = h.children[0]

    vi.advanceTimersByTime(50)
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: undefined }])
    child.close(null)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain('50ms')
    expect(receipt.exitCode).toBeUndefined()

    // 定时器已清理：继续推进不再杀进程树
    vi.advanceTimersByTime(60 * 60_000)
    expect(h.killedTrees).toHaveLength(1)
    // abort 监听已移除：完成后再取消不触发终止
    controller.abort()
    expect(h.killedTrees).toHaveLength(1)
  })

  it('取消：abort → killTree，按取消归一', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, { turn: { signal: controller.signal, timeoutMs: 50 } })
    const child = h.children[0]

    controller.abort()
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: undefined }])
    child.close(null)
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(receipt.error).toBe('已取消')

    controller.abort()
    expect(h.killedTrees).toHaveLength(1)
  })

  it('turn.timeoutMs 为 0 时用 options.defaultTimeoutMs 兜底', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { timeoutMs: 0 }, options: { defaultTimeoutMs: 10 } })

    vi.advanceTimersByTime(10)
    expect(h.killedTrees).toHaveLength(1)
    h.children[0].close(null)
    expect((await running).errorCode).toBe('timeout')
  })

  it('turn.timeoutMs 为 0 且无 options 时用默认超时，正常退出后定时器清理', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { timeoutMs: 0 } })
    h.children[0].close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    vi.advanceTimersByTime(31 * 60_000)
    expect(h.killedTrees).toEqual([])
  })

  it('拿不到 pid 时退化为 child.kill(SIGKILL)，不调 io.process', async () => {
    const h = harness('C:/tools/agent.exe', (child) => {
      child.pid = undefined
    })
    const processCalls: number[] = []
    const { running } = startRun(h, {
      turn: { timeoutMs: 20 },
      io: { process: (pid) => processCalls.push(pid) },
    })

    vi.advanceTimersByTime(20)
    expect(h.children[0].killed).toEqual(['SIGKILL'])
    expect(processCalls).toEqual([])
    h.children[0].close(null)
    expect((await running).errorCode).toBe('timeout')
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

  it('stdout 里的回执块：Receipt 五字段齐全，output 原文不变', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    const output = outputWith(fullBlock)
    child.emitStdout(output)
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

  it('回执块解析失败：五字段缺失，终态 / 错误 / output 不变', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    const output = outputWith({ notices: 'not-array' })
    child.emitStdout(output)
    child.emitStderr('warn: something\n')
    child.close(3)

    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('exit_nonzero')
    expect(receipt.error).toContain('退出码 3')
    expect(receipt.output).toBe(output)
    expect(receipt.ask).toBeUndefined()
    expect(receipt.notices).toBeUndefined()
    expect(receipt.resolves).toBeUndefined()
    expect(receipt.later).toBeUndefined()
    expect(receipt.events).toBeUndefined()
  })
})

describe('cwd 兜底（宿主未提供默认目录）', () => {
  it('sdk.paths.cwd 缺失且 turn.cwd 为空：cwd 按空串兜底，不把 undefined 拼进模板', async () => {
    const h = harness()
    const base = fakeSdk({ spawn: h.spawn, killTree: h.killTree, resolve: h.resolve })
    const ctx: ExecutorContext = {
      runtime: runtime({ argsTemplate: template(['{cwd}']) }),
      sdk: { ...base, paths: { sessionRoot: null, cwd: undefined as unknown as string } },
    }

    const running = executeCommandRun(ctx, turnOf({ cwd: '' }), { emit: () => undefined })

    expect(h.calls[0].args).toEqual([''])
    expect(h.calls[0].options.cwd).toBeUndefined()

    h.children[0].close(0)
    expect((await running).status).toBe('succeeded')
  })
})
