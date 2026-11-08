import { useState } from 'react'
import type { ReactElement } from 'react'
import type { AppPlugin } from './types'
import { appPlugins as registeredApps } from './registry'
import { ErrorBoundary } from '../components/ui/error-boundary'
import { TopBar } from './components/TopBar'

interface WorkbenchProps {
  /** 缺省时使用全局插件清单；测试可注入 */
  apps?: AppPlugin[]
}

export function Workbench({ apps = registeredApps }: WorkbenchProps): ReactElement {
  const [activeId, setActiveId] = useState(apps[0]?.id ?? '')
  const active = apps.find((a) => a.id === activeId) ?? apps[0]

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-abyss text-ink">
      <TopBar apps={apps} activeId={active?.id ?? ''} onSelect={setActiveId} />
      {/* 内容槽：app 根节点自动撑满（app 只需 h-full，无需再写 w-full）。
          渲染兜底按 app 重建：某个 app 炸了仍然能切到别的 app，而不是白窗。 */}
      <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden [&>*]:min-w-0 [&>*]:flex-1">
        <ErrorBoundary key={active?.id ?? 'none'}>
          {active ? <active.component /> : null}
        </ErrorBoundary>
      </main>
    </div>
  )
}
