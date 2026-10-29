import { useState } from 'react'
import type { ReactElement } from 'react'
import type { AppDefinition } from './types'
import { apps as registeredApps } from './registry'
import { Sidebar } from './components/Sidebar'

interface WorkbenchProps {
  /** 缺省时使用全局注册表；测试可注入 */
  apps?: AppDefinition[]
}

export function Workbench({ apps = registeredApps }: WorkbenchProps): ReactElement {
  const [activeId, setActiveId] = useState(apps[0]?.id ?? '')
  const active = apps.find((a) => a.id === activeId) ?? apps[0]

  return (
    <div className="relative flex h-screen overflow-hidden bg-abyss text-ink">
      {/* 环境极光：两团缓慢漂移的光斑 */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-44 -left-32 size-[480px] animate-drift rounded-full bg-focus/20 blur-[120px]" />
        <div className="absolute -right-44 -bottom-52 size-[560px] animate-drift-slow rounded-full bg-long/15 blur-[140px]" />
      </div>

      <Sidebar apps={apps} activeId={active?.id ?? ''} onSelect={setActiveId} />
      <main className="relative z-10 min-w-0 flex-1 overflow-auto">
        {active ? <active.component /> : null}
      </main>
    </div>
  )
}
