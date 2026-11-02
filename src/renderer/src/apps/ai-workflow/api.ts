import type { AiWorkflowApi } from '../../../../shared/ai-workflow-api'

/** 取 preload 注入的 window.aiWorkflow；未注入则明确报错。 */
export function wfApi(): AiWorkflowApi {
  const w = window as unknown as { aiWorkflow?: AiWorkflowApi }
  if (!w.aiWorkflow) throw new Error('window.aiWorkflow 未注入（preload 未加载）')
  return w.aiWorkflow
}
