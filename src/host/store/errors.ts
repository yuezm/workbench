/**
 * store 错误：把内核 `reject` 的 `Reason` 原样透出，另加宿主入口校验失败与序号冲突。
 *
 * IPC 层按 `code` 分支，不匹配中文文案（SPEC-host「错误与诊断」）；`message` 只给人看。
 */
import type { Reason } from '../../kernel/core/types'

export type StoreErrorCode = Reason

export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

/**
 * 事务内发现 `facts.seq` 与装载视图时的 `view.seq` 不一致：另一个写者已提交。
 *
 * 只在 store 内部流转：`dispatch` 捕获后重读视图重试一次，仍冲突才转成
 * `StoreError('conflict')` 交给 IPC（SPEC-kernel「错误」）。
 */
export class SeqConflictError extends Error {
  constructor() {
    super('事实日志序号与视图不一致')
    this.name = 'SeqConflictError'
  }
}
