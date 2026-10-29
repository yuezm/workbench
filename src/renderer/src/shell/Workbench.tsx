import { useState } from 'react'
import type { ReactElement } from 'react'
import type { AppDefinition } from './types'
import { apps as registeredApps } from './registry'
import { Sidebar } from './components/Sidebar'
import styles from './workbench.module.css'

interface WorkbenchProps {
  /** 缺省时使用全局注册表；测试可注入 */
  apps?: AppDefinition[]
}

export function Workbench({ apps = registeredApps }: WorkbenchProps): ReactElement {
  const [activeId, setActiveId] = useState(apps[0]?.id ?? '')
  const active = apps.find((a) => a.id === activeId) ?? apps[0]

  return (
    <div className={styles.layout}>
      <Sidebar apps={apps} activeId={active?.id ?? ''} onSelect={setActiveId} />
      <main className={styles.content}>{active ? <active.component /> : null}</main>
    </div>
  )
}
