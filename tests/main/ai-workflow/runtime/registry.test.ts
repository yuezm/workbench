// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeBackend } from '../../../../src/main/ai-workflow/runtime/registry'

describe('createRuntimeBackend', () => {
  it('dsh 协议族：探测/模型/执行都委托给 dsh 后端，并透传依赖', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn boom')
    })
    const backend = createRuntimeBackend('dsh', { spawn, timeouts: { probe: 5, models: 5 } })
    const probe = await backend.probe({ command: process.execPath, profile: 'multica' })
    expect(probe.state).toBe('unavailable')
    expect(probe.error).toContain('spawn boom')
    await expect(backend.models({ command: process.execPath, profile: 'multica' })).rejects.toThrow(
      /启动失败/,
    )
    const outcome = await backend.execute({
      runtime: {
        command: process.execPath,
        profile: 'multica',
        permissionMode: 'workspace-write',
        model: null,
        reasoningEffort: null,
        workdir: null,
      },
      requestId: 'r1',
      prompt: 'p',
      signal: new AbortController().signal,
      timeoutMs: 5,
    })
    expect(outcome.errorCode).toBe('spawn_failed')
    expect(spawn).toHaveBeenCalled()
  })

  it('未知执行器：明确报错（数据被绕过写入时的兜底）', () => {
    expect(() => createRuntimeBackend('claude')).toThrow(/不支持的执行器/)
  })
})
