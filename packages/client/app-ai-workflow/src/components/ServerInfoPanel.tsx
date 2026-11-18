import type { ReactElement } from 'react'
import { Panel } from '@workbench/client-ui-kit/panel'
import { formatLocalDateTime } from '@workbench/client-ui-kit/time'
import { useServerInfo } from '@workbench/client-shell/server-info'

/** 一行只读信息：标签 + 等宽值（路径类容易看错，一律等宽） */
function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">{value}</span>
    </div>
  )
}

/**
 * 设置 / 服务：这台服务现在是什么状态、数据放哪、怎么改配置。
 *
 * 为什么要有这一栏：服务器形态下「我连的是哪个进程、数据在哪个目录、改哪个环境变量」是
 * 排查第一问，而这些信息只有服务端知道。全部只读——改配置走环境变量 + 重启（见 README），
 * 界面上给写入入口只会制造「改了但没生效」的困惑。
 *
 * 有意不显示「在线页面数」：快照是在页面订阅 SSE **之前**取的，显示的必然是 0（不含自己），
 * 一个永远偏小的读数比不显示更容易误导。这个数字留在 `/api/info` 里给脚本用。
 */
export function ServerInfoPanel(): ReactElement {
  const info = useServerInfo()
  const origin = window.location.origin

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <Panel>
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium">服务</span>
          <span className="text-xs text-muted-foreground">只读 · 改配置请设环境变量后重启</span>
        </div>
        {info === null ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">还没有取到服务信息。</p>
        ) : (
          <>
            <Row label="地址" value={origin} />
            <Row label="服务版本" value={info.version} />
            <Row label="内核版本" value={info.kernelVersion} />
            <Row label="数据目录" value={info.dataDir} />
            <Row label="默认工作目录" value={info.defaultWorkdir} />
            {/* 服务给的是 ISO（UTC）；排查时看的是本机几点起的，所以按本机时区渲染 */}
            <Row label="启动时间" value={formatLocalDateTime(info.startedAt)} />
            <Row label="进程号" value={String(info.pid)} />
          </>
        )}
      </Panel>

      <Panel>
        <div className="px-4 py-3">
          <p className="text-xs text-muted-foreground">
            数据目录放库（ai-workflow.db）、产物（artifacts/）、插件（plugins/）与主密钥（secret.key）。
            备份就是拷这个目录。
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            监听地址、端口、token、Web 产物目录由 WORKBENCH_* 环境变量决定。
          </p>
        </div>
      </Panel>
    </div>
  )
}
