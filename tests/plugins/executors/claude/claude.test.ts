// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunEvent, Runtime } from '../../../../src/protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../../src/protocol/executor'
import type { ExecutorContext, SpawnFn, SpawnOptions, Spawned } from '../../../../src/sdk/types'
import {
  CLAUDE_PROTOCOL_VERSION,
  HELP_TIMEOUT_MS,
  KILL_GRACE_MS,
  OUTPUT_TAIL_LIMIT,
  RUN_TIMEOUT_MS,
  VERSION_TIMEOUT_MS,
} from '../../../../src/plugins/executors/claude/constants'
import { detectClaude } from '../../../../src/plugins/executors/claude/detect'
import { contentText, jsonText } from '../../../../src/plugins/executors/claude/frames'
import { claudePlugin } from '../../../../src/plugins/executors/claude/index'
import { claudeManifest } from '../../../../src/plugins/executors/claude/manifest'
import { probeClaudeRuntime } from '../../../../src/plugins/executors/claude/probe'
import { collect, errMsg } from '../../../../src/plugins/executors/claude/process'
import {
  claudeArgs,
  executeClaudeRun,
  mapResultSubtype,
  WORKSPACE_ALLOWED_TOOLS,
  type ClaudeOptions,
} from '../../../../src/plugins/executors/claude/run'
import { fakeSdk, type FakeSdkOverrides } from '../../support/fake-sdk'

/** 用 node 自身作为「存在的可执行文件」，避免依赖本机 claude */
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
  /** 写进 stdin 的原始文本（claude 只写提示词一次） */
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
  name: '本机 claude',
  executorKey: 'claude',
  argsTemplate: '',
  command: NODE,
  // Claude Code 没有 profile 概念：运行时行的这一列留空，插件不拼进 argv
  profile: '',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...over,
})

const turnOf = (over: Partial<Turn> = {}): Turn => ({
  runId: 'run-1',
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
  options?: ClaudeOptions
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
    running: executeClaudeRun(
      ctxOf(h, spec.runtime, spec.sdk),
      turnOf(spec.turn),
      io,
      spec.options,
    ),
    events,
  }
}

const frame = (value: Record<string, unknown>): string => JSON.stringify(value) + '\n'

const initFrame = (sessionId = 'sess-1', version = '2.1.318'): string =>
  frame({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    claude_code_version: version,
    cwd: 'C:/work',
    tools: ['Read', 'Bash'],
    permissionMode: 'default',
  })

describe('constants', () => {
  it('缺省超时、终止宽限与截尾口径', () => {
    expect(CLAUDE_PROTOCOL_VERSION).toBe(1)
    expect(VERSION_TIMEOUT_MS).toBe(15_000)
    expect(HELP_TIMEOUT_MS).toBe(15_000)
    expect(RUN_TIMEOUT_MS).toBe(30 * 60_000)
    expect(KILL_GRACE_MS).toBe(2_000)
    expect(OUTPUT_TAIL_LIMIT).toBe(4_000)
  })
})

describe('claudeArgs', () => {
  it('恒定参数 + 白名单 + 按需追加 model/effort/resume，每项都是独立元素', () => {
    expect(claudeArgs('workspace-write', null, null, null)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--allowed-tools',
      ...WORKSPACE_ALLOWED_TOOLS,
    ])
    const withModel = claudeArgs(
      'workspace-write',
      { provider: 'anthropic', id: 'claude-opus-4-1' },
      'xhigh',
      'sess-prev',
    )
    expect(withModel.slice(withModel.indexOf('--model'))).toEqual([
      '--model',
      'claude-opus-4-1',
      '--effort',
      'xhigh',
      '--resume',
      'sess-prev',
    ])
  })

  it('白名单只在 workspace-write 出现：只读与全权都不加（权限由模式本身收口）', () => {
    expect(claudeArgs('read-only', null, null, null)).not.toContain('--allowed-tools')
    expect(claudeArgs('danger-full-access', null, null, null)).not.toContain('--allowed-tools')
    // 白名单只覆盖只读查询 / 构建 / 测试，不含写入与网络命令
    expect(WORKSPACE_ALLOWED_TOOLS).toContain('Bash(pnpm:*)')
    expect(WORKSPACE_ALLOWED_TOOLS).toContain('Bash(python3:*)')
    expect(WORKSPACE_ALLOWED_TOOLS.some((tool) => /curl|wget|rm|mv|chmod/.test(tool))).toBe(false)
  })

  it('三种权限模式映射到 claude 的 --permission-mode 取值', () => {
    const flags = (['read-only', 'workspace-write', 'danger-full-access'] as const).map((mode) => {
      const args = claudeArgs(mode, null, null, null)
      return args[args.indexOf('--permission-mode') + 1]
    })
    expect(flags).toEqual(['plan', 'acceptEdits', 'bypassPermissions'])
  })
})

describe('mapResultSubtype', () => {
  it('success 且非 error 才算成功；is_error 与 error_* 归失败；cancel/abort 归取消', () => {
    expect(mapResultSubtype('success', false)).toBe('succeeded')
    expect(mapResultSubtype('SUCCESS', false)).toBe('succeeded')
    expect(mapResultSubtype('error_max_turns', true)).toBe('failed')
    expect(mapResultSubtype('error_max_budget_usd', true)).toBe('failed')
    expect(mapResultSubtype('error_during_execution', false)).toBe('failed')
    expect(mapResultSubtype('success', true)).toBe('failed')
    expect(mapResultSubtype('cancelled', false)).toBe('cancelled')
    expect(mapResultSubtype('error_aborted', true)).toBe('cancelled')
    expect(mapResultSubtype(undefined, false)).toBe('failed')
  })
})

describe('contentText', () => {
  it('兼容字符串、内容块数组与非法形状', () => {
    expect(contentText('plain')).toBe('plain')
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, 'raw'])).toBe(
      'a\n[image]\nraw',
    )
    expect(contentText(undefined)).toBe('')
    expect(contentText({ type: 'text', text: 'x' })).toBe('')
    // 既没有字符串 text、也没有字符串 type 的块：留空，不参与拼接
    expect(contentText([{ text: 123 }, { type: 7 }])).toBe('')
  })
})

describe('jsonText', () => {
  it('工具入参 → JSON 文本；不可序列化的值回落空串', () => {
    expect(jsonText({ file_path: 'a.ts' })).toBe('{"file_path":"a.ts"}')
    expect(jsonText(undefined)).toBe('')
    // 函数不是可序列化的值：JSON.stringify 返回 undefined，回落空串
    expect(jsonText(() => undefined)).toBe('')
    expect(jsonText(Symbol('x'))).toBe('')
  })
})

describe('errMsg', () => {
  it('Error 取 message，其它值按 String 归一', () => {
    expect(errMsg(new Error('boom'))).toBe('boom')
    expect(errMsg('plain string')).toBe('plain string')
    expect(errMsg(42)).toBe('42')
  })
})

describe('executeClaudeRun 成功路径', () => {
  it('init → assistant(text/thinking/tool_use) → user(tool_result) → result', async () => {
    const h = harness()
    const processCalls: number[] = []
    const sessionCalls: string[] = []
    const { running, events } = startRun(h, {
      // 执行配置来自智能体（宿主折进 Turn）：模型只取斜杠后那段、强度进 --effort
      turn: {
        model: { provider: 'anthropic', id: 'claude-opus-4-1' },
        effort: 'high',
        env: { HTTP_PROXY: 'http://127.0.0.1:7890' },
        resumeSessionId: 'sess-prev',
      },
      io: {
        process: (pid) => processCalls.push(pid),
        session: (id) => sessionCalls.push(id),
      },
    })
    const child = h.children[0]

    // argv：恒定的 print/stream-json/verbose、权限、以及 model 只取斜杠后那段
    expect(h.calls[0].command).toBe(NODE)
    expect(h.calls[0].args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--allowed-tools',
      ...WORKSPACE_ALLOWED_TOOLS,
      '--model',
      'claude-opus-4-1',
      '--effort',
      'high',
      '--resume',
      'sess-prev',
    ])
    expect(h.calls[0].options.cwd).toBe('C:/work')
    // 智能体配的环境变量原样进 spawn（宿主基线由 sdk 合并）
    expect(h.calls[0].options.env).toEqual({ HTTP_PROXY: 'http://127.0.0.1:7890' })
    // 提示词写 stdin 后立刻关闭（不占 argv）
    expect(child.writes).toEqual(['只回复 OK'])
    expect(child.stdinEnded).toBe(true)
    // 旁路通道：pid 立即上报
    expect(processCalls).toEqual([4242])

    child.emitStdout(frame({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' }))
    child.emitStdout(initFrame())
    child.emitStdout(
      frame({
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-opus-4-1',
          content: [
            { type: 'text', text: '你' },
            { type: 'thinking', thinking: '想一想' },
            { type: 'tool_use', id: 'toolu-1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    )
    child.emitStdout(
      frame({
        type: 'user',
        session_id: 'sess-1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-1',
              content: [{ type: 'text', text: '文件正文' }],
            },
          ],
        },
      }),
    )
    child.emitStdout(
      frame({ type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } }),
    )
    child.emitStdout(
      frame({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '你好',
        session_id: 'sess-1',
        duration_ms: 9149,
        total_cost_usd: 0.08,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {
          'claude-opus-4-1': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 4,
            thinkingTokens: 0,
            contextWindow: 1_000_000,
          },
          'claude-haiku-4-5': {
            inputTokens: 7,
            outputTokens: 3,
            cacheReadInputTokens: 1,
            cacheCreationInputTokens: 2,
          },
        },
      }),
    )
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe('你好')
    expect(receipt.errorCode).toBeUndefined()
    expect(receipt.error).toBeUndefined()
    expect(receipt.exitCode).toBe(0)
    expect(receipt.sessionId).toBe('sess-1')
    expect(receipt.resumeRejected).toBeUndefined()
    expect(receipt.leaseId).toBe('req-1')
    expect(receipt.turn).toBe(1)
    // modelUsage 各项求和优先（usage 里的 0 不采信）
    expect(receipt.usage).toEqual({
      inputTokens: 107,
      outputTokens: 23,
      cacheReadTokens: 11,
      cacheWriteTokens: 6,
    })
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0)

    // hook_started 是诊断帧：不发事件
    expect(events.map((event) => event.type)).toEqual([
      'status',
      'text',
      'thinking',
      'tool_call',
      'tool_result',
      'text',
    ])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events[0]).toMatchObject({ type: 'status', status: 'running' })
    expect(events[1]).toMatchObject({ type: 'text', text: '你' })
    expect(events[2]).toMatchObject({ type: 'thinking', text: '想一想' })
    expect(events[3]).toMatchObject({
      type: 'tool_call',
      tool: 'Read',
      callId: 'toolu-1',
      input: '{"file_path":"a.ts"}',
    })
    expect(events[4]).toMatchObject({
      type: 'tool_result',
      tool: 'Read',
      callId: 'toolu-1',
      output: '文件正文',
      isError: false,
    })
    // io.session 在拿到 session_id 时上报一次
    expect(sessionCalls).toEqual(['sess-1'])
  })

  it('result 没有 result 文本时回退到 text 累计；modelUsage 缺失回落 usage', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStdout(
      frame({ type: 'assistant', message: { content: [{ type: 'text', text: 'abc' }] } }),
    )
    child.emitStdout(
      frame({
        type: 'result',
        subtype: 'success',
        result: '',
        session_id: 'sess-1',
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 2,
        },
      }),
    )
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe('abc')
    expect(receipt.usage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    })
  })

  it('tool_use 没有 input 时 input 为空串', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStdout(
      frame({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'c9', name: 'Bash' }] },
      }),
    )
    child.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    child.close(0)

    await running
    expect(events[1]).toMatchObject({ type: 'tool_call', tool: 'Bash', callId: 'c9', input: '' })
  })

  it('tool_result 的 content 兼容字符串与内容块数组（含非文本块与非法项）', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStdout(
      frame({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'unknown', content: 'plain text' },
            {
              type: 'tool_result',
              tool_use_id: 'c2',
              content: [
                { type: 'image', source: { data: 'x' } },
                { type: 'text', text: 'ok' },
              ],
              is_error: true,
            },
            { type: 'tool_result', tool_use_id: 'c3', content: ['raw', 5] },
            // 既没有字符串 text、也没有字符串 type 的块：文本化结果为空串
            { type: 'tool_result', tool_use_id: 'c4', content: [{ text: 123 }, { type: 7 }] },
            { type: 'text', text: '不是工具结果' },
          ],
        },
      }),
    )
    child.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    child.close(0)

    await running
    expect(events.slice(1)).toEqual([
      {
        seq: 2,
        type: 'tool_result',
        tool: '',
        callId: 'unknown',
        output: 'plain text',
        isError: false,
      },
      { seq: 3, type: 'tool_result', tool: '', callId: 'c2', output: '[image]\nok', isError: true },
      { seq: 4, type: 'tool_result', tool: '', callId: 'c3', output: 'raw', isError: false },
      { seq: 5, type: 'tool_result', tool: '', callId: 'c4', output: '', isError: false },
    ])
  })

  it('init 缺 session_id / claude_code_version：不登记会话，成功终态不变', async () => {
    const h = harness()
    const sessionCalls: string[] = []
    const { running } = startRun(h, { io: { session: (id) => sessionCalls.push(id) } })
    const child = h.children[0]
    child.emitStdout(frame({ type: 'system', subtype: 'init' }))
    child.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe('ok')
    expect(receipt.sessionId).toBeUndefined()
    expect(sessionCalls).toEqual([])
  })

  it('cwd 取舍：turn.cwd 优先，为空时用宿主默认目录', async () => {
    const h1 = harness()
    const first = startRun(h1, { turn: { cwd: 'D:/proj' } })
    h1.children[0].close(0)
    await first.running
    expect(h1.calls[0].options.cwd).toBe('D:/proj')

    const h2 = harness()
    const second = startRun(h2, { turn: { cwd: '' }, sdk: { cwd: 'C:/host-default' } })
    h2.children[0].close(0)
    await second.running
    expect(h2.calls[0].options.cwd).toBe('C:/host-default')
    // 智能体没配环境变量：不追加任何键（宿主基线由 sdk 合并）
    expect(h2.calls[0].options.env).toEqual({})
  })

  it('访问权限由 Turn.access 还原：read → --permission-mode plan', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { access: 'read' } })
    const args = h.calls[0].args
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')

    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    child.close(0)
    expect((await running).status).toBe('succeeded')
  })
})

describe('executeClaudeRun 归档与失败', () => {
  it('宿主给 null 模型：不追加 --model，按 CLI 默认模型跑', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { model: null, effort: null } })
    const child = h.children[0]
    // 恒定参数里没有 --model / --effort
    expect(h.calls[0].args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--allowed-tools',
      ...WORKSPACE_ALLOWED_TOOLS,
    ])

    child.emitStdout(initFrame())
    child.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    child.close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('开始前已 abort：cancelled，不 spawn', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness()
    const { running } = startRun(h, { turn: { signal: controller.signal } })
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(receipt.error).toBe('已取消')
    expect(h.children).toHaveLength(0)
  })

  it('取消：SIGTERM → 宽限后 SIGKILL，终态 cancelled', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { kill: 5 } },
    })
    const child = h.children[0]
    child.emitStdout(initFrame())
    controller.abort()
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

  it('超时：SIGTERM → SIGKILL，回执折成 failed + errorCode=timeout', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { timeoutMs: 5 }, options: { grace: { kill: 5 } } })
    const child = h.children[0]
    child.emitStdout(initFrame())
    await new Promise((resolve) => setTimeout(resolve, 8))
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    await new Promise((resolve) => setTimeout(resolve, 8))
    expect(h.killedTrees).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ])
    child.close(null)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain('超时')
    expect(receipt.exitCode).toBeUndefined()
  })

  it('turn.timeoutMs=0 时用内部 options 的运行超时', async () => {
    const h = harness()
    const { running } = startRun(h, {
      turn: { timeoutMs: 0 },
      options: { timeouts: { run: 5 }, grace: { kill: 5 } },
    })
    h.children[0].emitStdout(initFrame())
    await new Promise((resolve) => setTimeout(resolve, 8))
    h.children[0].close(null)
    const receipt = await running
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain('运行超时（5ms）')
  })

  it('超时与取消撞在一起：第二次 terminate 重排 SIGKILL，被遗弃的旧定时器到点后不再补刀', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal, timeoutMs: 5 },
      options: { grace: { kill: 30 } },
    })
    const child = h.children[0]
    child.emitStdout(initFrame())
    // 第一次 terminate（取消）：SIGTERM + 定时器 K1
    controller.abort()
    // 5ms 后超时再 terminate 一次：SIGTERM + 定时器 K2（K1 的引用被覆盖、成为孤儿）
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.killedTrees.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGTERM'])
    // 进程在宽限内退出：finish 只清得掉 K2，K1 仍会到点
    child.close(null)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('timeout')
    // 等过 K1 的时点：进程已退，孤儿定时器被 closed 挡住，不再发 SIGKILL
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(h.killedTrees.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGTERM'])
  })

  it('turn.timeoutMs=0 且没有内部覆盖：用 RUN_TIMEOUT_MS 缺省，不误触发超时', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { timeoutMs: 0 } })
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(h.killedTrees).toEqual([])
  })

  it('取消时不给内部 grace：按 KILL_GRACE_MS 缺省排 SIGKILL，宽限内退出即撤掉', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, { turn: { signal: controller.signal } })
    const child = h.children[0]
    child.emitStdout(initFrame())
    controller.abort()
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    // 进程在宽限内退出：finish 清掉 SIGKILL 定时器，不再补刀
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
  })

  it('关闭收尾 flush 期间再 abort：terminate 看到 closed 直接返回', async () => {
    const h = harness()
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      io: {
        emit: (event) => {
          // 收尾阶段（closed 已置位）由订阅方触发 abort：终止流程必须空转
          if (event.type === 'text') controller.abort()
        },
      },
    })
    const child = h.children[0]
    child.emitStdout(initFrame())
    // 半行文本帧留在缓冲：close 时 lines.flush() 解析 → emit → 同步 abort
    child.emitStdout(
      frame({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }).slice(
        0,
        -1,
      ),
    )
    child.close(0)

    const receipt = await running
    // 没有 result 帧、也没有真的请求取消：按「进程结束但无终态」收口
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('no_result')
    // 已关闭的进程不再杀进程树
    expect(h.killedTrees).toEqual([])
  })

  it('拿不到 pid 时退化为 child.kill，且不登记 pid', async () => {
    const h = harness(undefined, (child) => {
      child.pid = undefined
    })
    const processCalls: number[] = []
    const controller = new AbortController()
    const { running } = startRun(h, {
      turn: { signal: controller.signal },
      options: { grace: { kill: 5 } },
      io: { process: (pid) => processCalls.push(pid) },
    })
    const child = h.children[0]
    child.emitStdout(initFrame())
    controller.abort()
    expect(child.killed).toEqual(['SIGTERM'])
    await new Promise((resolve) => setTimeout(resolve, 8))
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL'])
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(processCalls).toEqual([])
    expect(h.killedTrees).toEqual([])
  })

  it('命令解析不到：spawn_failed，不发事件', async () => {
    const h = harness()
    const { running, events } = startRun(h, { runtime: { command: 'missing-claude-xyz' } })
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(h.children).toHaveLength(0)
    expect(events).toEqual([])
  })

  it('宿主 resolve 返回空原因（path=null, error=null）：用插件兜底文案收口', async () => {
    const h = harness()
    const { running } = startRun(h, {
      sdk: { resolve: () => ({ path: null, error: null }) },
    })
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('找不到可执行文件')
    expect(h.children).toHaveLength(0)
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

  it('提示词写入失败：spawn_failed 并杀进程', async () => {
    const h = harness(undefined, (child) => {
      child.writeThrows = true
    })
    const { running } = startRun(h)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('提示词')
    expect(h.killedTrees).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })

  it('未收到 init 就退出：protocol_error', async () => {
    const h = harness()
    const { running } = startRun(h)
    h.children[0].close(0)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('protocol_error')
    expect(receipt.error).toContain('未收到 init')
  })

  it('无 result + 非零退出：exit_nonzero，错误带 stderr 与 CLI 版本', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStderr('fatal: bad config\n')
    child.close(7)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('exit_nonzero')
    expect(receipt.error).toContain('退出码 7')
    expect(receipt.error).toContain('claude 2.1.318')
    expect(receipt.error).toContain('bad config')
  })

  it('无 result + 正常退出：no_result（没有版本时不拼版本标签）', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ type: 'system', subtype: 'init', session_id: 'sess-1' }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('no_result')
    expect(receipt.error).toContain('终态结果')
    expect(receipt.error).not.toContain('claude ')
    expect(receipt.sessionId).toBe('sess-1')
  })

  it('超长 stderr 只留尾部', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStderr('HEAD' + 'x'.repeat(OUTPUT_TAIL_LIMIT + 100) + 'TAIL')
    child.close(1)
    const receipt = await running
    expect(receipt.error).not.toContain('HEAD')
    expect(receipt.error).toContain('TAIL')
  })

  it('子进程报错（spawn 成功后）：spawn_failed，错误带原因；随后 close 不再重复收尾', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStderr('killed: out of memory\n')
    child.fail(new Error('EPIPE'))
    // 报错已收尾，进程随后仍然退出：finish 幂等，回执不变
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('spawn_failed')
    expect(receipt.error).toContain('EPIPE')
    expect(receipt.error).toContain('out of memory')
    expect(receipt.sessionId).toBe('sess-1')
    expect(h.killedTrees).toEqual([])
  })

  it('缺字段帧：tool_use / tool_result / result 缺 id 与 subtype 时按空值归一', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout(frame({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }))
    child.emitStdout(frame({ type: 'user', message: { content: [{ type: 'tool_result' }] } }))
    child.emitStdout(frame({ type: 'result' }))
    child.close(0)
    const receipt = await running
    expect(events).toEqual([
      { seq: 1, type: 'tool_call', tool: '', callId: '', input: '' },
      { seq: 2, type: 'tool_result', tool: '', callId: '', output: '', isError: false },
    ])
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toContain('subtype=空')
    expect(receipt.sessionId).toBeUndefined()
    expect(receipt.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('result=error_max_turns：failed + run_failed', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStdout(frame({ type: 'result', subtype: 'error_max_turns', is_error: true }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('run_failed')
    expect(receipt.error).toContain('error_max_turns')
    expect(receipt.error).toContain('is_error=true')
  })

  it('result 的 subtype 含 cancel：cancelled', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStdout(frame({ type: 'result', subtype: 'error_aborted', is_error: true }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(receipt.error).toBe('已取消')
  })

  it('result 的 subtype 归一为 timeout：回执折成 failed + errorCode=timeout', async () => {
    const h = harness()
    const { running } = startRun(h)
    const child = h.children[0]
    child.emitStdout(initFrame())
    child.emitStdout(frame({ type: 'result', subtype: 'timed_out', is_error: false }))
    child.close(0)
    const receipt = await running
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('timeout')
    expect(receipt.error).toContain('timed_out')
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
    child.emitStdout(initFrame())
    child.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    child.close(0)
    expect((await running).status).toBe('succeeded')
  })

  it('未知帧、非 JSON 行、缺字段帧一律忽略，不影响成功终态', async () => {
    const h = harness()
    const { running, events } = startRun(h)
    const child = h.children[0]
    child.emitStdout('not json at all\n')
    child.emitStdout('[1,2,3]\n')
    child.emitStdout('\n')
    child.emitStdout(frame({ type: 'system', subtype: 'hook_response', hook_name: 'x' }))
    child.emitStdout(frame({ type: 'stream_event', event: { type: 'content_block_delta' } }))
    child.emitStdout(frame({ type: 'assistant' }))
    child.emitStdout(frame({ type: 'assistant', message: { content: 'not-array' } }))
    child.emitStdout(
      frame({
        type: 'assistant',
        message: { content: [{ type: 'redacted_thinking', data: 'x' }] },
      }),
    )
    child.emitStdout(
      frame({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }),
    )
    child.emitStdout(frame({ type: 'assistant', message: { content: [{ type: 'thinking' }] } }))
    child.emitStdout(frame({ type: 'user', message: { content: 'not-array' } }))
    child.emitStdout(initFrame())
    child.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    child.close(0)

    const receipt = await running
    expect(receipt.status).toBe('succeeded')
    expect(receipt.output).toBe('ok')
    // 只有 init 发的 status 事件；其余诊断帧与坏行不产生事件
    expect(events.map((event) => event.type)).toEqual(['status'])
  })
})

describe('executeClaudeRun 续接被拒', () => {
  it('带 resumeSessionId + 无 result 帧 + stderr 命中 → resumeRejected', async () => {
    const h = harness()
    const { running } = startRun(h, { turn: { resumeSessionId: 'dead-session' } })
    const child = h.children[0]
    child.emitStdout(initFrame('sess-new'))
    child.emitStderr('No conversation found with session ID: dead-session\n')
    child.close(1)
    const receipt = await running
    expect(receipt.resumeRejected).toBe(true)
    expect(receipt.status).toBe('failed')
    expect(receipt.errorCode).toBe('exit_nonzero')
    expect(receipt.sessionId).toBe('sess-new')
  })

  it('三种不满足条件的组合都不置 resumeRejected', async () => {
    // 有 resume、stderr 不命中
    const h1 = harness()
    const first = startRun(h1, { turn: { resumeSessionId: 'sess-prev' } })
    const c1 = h1.children[0]
    c1.emitStdout(initFrame())
    c1.emitStderr('boom\n')
    c1.close(1)
    expect((await first.running).resumeRejected).toBeUndefined()

    // 无 resume、stderr 命中
    const h2 = harness()
    const second = startRun(h2)
    const c2 = h2.children[0]
    c2.emitStdout(initFrame())
    c2.emitStderr('no conversation found\n')
    c2.close(1)
    expect((await second.running).resumeRejected).toBeUndefined()

    // 有 resume、stderr 命中，但拿到了 result 帧
    const h3 = harness()
    const third = startRun(h3, { turn: { resumeSessionId: 'sess-prev' } })
    const c3 = h3.children[0]
    c3.emitStdout(initFrame())
    c3.emitStderr('no conversation found\n')
    c3.emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    c3.close(0)
    expect((await third.running).resumeRejected).toBeUndefined()
  })
})

describe('collect', () => {
  it('命令解析不到：返回 spawnError 而不抛错', async () => {
    const collected = await collect(fakeSdk(), 'missing-claude-xyz', ['--help'], 5)
    expect(collected.spawnError?.message).toContain('PATH')
    expect(collected.timedOut).toBe(false)
    expect(collected.stdout).toBe('')
  })

  it('超时且拿不到 pid：退化为 child.kill(SIGKILL)', async () => {
    const h = harness(undefined, (child) => {
      child.pid = undefined
    })
    const collected = await collect(fakeSdk({ spawn: h.spawn }), NODE, ['--help'], 5)
    expect(collected.timedOut).toBe(true)
    expect(h.children[0].killed).toEqual(['SIGKILL'])
  })

  it('宿主 resolve 返回空原因：collect 用插件兜底文案构造 spawnError', async () => {
    const collected = await collect(
      fakeSdk({ resolve: () => ({ path: null, error: null }) }),
      NODE,
      ['--help'],
      5,
    )
    expect(collected.spawnError?.message).toContain('找不到可执行文件')
    expect(collected.code).toBeNull()
  })

  it('收尾幂等：close 事件来两次时第二次直接早退', async () => {
    const h = harness()
    const running = collect(fakeSdk({ spawn: h.spawn }), NODE, ['--version'], 5)
    const child = h.children[0]
    child.emitStdout('2.1.318\n')
    child.close(0)
    child.close(0)
    const collected = await running
    expect(collected.code).toBe(0)
    expect(collected.stdout.trim()).toBe('2.1.318')
  })
})

describe('probeClaudeRuntime', () => {
  it('命令解析不到：unavailable，path 为 null', async () => {
    const h = harness()
    const probe = await probeClaudeRuntime(ctxOf(h, { command: 'definitely-not-a-cmd-xyz' }))
    expect(probe.state).toBe('unavailable')
    expect(probe.path).toBeNull()
    expect(probe.error).toContain('PATH')
    expect(h.children).toHaveLength(0)
  })

  it('宿主 resolve 返回空原因（path=null, error=null）：unavailable 用插件兜底文案', async () => {
    const probe = await probeClaudeRuntime(
      ctxOf(harness(), {}, { resolve: () => ({ path: null, error: null }) }),
    )
    expect(probe.state).toBe('unavailable')
    expect(probe.path).toBeNull()
    expect(probe.error).toContain('找不到可执行文件')
    expect(probe.cliVersion).toBeNull()
  })

  it('就绪：--version 取 semver + --help 含 --print/--output-format', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('2.1.318 (Claude Code)\n')
        child.close(0)
        return
      }
      child.emitStdout('Usage: claude [options]\n  --print\n  --output-format <fmt>\n')
      child.emitStderr('warning: something\n')
      child.close(0)
    })
    const probe = await probeClaudeRuntime(ctxOf(h), { timeouts: { version: 5, help: 5 } })
    expect(probe.state).toBe('ready')
    expect(probe.path).toBe(NODE)
    expect(probe.cliVersion).toBe('2.1.318')
    expect(probe.protocolVersion).toBe(CLAUDE_PROTOCOL_VERSION)
    expect(probe.pluginVersion).toBe('1.0.0')
    expect(probe.error).toBeNull()
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(probe.output).toContain('warning')
    expect(h.calls.map((call) => call.args)).toEqual([['--version'], ['--help']])
  })

  it('--help 不含 --output-format：unavailable，原因点名缺的参数', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.emitStdout('2.1.318\n')
        child.close(0)
        return
      }
      child.emitStdout('Usage: claude --print only\n')
      child.close(0)
    })
    const probe = await probeClaudeRuntime(ctxOf(h))
    expect(probe.state).toBe('unavailable')
    expect(probe.cliVersion).toBe('2.1.318')
    expect(probe.protocolVersion).toBeNull()
    expect(probe.error).toContain('--output-format')
    expect(probe.path).toBe(NODE)
  })

  it('探测超时：unavailable 并杀掉自己起的进程', async () => {
    const h = harness()
    const probe = await probeClaudeRuntime(ctxOf(h), { timeouts: { version: 5, help: 5 } })
    expect(probe.state).toBe('unavailable')
    expect(probe.cliVersion).toBeNull()
    expect(probe.error).toContain('超时')
    expect(h.killedTrees).toHaveLength(2)
  })

  it('探测命令 spawn 抛错：unavailable 带原因', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('EPERM')
    }
    const probe = await probeClaudeRuntime(ctxOf(harness(), {}, { spawn }))
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('启动探测失败')
    expect(probe.error).toContain('EPERM')
  })

  it('版本读取失败不阻断探测（cliVersion 为 null）', async () => {
    const h = harness((args, child) => {
      if (args.includes('--version')) {
        child.fail(new Error('version crashed'))
        return
      }
      child.emitStdout('--print --output-format stream-json\n')
      child.close(0)
    })
    const probe = await probeClaudeRuntime(ctxOf(h))
    expect(probe.state).toBe('ready')
    expect(probe.cliVersion).toBeNull()
  })
})

describe('detectClaude', () => {
  it('命中：返回一条候选，executorKey/supported 留给注册表填', () => {
    const sdk = fakeSdk({
      scanDirs: () => ['C:/bin'],
      findInDirs: (command, dirs) =>
        command === 'claude' && dirs[0] === 'C:/bin' ? 'C:/bin/claude.cmd' : null,
    })
    expect(detectClaude({ sdk })).toEqual([
      {
        command: 'claude',
        label: 'Claude Code',
        path: 'C:/bin/claude.cmd',
        executorKey: '',
        supported: false,
      },
    ])
  })

  it('未命中：空数组', () => {
    expect(detectClaude({ sdk: fakeSdk() })).toEqual([])
  })
})

describe('manifest 与插件入口', () => {
  it('manifest：id/kind/name/capabilities 与表单默认值', () => {
    expect(claudeManifest.id).toBe('claude')
    expect(claudeManifest.kind).toBe('executor')
    expect(claudeManifest.name).toBe('Claude Code')
    expect(claudeManifest.capabilities).toEqual(['spawn'])
    const defaults = Object.fromEntries(
      (claudeManifest.config ?? []).map((field) => [field.key, field.default]),
    )
    expect(defaults).toEqual({
      command: 'claude',
      profile: '',
      permissionMode: 'workspace-write',
      model: undefined,
      reasoningEffort: undefined,
      workdir: undefined,
    })
  })

  it('插件入口：装配 detect/probe/run，models 不实现', () => {
    expect(typeof claudePlugin.detect).toBe('function')
    expect(typeof claudePlugin.probe).toBe('function')
    expect(typeof claudePlugin.run).toBe('function')
    expect(claudePlugin.models).toBeUndefined()
  })

  it('插件入口透传：detect / probe / run 都走同一份实现', async () => {
    const detect = claudePlugin.detect
    const probe = claudePlugin.probe
    const run = claudePlugin.run
    if (!detect || !probe) throw new Error('插件入口缺少 detect/probe')

    const sdk = fakeSdk({
      scanDirs: () => ['C:/bin'],
      findInDirs: () => 'C:/bin/claude.cmd',
    })
    expect(await detect({ sdk })).toEqual([
      {
        command: 'claude',
        label: 'Claude Code',
        path: 'C:/bin/claude.cmd',
        executorKey: '',
        supported: false,
      },
    ])

    const h = harness()
    const probed = await probe(ctxOf(h, { command: 'missing-claude-xyz' }))
    expect(probed.state).toBe('unavailable')

    const h2 = harness()
    const running = run(ctxOf(h2), turnOf(), { emit: () => undefined })
    h2.children[0].emitStdout(initFrame())
    h2.children[0].emitStdout(frame({ type: 'result', subtype: 'success', result: 'ok' }))
    h2.children[0].close(0)
    expect((await running).status).toBe('succeeded')
  })
})
