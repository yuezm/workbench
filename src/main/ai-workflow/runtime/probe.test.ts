// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../../../shared/ai-workflow-api'
import type { RunInput, RuntimeAdapter } from './deepseek-harness'
import { PROBE_OUTPUT_LIMIT, PROBE_PROMPT, PROBE_TIMEOUT_MS, probeRuntime } from './probe'

type RunResult = { code: number; output: string }

function rt(over: Partial<Runtime> = {}): Runtime {
  return {
    id: 'r1',
    name: 'ds',
    kind: 'deepseek-harness',
    command: 'dsh',
    args: ['-p'],
    promptMode: 'arg',
    workdir: null,
    createdAt: 't',
    ...over,
  }
}

/** 用固定行为造一个假适配器，避免测试真起进程 */
function fakeAdapter(run: (input: RunInput) => Promise<RunResult>): RuntimeAdapter {
  return { run }
}

afterEach(() => {
  // 万一个别用例开了假定时器，不遗留到下一个用例
  vi.useRealTimers()
})

describe('probeRuntime', () => {
  it('成功：真实跑一次探测提示词，返回耗时、输出与 code 0', async () => {
    let seen: RunInput | undefined
    const adapterFor = (): RuntimeAdapter =>
      fakeAdapter(async (input) => {
        seen = input
        input.onOutput('部分')
        input.onOutput('OK')
        return { code: 0, output: '部分OK' }
      })
    const now = vi.fn<() => number>().mockReturnValueOnce(1000).mockReturnValueOnce(1042)

    const res = await probeRuntime(rt(), { adapterFor, now })

    expect(res).toEqual({ ok: true, code: 0, elapsedMs: 42, output: '部分OK', error: null })
    expect(seen?.prompt).toBe(PROBE_PROMPT)
    // workdir 为空时回落到进程当前目录
    expect(seen?.workdir).toBe(process.cwd())
  })

  it('非零退出：保留真实退出码与输出，error 说明退出码', async () => {
    let seen: RunInput | undefined
    const adapterFor = (): RuntimeAdapter =>
      fakeAdapter(async (input) => {
        seen = input
        return { code: 3, output: 'boom' }
      })

    const res = await probeRuntime(rt({ workdir: 'D:/work' }), { adapterFor, now: () => 0 })

    expect(res).toEqual({
      ok: false,
      code: 3,
      elapsedMs: 0,
      output: 'boom',
      error: '退出码 3',
    })
    // 配置了工作目录就用配置的
    expect(seen?.workdir).toBe('D:/work')
  })

  it('超时：到点 abort，且适配器随后 reject 也按超时上报', async () => {
    vi.useFakeTimers()
    const now = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(1000)
    let aborted = false
    const adapterFor = (): RuntimeAdapter =>
      fakeAdapter(
        (input) =>
          new Promise<RunResult>((_, reject) => {
            input.onOutput('卡住了')
            input.signal.addEventListener('abort', () => {
              aborted = true
              reject(new Error('aborted'))
            })
          }),
      )

    const pending = probeRuntime(rt(), { adapterFor, now, timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    const res = await pending

    expect(aborted).toBe(true)
    expect(res).toEqual({
      ok: false,
      code: null,
      elapsedMs: 1000,
      output: '卡住了',
      error: '测试超时（1000ms）',
    })
    // 超时后不留定时器
    expect(vi.getTimerCount()).toBe(0)
  })

  it('默认超时与超时后不残留定时器', async () => {
    vi.useFakeTimers()
    const adapterFor = (): RuntimeAdapter => fakeAdapter(() => new Promise<RunResult>(() => {}))

    const pending = probeRuntime(rt(), { adapterFor, now: () => 0 })
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    const res = await pending

    expect(res.ok).toBe(false)
    expect(res.code).toBeNull()
    expect(res.error).toBe(`测试超时（${PROBE_TIMEOUT_MS}ms）`)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('适配器 reject：报启动失败，code 为 null', async () => {
    const adapterFor = (): RuntimeAdapter =>
      fakeAdapter(async () => {
        throw new Error('spawn ENOENT')
      })

    const res = await probeRuntime(rt(), { adapterFor })

    expect(res.ok).toBe(false)
    expect(res.code).toBeNull()
    expect(res.error).toBe('spawn ENOENT')
    // 未注入 now 时用真实时钟
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(res.output).toBe('')
  })

  it('适配器生成器同步抛错或抛非 Error 值也不向外抛', async () => {
    const throwing = await probeRuntime(rt(), {
      adapterFor: () => {
        throw new Error('命令不存在')
      },
    })
    expect(throwing.error).toBe('命令不存在')
    expect(throwing.code).toBeNull()

    const rawThrow = await probeRuntime(rt(), {
      adapterFor: () =>
        fakeAdapter(async () => {
          throw 'raw-failure'
        }),
    })
    expect(rawThrow.error).toBe('raw-failure')
  })

  it('成功与失败后都不残留定时器', async () => {
    vi.useFakeTimers()

    const ok = await probeRuntime(rt(), {
      adapterFor: () => fakeAdapter(async () => ({ code: 0, output: 'OK' })),
      timeoutMs: 5000,
    })
    expect(ok.ok).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    const failed = await probeRuntime(rt(), {
      adapterFor: () =>
        fakeAdapter(async () => {
          throw new Error('boom')
        }),
      timeoutMs: 5000,
    })
    expect(failed.ok).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('输出超过上限时截断并加省略号，不超限时原样返回', async () => {
    const long = 'abcdefghijTAIL'
    const truncated = await probeRuntime(rt(), {
      adapterFor: () => fakeAdapter(async () => ({ code: 0, output: long })),
      outputLimit: 5,
    })
    expect(truncated.output).toBe('…jTAIL')

    const kept = await probeRuntime(rt(), {
      adapterFor: () => fakeAdapter(async () => ({ code: 0, output: long })),
      outputLimit: long.length,
    })
    expect(kept.output).toBe(long)
  })

  it('默认输出上限为 2000 字符', async () => {
    const long = 'x'.repeat(PROBE_OUTPUT_LIMIT + 10)
    const res = await probeRuntime(rt(), {
      adapterFor: () => fakeAdapter(async () => ({ code: 0, output: long })),
    })

    expect(res.output).toHaveLength(PROBE_OUTPUT_LIMIT + 1)
    expect(res.output.startsWith('…')).toBe(true)
  })

  it('默认 adapterFor 真实 spawn 本机 node（快速、不联网）', async () => {
    // Windows 下适配器经 cmd shell 启动，双引号会被 cmd 吃掉，故用反引号字符串
    const res = await probeRuntime(
      rt({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(`OK`)'],
        promptMode: 'arg',
      }),
    )

    expect(res.ok).toBe(true)
    expect(res.code).toBe(0)
    expect(res.error).toBeNull()
    expect(res.output).toContain('OK')
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
