import type { ReactElement } from 'react'

export interface StartupFailureProps {
  /** 具体原因；缺省指向「服务没连上」 */
  message?: string
}

/**
 * 启动失败兜底页：服务连不上时不要白屏。
 *
 * 服务器形态下最常见的失败是「进程没起来 / 端口被占 / 地址写错」，所以文案指向服务进程，
 * 而不是安装包里的 preload。真正的排查信息（数据目录、端口）在服务端启动日志里，
 * 这里只把浏览器看到的错误原样展示出来。
 */
export function StartupFailure({
  message = '无法连接工作台服务（/api/info 无响应）',
}: StartupFailureProps): ReactElement {
  return (
    <div role="alert" className="grid h-screen place-items-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-5">
        <h1 className="text-base font-medium text-foreground">界面没有加载成功</h1>
        <p className="text-sm break-words text-destructive">{message}</p>
        <p className="text-xs text-muted-foreground">
          确认服务进程在跑（`pnpm start`），并核对地址与端口。
        </p>
      </div>
    </div>
  )
}
