import type { ReactElement } from 'react'
import styles from './controls.module.css'

interface ControlsProps {
  running: boolean
  onStart: () => void
  onPause: () => void
  onReset: () => void
  onSkip: () => void
}

export function Controls({
  running,
  onStart,
  onPause,
  onReset,
  onSkip
}: ControlsProps): ReactElement {
  return (
    <div className={styles.row}>
      {running ? (
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onPause}>
          暂停
        </button>
      ) : (
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onStart}>
          开始
        </button>
      )}
      <button type="button" className={styles.button} onClick={onReset}>
        重置
      </button>
      <button type="button" className={styles.button} onClick={onSkip}>
        跳过
      </button>
    </div>
  )
}
