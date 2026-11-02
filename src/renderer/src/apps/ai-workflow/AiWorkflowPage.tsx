import type { ReactElement } from 'react'

export function AiWorkflowPage(): ReactElement {
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">AI 工作流</h1>
          <p className="mt-1 text-sm text-ink-dim">配置运行时与智能体，用看板推进多阶段工作流。</p>
        </div>
      </header>

      <div className="grid flex-1 place-items-center rounded-2xl border border-line bg-white/[0.02] px-6 py-10 text-center text-sm text-ink-faint">
        尚无工作流。先在「管理」里添加运行时与智能体，再新建一条工作流。
      </div>
    </div>
  )
}
