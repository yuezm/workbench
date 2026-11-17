import type { WorkbenchApi } from '@workbench/contract-api'

declare global {
  interface Window {
    workbench: WorkbenchApi
  }
}

export {}
