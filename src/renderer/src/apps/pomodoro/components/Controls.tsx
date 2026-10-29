import type { ReactElement, SVGProps } from 'react'
import { Button } from '../../../components/ui/button'

interface ControlsProps {
  running: boolean
  onStart: () => void
  onPause: () => void
  onReset: () => void
  onSkip: () => void
}

function Icon({ children, ...props }: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export function Controls({
  running,
  onStart,
  onPause,
  onReset,
  onSkip,
}: ControlsProps): ReactElement {
  return (
    <div className="flex animate-rise items-center gap-3 [animation-delay:80ms]">
      {running ? (
        <Button variant="primary" size="lg" onClick={onPause}>
          <Icon>
            <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
            <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
          </Icon>
          暂停
        </Button>
      ) : (
        <Button variant="primary" size="lg" onClick={onStart}>
          <Icon>
            <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
          </Icon>
          开始
        </Button>
      )}
      <Button size="lg" onClick={onReset}>
        <Icon>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
        </Icon>
        重置
      </Button>
      <Button size="lg" onClick={onSkip}>
        <Icon>
          <path d="M5 5l9 7-9 7z" fill="currentColor" stroke="none" />
          <path d="M19 5v14" />
        </Icon>
        跳过
      </Button>
    </div>
  )
}
