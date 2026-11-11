import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  DetectedRuntime,
  Runtime,
  RuntimeExecutorChoice,
  RuntimeInput,
  RuntimeStatus,
} from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { FormError } from '../../../components/ui/form-error'
import { Panel, badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'
import { RuntimeDialog } from './RuntimeDialog'
import { RuntimeStatusBadge } from './RuntimeStatusBadge'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 打开弹窗时记录：编辑目标（null = 新建）与新建预填（仅在新建时有意义） */
interface DialogState {
  runtime: Runtime | null
  initial: RuntimeInput | null
}

/**
 * 新建运行时的默认值：执行器与 command/profile 由弹窗从 executors 清单首项 manifest 取；
 * 执行配置（模型 / 并发 / 权限等）在智能体上，这里只有名字。
 */
function newRuntimeInput(): RuntimeInput {
  return { name: '' }
}

function TerminalIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M4 6.5 9 11l-5 4.5" />
      <path d="M12.5 16.5H20" />
    </svg>
  )
}

function ListIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  )
}

function ScanIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M12 9v6M9 12h6" />
    </svg>
  )
}

/**
 * 运行时页：检测清单 + 已配置清单。
 *
 * 运行时 = 本机执行环境实例（协议族 + CLI 启动方式 + 执行策略）；清单同时展示
 * 持久化的最近探测结论与实时负载，新建/编辑共用一个弹窗。
 *
 * 清单/负载读内核视图（写操作成功后由事实失效自动重取）；探测清单与执行器清单
 * 是宿主视图，按需 `query` 一次。
 */
export function RuntimeManager(): ReactElement {
  const runtimesState = useKernelViewState('runtimes.all')
  const statusesState = useKernelViewState('runtimes.statuses')
  const items = runtimesState.data ?? []
  const statuses: Record<string, RuntimeStatus> = Object.fromEntries(
    (statusesState.data ?? []).map((status) => [status.runtimeId, status]),
  )
  /** 执行器清单（只读，注册表顺序）：用于把角标的 key 映射成展示名 */
  const [executors, setExecutors] = useState<RuntimeExecutorChoice[]>([])
  const [detected, setDetected] = useState<DetectedRuntime[]>([])
  /** 首次进入即自动扫描，所以初始为扫描中 */
  const [detecting, setDetecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 检测清单自己的错误：与清单/操作错误分开，避免并发加载互相覆盖 */
  const [detectError, setDetectError] = useState<string | null>(null)
  /** 非空 = 弹窗打开中 */
  const [dialog, setDialog] = useState<DialogState | null>(null)
  /** 正在探测的运行时 id（各行按钮状态互相独立） */
  const [probingId, setProbingId] = useState<string | null>(null)
  /** 展开失败详情的运行时 id */
  const [expandedProbeId, setExpandedProbeId] = useState<string | null>(null)
  /** 正在删除的运行时 id：删除期间按钮禁用并说明原因，避免连点删两次 */
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const scan = useCallback(async (): Promise<void> => {
    try {
      const list = await getKernelStore().query('runtimes.detected')
      setDetected(list ?? [])
      setDetectError(null)
    } catch (e) {
      setDetectError(errMsg(e))
    } finally {
      setDetecting(false)
    }
  }, [])

  // 进入该页即取执行器清单，并自动识别本机已安装的 CLI。
  // 放到下一个宏任务再发请求：让 effect 只负责触发，不在渲染阶段同步改状态。
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      void getKernelStore()
        .query('runtimes.executors')
        .then((list) => {
          if (alive) setExecutors(list ?? [])
        })
        .catch((e: unknown) => {
          if (alive) setError(errMsg(e))
        })
      void scan()
    }, 0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [scan])

  /** 「重新扫描」：先进入扫描中再复用 scan 的收尾逻辑 */
  const rescan = (): void => {
    setDetecting(true)
    void scan()
  }

  const submit = async (input: RuntimeInput): Promise<void> => {
    const store = getKernelStore()
    if (dialog?.runtime) {
      await store.dispatch({
        type: 'runtime.update',
        commandId: '',
        id: dialog.runtime.id,
        patch: input,
      })
    } else {
      await store.dispatch({ type: 'runtime.create', commandId: '', input })
    }
    setDialog(null)
  }

  const remove = async (id: string): Promise<void> => {
    setDeletingId(id)
    setError(null)
    try {
      await getKernelStore().dispatch({ type: 'runtime.remove', commandId: '', id })
      setExpandedProbeId((prev) => (prev === id ? null : prev))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setDeletingId(null)
    }
  }

  /**
   * 重新探测一次：`runtime.probe` 是宿主编排命令（M5 D3）——宿主用执行器端口探测、
   * 落 `runtime.probed` 事实并返回结论；前端不再自己拼 probe 载荷。
   * 列表由 `runtime.probed` 事实失效自动重取。
   */
  const runProbe = async (id: string): Promise<void> => {
    setProbingId(id)
    try {
      await getKernelStore().dispatch({ type: 'runtime.probe', commandId: '', id })
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setProbingId(null)
    }
  }

  /** 执行器键 → 展示名；清单里没有（插件被移除等）就显示原始 key */
  const executorLabel = (key: string): string =>
    executors.find((choice) => choice.key === key)?.label ?? key

  /** 检测清单的「使用」：带入名称、命令与执行器（重名时加命令后缀），其余字段保持默认 */
  const prefill = (d: DetectedRuntime): void => {
    const taken = items.some((r) => r.name === d.label)
    setDialog({
      runtime: null,
      initial: {
        ...newRuntimeInput(),
        name: taken ? `${d.label} (${d.command})` : d.label,
        command: d.command,
        // 未注册 CLI 的 executorKey 是空串：空串会被宿主当成未注册的 key 拒绝，这里不写
        executorKey: d.executorKey || undefined,
      },
    })
  }

  const toggleProbeDetails = (id: string): void => {
    setExpandedProbeId((prev) => (prev === id ? null : id))
  }

  const pageError = error ?? runtimesState.error ?? statusesState.error

  return (
    <div className="flex flex-col gap-4">
      {/* 自动识别本机已安装的运行时 */}
      <Panel className="flex animate-rise flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <ScanIcon className="text-brand" />
          <h3 className="text-base font-medium text-foreground">已安装的运行时</h3>
          <span className={cn(badgeCls, 'ml-auto')}>{detected.length}</span>
          <Button type="button" variant="ghost" size="sm" disabled={detecting} onClick={rescan}>
            {detecting ? '扫描中…' : '重新扫描'}
          </Button>
        </div>

        {detected.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-faint-foreground">
            {detecting ? '正在扫描本机 PATH…' : '未检测到 CLI，可在下方手动新建。'}
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {detected.map((d) => {
              const added = items.some((r) => r.command === d.command)
              return (
                <li
                  key={d.command}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-muted-foreground">
                    <TerminalIcon />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-foreground">{d.label}</span>
                    <span
                      className="truncate font-mono text-sm text-faint-foreground"
                      title={d.path}
                    >
                      {d.path}
                    </span>
                  </span>
                  {added ? (
                    <span className="rounded-sm bg-accent px-2 py-1 text-xs text-faint-foreground">
                      已添加
                    </span>
                  ) : d.supported ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => prefill(d)}>
                      使用
                    </Button>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled
                        title="当前版本只接入了 DSH 协议，暂时无法把该 CLI 作为运行时接入"
                      >
                        不支持
                      </Button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {/* 写命令失败可关掉；读视图失败是持续状态，不给关闭入口 */}
      <FormError
        message={pageError}
        onDismiss={error === null ? undefined : () => setError(null)}
      />
      <FormError message={detectError} />

      {/* 已配置运行时 */}
      <Panel className="flex animate-rise flex-col gap-3 p-5 [animation-delay:80ms]">
        <div className="flex items-center gap-2">
          <ListIcon className="text-muted-foreground" />
          <h3 className="text-base font-medium text-foreground">已配置运行时</h3>
          <span className={cn(badgeCls)}>{items.length}</span>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="ml-auto"
            onClick={() => setDialog({ runtime: null, initial: newRuntimeInput() })}
          >
            新建运行时
          </Button>
        </div>

        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {items.length === 0 && (
            <li className="grid place-items-center rounded-xl border border-dashed border-border py-6 text-sm text-faint-foreground">
              暂无运行时
            </li>
          )}
          {items.map((r) => {
            const status = statuses[r.id]
            const running = status?.workload.running ?? 0
            const queued = status?.workload.queued ?? 0
            const probing = probingId === r.id
            const probe = r.lastProbe
            const showDetails = expandedProbeId === r.id && probe?.state === 'unavailable'
            return (
              <li
                key={r.id}
                className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent"
              >
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-accent text-muted-foreground">
                  <TerminalIcon />
                </span>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{r.name}</span>
                    <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-faint-foreground">
                      {executorLabel(r.executorKey)}
                    </span>
                    <RuntimeStatusBadge
                      probe={probe}
                      testing={probing}
                      expanded={expandedProbeId === r.id}
                      onToggle={() => toggleProbeDetails(r.id)}
                    />
                    {probe?.cliVersion && (
                      <span className="text-xs text-faint-foreground">CLI v{probe.cliVersion}</span>
                    )}
                    {!r.enabled && (
                      <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-faint-foreground">
                        已停用
                      </span>
                    )}
                  </div>

                  {/* 启动头只展示运行时真正配置的部分：profile 是 dsh 的形态，
                      其它执行器留空，不要再拼 `--stdio` 这类插件内部参数 */}
                  <span className="truncate font-mono text-sm text-muted-foreground">
                    {r.command}
                    {r.profile ? ` --profile ${r.profile}` : ''}
                  </span>

                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint-foreground">
                    <span className="truncate font-mono" title={probe?.path ?? undefined}>
                      {probe?.path ?? '未找到可执行文件'}
                    </span>
                    <span className="tabular-nums">运行中 {running}</span>
                    {queued > 0 && <span className="text-warning tabular-nums">排队 {queued}</span>}
                  </span>

                  {showDetails && (
                    <div className="flex flex-col gap-1 rounded-lg border border-destructive/20 bg-destructive/[0.06] px-2.5 py-2">
                      <p className="text-sm text-destructive">{probe?.error ?? '未知错误'}</p>
                      {probe?.output && (
                        <pre className="max-h-32 overflow-auto text-sm whitespace-pre-wrap text-faint-foreground">
                          {probe.output}
                        </pre>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`测试运行时 ${r.name}`}
                    disabled={probing}
                    onClick={() => void runProbe(r.id)}
                  >
                    测试
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`编辑运行时 ${r.name}`}
                    onClick={() => setDialog({ runtime: r, initial: null })}
                  >
                    编辑
                  </Button>
                  {/* 删除进行中给可见状态：按钮变灰本身不解释原因 */}
                  {deletingId === r.id && (
                    <span className="text-xs text-faint-foreground">删除中…</span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`删除运行时 ${r.name}`}
                    disabled={deletingId === r.id}
                    onClick={() => void remove(r.id)}
                  >
                    删除
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </Panel>

      {dialog !== null && (
        <RuntimeDialog
          runtime={dialog.runtime}
          initial={dialog.initial}
          onSubmit={submit}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}
