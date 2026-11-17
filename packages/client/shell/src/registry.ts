import type { AppPlugin } from './types'
import { aiWorkflowApp } from '@workbench/client-app-ai-workflow'

/**
 * 工作台全部 app 插件清单：当前只有一个内置 app，新增 app 在这里加一行。
 *
 * 顺序即顶部栏的显示顺序，也是外壳的默认选中项（`Workbench` 取 `apps[0]`）。
 */
export const appPlugins: AppPlugin[] = [aiWorkflowApp]
