import type { ReactElement } from 'react'

export interface StartupFailureProps {
  /** 具体原因；缺省指向 preload 桥接缺失（最常见的启动失败） */
  message?: string
}

/**
 * 启动失败兜底页：preload 没注入时不要白屏。
 *
 * 之前 `main.tsx` 在 `window.workbench === undefined` 时直接 `throw`：React 还没挂载，
 * 窗口里只剩白底，用户连「哪里坏了」都看不到。这里改成渲染一页人话。
 */
export function StartupFailure({
  message = 'window.workbench 未注入（preload 未加载）',
}: StartupFailureProps): ReactElement {
  return (
    <div role="alert" className="grid h-screen place-items-center bg-abyss p-6">
      <div className="flex w-full max-w-md flex-col gap-2 rounded-xl border border-danger/30 bg-danger/10 p-5">
        <h1 className="text-title font-medium text-ink">界面没有加载成功</h1>
        <p className="text-body break-words text-danger">{message}</p>
        <p className="text-meta text-ink-dim">
          先重启工作台；仍然失败说明安装包里的 preload 桥接缺失，需要重新安装。
        </p>
      </div>
    </div>
  )
}
