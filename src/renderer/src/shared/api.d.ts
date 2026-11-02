import type { WorkbenchApi } from '../../../shared/workbench-api'
import type { AiWorkflowApi } from '../../../shared/ai-workflow-api'

declare global {
  interface Window {
    workbench: WorkbenchApi
    aiWorkflow: AiWorkflowApi
  }
}

export {}
