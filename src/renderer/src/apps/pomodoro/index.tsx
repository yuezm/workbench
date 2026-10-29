import type { ReactElement } from 'react'
import type { AppDefinition, AppIconProps } from '../../shell/types'
import { PomodoroPage } from './PomodoroPage'

function PomodoroIcon({ size = 18 }: AppIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="14" r="8" />
      <path
        d="M12 6.2C10.6 4.8 8.8 4.2 7 4.4c1 1.4 2.6 2.3 5 2.5 2.4-.2 4-1.1 5-2.5-1.8-.2-3.6.4-5 1.8z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  )
}

export const pomodoroApp: AppDefinition = {
  id: 'pomodoro',
  name: '番茄时钟',
  icon: PomodoroIcon,
  component: PomodoroPage
}
