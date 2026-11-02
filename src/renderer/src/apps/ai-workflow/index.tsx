import type { ReactElement } from 'react'
import type { AppDefinition, AppIconProps } from '../../shell/types'
import { AiWorkflowPage } from './AiWorkflowPage'

function AiWorkflowIcon({ size = 18 }: AppIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="5" height="16" rx="1.2" />
      <rect x="10" y="4" width="5" height="10" rx="1.2" />
      <rect x="17" y="4" width="4" height="13" rx="1.2" />
    </svg>
  )
}

export const aiWorkflowApp: AppDefinition = {
  id: 'ai-workflow',
  name: 'AI 工作流',
  icon: AiWorkflowIcon,
  component: AiWorkflowPage,
}
