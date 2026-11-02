import { ipcMain } from 'electron'
import type { AgentInput, RuntimeInput } from '../../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'
import type { Repository } from './repository'

/** 纯分发器：方法名 + 参数 → 结果；不含 electron 依赖，便于单测。 */
export type AiWorkflowHandler = (method: string, args: unknown[]) => unknown

export function createAiWorkflowHandler(
  repo: Repository,
  notifyChanged: () => void,
): AiWorkflowHandler {
  const mutate = (fn: () => unknown): unknown => {
    const result = fn()
    notifyChanged()
    return result
  }

  const table: Record<string, (a: unknown[]) => unknown> = {
    'runtimes.list': () => repo.runtimesList(),
    'runtimes.create': (a) => mutate(() => repo.runtimeCreate(a[0] as RuntimeInput)),
    'runtimes.update': (a) =>
      mutate(() => repo.runtimeUpdate(a[0] as string, a[1] as Partial<RuntimeInput>)),
    'runtimes.remove': (a) => mutate(() => repo.runtimeRemove(a[0] as string)),

    'agents.list': () => repo.agentsList(),
    'agents.create': (a) => mutate(() => repo.agentCreate(a[0] as AgentInput)),
    'agents.update': (a) =>
      mutate(() => repo.agentUpdate(a[0] as string, a[1] as Partial<AgentInput>)),
    'agents.remove': (a) => mutate(() => repo.agentRemove(a[0] as string)),
  }

  return (method, args) => {
    const fn = table[method]
    if (!fn) throw new Error('未知方法: ' + method)
    return fn(args)
  }
}

export interface AiWorkflowIpcDeps {
  repo: Repository
  notifyChanged: () => void
}

export function registerAiWorkflowIpc(deps: AiWorkflowIpcDeps): void {
  const handler = createAiWorkflowHandler(deps.repo, deps.notifyChanged)
  ipcMain.handle(AI_WORKFLOW_CHANNEL, (_event, method: string, args: unknown[]) =>
    handler(method, args),
  )
}
