import type { ReactElement } from 'react'
import { AgentManager } from './components/AgentManager'
import { RuntimeManager } from './components/RuntimeManager'

export function AiWorkflowPage(): ReactElement {
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <header>
        <h1 className="text-lg font-semibold text-ink">AI 工作流</h1>
        <p className="mt-1 text-sm text-ink-dim">配置运行时与智能体，用看板推进多阶段工作流。</p>
      </header>

      <details open className="rounded-2xl border border-line bg-white/[0.02] p-4">
        <summary className="cursor-pointer text-sm font-medium text-ink">运行时</summary>
        <div className="mt-3">
          <RuntimeManager />
        </div>
      </details>

      <details className="rounded-2xl border border-line bg-white/[0.02] p-4">
        <summary className="cursor-pointer text-sm font-medium text-ink">智能体</summary>
        <div className="mt-3">
          <AgentManager />
        </div>
      </details>

      <div className="grid flex-1 place-items-center rounded-2xl border border-line bg-white/[0.02] px-6 py-10 text-center text-sm text-ink-faint">
        尚无工作流。添加运行时与智能体后，再新建一条工作流。
      </div>
    </div>
  )
}
