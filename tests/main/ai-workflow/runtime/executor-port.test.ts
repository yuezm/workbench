// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createRuntimeExecutors } from '../../../../src/main/ai-workflow/executor-port'
import type { Runtime } from '../../../../src/protocol/entities'
import type { RunEvent } from '../../../../src/protocol/entities'
import type { Turn } from '../../../../src/protocol/executor'

/** 用真实 node 可执行文件路径，保证 `resolveExecutable` 命中（后续 spawn 被注入的桩接管）。 */
const runtime = (patch: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: process.execPath,
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...patch,
})

const turn = (): Turn => ({
  runId: 'run-1',
  leaseId: 'run-1:1',
  turn: 1,
  purpose: 'stage',
  prompt: '做点什么',
  cwd: 'C:/work',
  access: 'edit',
  timeoutMs: 30_000,
  signal: new AbortController().signal,
})

/** 启动即失败的后端依赖：不真的 spawn 进程。 */
const failingSpawn = (): never => {
  throw new Error('spawn 被测试拦截')
}

describe('createRuntimeExecutors', () => {
  it('forRuntime：端口按运行时绑定，spawn 失败归一为 failed/spawn_failed', async () => {
    const executors = createRuntimeExecutors({ spawn: failingSpawn })
    const port = executors.forRuntime(runtime())
    const events: RunEvent[] = []

    const receipt = await port.run(turn(), { emit: (event) => events.push(event) })

    expect(receipt).toMatchObject({
      status: 'failed',
      errorCode: 'spawn_failed',
      leaseId: 'run-1:1',
      turn: 1,
    })
    expect(events).toEqual([])
  })

  it('probe：经 dsh 后端探测，启动失败归为 unavailable', async () => {
    const executors = createRuntimeExecutors({
      spawn: failingSpawn,
      timeouts: { probe: 10, version: 10 },
    })

    const probe = await executors.forRuntime(runtime()).probe?.(runtime())

    expect(probe?.state).toBe('unavailable')
    expect(probe?.error).toContain('启动探测失败')
  })

  it('models：经 dsh 后端读取模型目录，启动失败抛出可读错误', async () => {
    const executors = createRuntimeExecutors({
      spawn: failingSpawn,
      timeouts: { models: 10 },
    })

    await expect(executors.forRuntime(runtime()).models?.(runtime())).rejects.toThrow(/启动失败/)
  })

  it('同一协议族复用后端实现，端口按每次运行时配置重新装配', () => {
    const executors = createRuntimeExecutors({ spawn: failingSpawn })

    const first = executors.forRuntime(runtime())
    const second = executors.forRuntime(runtime({ id: 'rt-2', command: process.execPath }))

    expect(first).not.toBe(second)
    expect(typeof first.run).toBe('function')
    expect(typeof first.probe).toBe('function')
    expect(typeof first.models).toBe('function')
  })
})
