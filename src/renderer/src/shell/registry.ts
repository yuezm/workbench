import type { AppPlugin } from './types'
import { aiWorkflowApp } from '../apps/ai-workflow'
import { pomodoroApp } from '../apps/pomodoro'

/**
 * 工作台全部 app 插件清单：新增 app 在这里加一行。
 *
 * 顺序即顶部栏的显示顺序，也是外壳的默认选中项（`Workbench` 取 `apps[0]`）：
 * AI 工作流排在番茄时钟前面且默认打开。
 */
export const appPlugins: AppPlugin[] = [aiWorkflowApp, pomodoroApp]
