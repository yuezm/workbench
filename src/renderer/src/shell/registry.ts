import type { AppPlugin } from './types'
import { pomodoroApp } from '../apps/pomodoro'
import { aiWorkflowApp } from '../apps/ai-workflow'

/** 工作台全部 app 插件清单：新增 app 在这里加一行 */
export const appPlugins: AppPlugin[] = [pomodoroApp, aiWorkflowApp]
