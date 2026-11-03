import { useState } from 'react'
import type { ReactElement } from 'react'
import type { AppDefinition } from './types'
import { apps as registeredApps } from './registry'
import { TopBar } from './components/TopBar'

interface WorkbenchProps {
  /** 缺省时使用全局注册表；测试可注入 */
  apps?: AppDefinition[]
}

export function Workbench({ apps = registeredApps }: WorkbenchProps): ReactElement {
  const [activeId, setActiveId] = useState(apps[0]?.id ?? '')
  const active = apps.find((a) => a.id === activeId) ?? apps[0]

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-abyss text-ink">
      {/* 环境极光：两团缓慢漂移的光斑 */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-44 -left-32 size-[480px] animate-drift rounded-full bg-focus/20 blur-[120px]" />
        <div className="absolute -right-44 -bottom-52 size-[560px] animate-drift-slow rounded-full bg-long/15 blur-[140px]" />
      </div>

      <TopBar apps={apps} activeId={active?.id ?? ''} onSelect={setActiveId} />
      {/* 内容槽：app 根节点自动撑满（app 只需 h-full，无需再写 w-full） */}
      <main className="relative z-10 flex min-h-0 min-w-0 flex-1 overflow-hidden [&>*]:min-w-0 [&>*]:flex-1">
        {active ? <active.component /> : null}
      </main>
    </div>
  )
}
