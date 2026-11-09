import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './button'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** 兜底标题；缺省「界面出错了」 */
  title?: string
}

interface ErrorBoundaryState {
  /** 捕获到的异常；null = 未出错 */
  error: Error | null
}

/**
 * 渲染兜底：一处出错不能变成白窗。
 *
 * 之前 renderer 没有任何错误边界：任意组件在渲染期抛错（视图数据形状不合预期、
 * preload 桥接缺方法、第三方组件炸了）都会让 React 卸载整棵树 —— 用户看到的是白窗口，
 * 控制台之外没有任何线索。这里至少给一句人话 + 异常文案 + 重新加载入口。
 *
 * 用 `key={activeId}` 挂在 app 内容槽上，切换 app 会重建边界，出错后可继续用其它 app。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只写组件栈，不落业务数据（提示词、正文不进日志）
    console.error('[workbench] 渲染失败', error, info.componentStack)
  }

  private readonly reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const error = this.state.error
    if (error === null) return this.props.children
    return (
      <div role="alert" className="grid h-full place-items-center p-6">
        <div className="flex w-full max-w-md flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-5">
          <h2 className="text-base font-medium text-foreground">
            {this.props.title ?? '界面出错了'}
          </h2>
          <p className="text-sm break-words text-destructive">{error.message}</p>
          <p className="text-xs text-muted-foreground">
            数据没有丢：界面由事实日志重建，重新加载后继续。反复出现请记下上面的文案。
          </p>
          <div className="mt-1 flex justify-end">
            <Button variant="secondary" size="sm" onClick={this.reload}>
              重新加载
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
