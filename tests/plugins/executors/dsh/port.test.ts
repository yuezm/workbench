// @vitest-environment node
/**
 * 执行器端口等价覆盖（原 `tests/main/ai-workflow/runtime/executor-port.test.ts`）：
 * 插件直接实现 `ExecutorPlugin`，宿主包装层只剩续接重试与文案兜底；这里直接测插件
 * 三条能力（probe/models/run）的等价行为，不再经 `createRuntimeExecutors`。
 */
import { describe, expect, it } from 'vitest'
import type { RunEvent, Runtime } from '../../../../src/protocol/entities'
import type { Turn } from '../../../../src/protocol/executor'
import { dshPlugin } from '../../../../src/plugins/executors/dsh'
import type { ExecutorContext, SpawnFn } from '../../../../src/sdk/types'
import { fakeSdk } from '../../support/fake-sdk'

/** 用真实 node 可执行文件路径，保证 sdk.resolve 命中（spawn 被注入的桩接管）。 */
const runtime = (patch: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: process.execPath,
  profile: 'multica',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...patch,
})

const turn = (patch: Partial<Turn> = {}): Turn => ({
  runId: 'run-1',
  leaseId: 'run-1:1',
  turn: 1,
  purpose: 'stage',
  prompt: '做点什么',
  cwd: 'C:/work',
  access: 'edit',
  timeoutMs: 30_000,
  signal: new AbortController().signal,
  ...patch,
})

/** 启动即失败的后端依赖：不真的 spawn 进程。 */
const failingSpawn: SpawnFn = () => {
  throw new Error('spawn 被测试拦截')
}

const ctxOf = (patch: Partial<Runtime> = {}): ExecutorContext => ({
  runtime: runtime(patch),
  sdk: fakeSdk({ spawn: failingSpawn }),
})

describe('dshPlugin 端口能力', () => {
  it('run：spawn 失败归一为 failed/spawn_failed，回执带 leaseId/turn 且零事件', async () => {
    const events: RunEvent[] = []

    const receipt = await dshPlugin.run(ctxOf(), turn(), { emit: (event) => events.push(event) })

    expect(receipt).toMatchObject({
      status: 'failed',
      errorCode: 'spawn_failed',
      leaseId: 'run-1:1',
      turn: 1,
    })
    expect(events).toEqual([])
  })

  it('probe：经 dsh 插件探测，启动失败归为 unavailable', async () => {
    const probe = await dshPlugin.probe?.(ctxOf())

    expect(probe?.state).toBe('unavailable')
    expect(probe?.error).toContain('启动探测失败')
  })

  it('models：经 dsh 插件读取模型目录，启动失败抛出可读错误', async () => {
    await expect(dshPlugin.models?.(ctxOf())).rejects.toThrow(/启动失败/)
  })

  it('插件对象无状态：同一实例可连续服务多个运行时，回执各带自己的租约', async () => {
    const first = ctxOf({ id: 'rt-1' })
    const second = ctxOf({ id: 'rt-2', command: process.execPath })

    const firstReceipt = await dshPlugin.run(first, turn({ leaseId: 'run-1:1' }), {
      emit: () => undefined,
    })
    const secondReceipt = await dshPlugin.run(
      second,
      turn({ runId: 'run-2', leaseId: 'run-2:1' }),
      {
        emit: () => undefined,
      },
    )

    expect(typeof dshPlugin.run).toBe('function')
    expect(typeof dshPlugin.probe).toBe('function')
    expect(typeof dshPlugin.models).toBe('function')
    expect(firstReceipt.leaseId).toBe('run-1:1')
    expect(secondReceipt.leaseId).toBe('run-2:1')
  })
})
