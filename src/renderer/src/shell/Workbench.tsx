import type { ReactElement } from 'react'
import type { AppPlugin } from './types'
import { appPlugins as registeredApps } from './registry'
import { selectApp, useActiveAppId } from './openTarget'
import { ErrorBoundary } from '../components/ui/error-boundary'
import { TopBar } from './components/TopBar'

interface WorkbenchProps {
  /** 缺省时使用全局插件清单；测试可注入 */
  apps?: AppPlugin[]
}

export function Workbench({ apps = registeredApps }: WorkbenchProps): ReactElement {
  /**
   * 当前 app 由 shell 导航 store 持有（`openTarget.ts`），组件里不再放一份 state：
   *
   * - 系统通知的落点第一跳就是「切到哪个 app」，它与落点同一笔写入，所以这里渲染期纯派生即可，
   *   不需要在 effect 里校正 state（那样会级联渲染，`react-hooks` v7 判 error），
   *   也不会出现「先切过去、落点被消费后又弹回原 app」的双真相源；
   * - 还没选过（`null`）或落点给的 id 不在注册表里，都回落到第一个 app——
   *   一个坏落点最多是没切过去，不该把界面打成空白。
   */
  const chosenId = useActiveAppId()
  const activeId =
    chosenId !== null && apps.some((app) => app.id === chosenId) ? chosenId : (apps[0]?.id ?? '')
  const active = apps.find((a) => a.id === activeId) ?? apps[0]

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar apps={apps} activeId={active?.id ?? ''} onSelect={selectApp} />
      {/* 内容槽：app 根节点自动撑满（app 只需 h-full，无需再写 w-full）。
          渲染兜底按 app 重建：某个 app 炸了仍然能切到别的 app，而不是白窗。 */}
      <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden [&>*]:min-w-0 [&>*]:flex-1">
        <ErrorBoundary key={active?.id ?? 'none'}>
          {active ? <active.component /> : null}
        </ErrorBoundary>
      </main>
    </div>
  )
}
