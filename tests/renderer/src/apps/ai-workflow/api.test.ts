import { describe, expect, it } from 'vitest'
import type { AiWorkflowApi } from '../../../../../src/shared/ai-workflow-api'
import { wfApi } from '../../../../../src/renderer/src/apps/ai-workflow/api'

describe('wfApi', () => {
  it('注入存在时返回 window.aiWorkflow', () => {
    const fake = { marker: true } as unknown as AiWorkflowApi
    ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = fake
    expect(wfApi()).toBe(fake)
  })

  it('未注入时抛错', () => {
    delete (window as unknown as { aiWorkflow?: unknown }).aiWorkflow
    expect(() => wfApi()).toThrow(/未注入/)
  })
})
