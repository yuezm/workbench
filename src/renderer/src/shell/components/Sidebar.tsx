import type { ReactElement } from 'react'
import type { AppDefinition } from '../types'
import styles from './sidebar.module.css'

interface SidebarProps {
  apps: AppDefinition[]
  activeId: string
  onSelect: (id: string) => void
}

export function Sidebar({ apps, activeId, onSelect }: SidebarProps): ReactElement {
  return (
    <nav className={styles.sidebar} aria-label="应用导航">
      {apps.map((app) => {
        const active = app.id === activeId
        return (
          <button
            key={app.id}
            type="button"
            className={active ? `${styles.item} ${styles.itemActive}` : styles.item}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelect(app.id)}
          >
            <app.icon />
            <span>{app.name}</span>
          </button>
        )
      })}
    </nav>
  )
}
