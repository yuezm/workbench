import type { AppDefinition } from './types'
import { pomodoroApp } from '../apps/pomodoro'

/** 工作台全部 app 的唯一注册入口：新增 app 在这里加一行 */
export const apps: AppDefinition[] = [pomodoroApp]
