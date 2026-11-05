import type { WorkbenchApi } from '../../../shared/workbench-api'

declare global {
  interface Window {
    workbench: WorkbenchApi
  }
}

export {}
