import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  DetectedRuntime,
  Runtime,
  RuntimeInput,
  RuntimeStatus,
} from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { Panel, badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { wfApi } from '../api'
import { RuntimeDialog } from './RuntimeDialog'
import { RuntimeStatusBadge } from './RuntimeStatusBadge'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 打开弹窗时记录：编辑目标（null = 新建）与新建预填（仅在新建时有意义） */
interface DialogState {
  runtime: Runtime | null
  initial: RuntimeInput | null
}

/** 新建运行时的默认值：DSH 的默认 profile 是 multica，并发从 1 起 */
function newRuntimeInput(): RuntimeInput {
  return {
    name: '',
    command: 'dsh',
    profile: 'multica',
    permissionMode: 'workspace-write',
    maxConcurrent: 1,
  }
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
 */
export function RuntimeManager(): ReactElement {
  const [items, setItems] = useState<Runtime[]>([])
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({})
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

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, workload] = await Promise.all([
        wfApi().runtimes.list(),
        wfApi().runtimes.statuses(),
      ])
      setItems(list)
      setStatuses(Object.fromEntries(workload.map((status) => [status.runtimeId, status])))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  const scan = useCallback(async (): Promise<void> => {
    try {
      setDetected(await wfApi().runtimes.detect())
      setDetectError(null)
    } catch (e) {
      setDetectError(errMsg(e))
    } finally {
      setDetecting(false)
    }
  }, [])

  // 进入该页即拉取清单/负载，并自动识别本机已安装的 CLI
  // 放到下一个宏任务再发请求：让 effect 只负责触发，不在渲染阶段同步改状态
  useEffect(() => {
    const timer = setTimeout(() => {
      void load()
      void scan()
    }, 0)
    return () => clearTimeout(timer)
  }, [load, scan])

  /** 「重新扫描」：先进入扫描中再复用 scan 的收尾逻辑 */
  const rescan = (): void => {
    setDetecting(true)
    void scan()
  }

  const submit = async (input: RuntimeInput): Promise<void> => {
    if (dialog?.runtime) await wfApi().runtimes.update(dialog.runtime.id, input)
    else await wfApi().runtimes.create(input)
    setDialog(null)
    await load()
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await wfApi().runtimes.remove(id)
      setExpandedProbeId((prev) => (prev === id ? null : prev))
      await load()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  /**
   * 真实探测一次：结论已由主进程写回运行时，这里同步行内状态，
   * 失败（运行时被删等）落成页面级错误。
   */
  const runProbe = async (id: string): Promise<void> => {
    setProbingId(id)
    try {
      const probe = await wfApi().runtimes.probe(id)
      setItems((prev) => prev.map((r) => (r.id === id ? { ...r, lastProbe: probe } : r)))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setProbingId(null)
    }
  }

  /** 检测清单的「使用」：带入名称与命令（重名时加命令后缀），其余字段保持默认 */
  const prefill = (d: DetectedRuntime): void => {
    const taken = items.some((r) => r.name === d.label)
    setDialog({
      runtime: null,
      initial: {
        ...newRuntimeInput(),
        name: taken ? `${d.label} (${d.command})` : d.label,
        command: d.command,
      },
    })
  }

  const toggleProbeDetails = (id: string): void => {
    setExpandedProbeId((prev) => (prev === id ? null : id))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 自动识别本机已安装的运行时 */}
      <Panel className="flex animate-rise flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <ScanIcon className="text-focus" />
          <h3 className="text-[13px] font-medium tracking-wide text-ink">已安装的运行时</h3>
          <span className={cn(badgeCls, 'ml-auto')}>{detected.length}</span>
          <Button type="button" variant="ghost" size="sm" disabled={detecting} onClick={rescan}>
            {detecting ? '扫描中…' : '重新扫描'}
          </Button>
        </div>

        {detected.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-4 text-xs text-ink-faint">
            {detecting
              ? '正在扫描本机 PATH…'
              : '未检测到已安装的 CLI（dsh / claude / codex 等），可在下方手动新建运行时。'}
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {detected.map((d) => {
              const added = items.some((r) => r.command === d.command)
              return (
                <li
                  key={d.command}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-ink-dim">
                    <TerminalIcon />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-ink">{d.label}</span>
                    <span className="truncate font-mono text-[11px] text-ink-faint" title={d.path}>
                      {d.path}
                    </span>
                  </span>
                  {added ? (
                    <span className="rounded-full bg-white/[0.07] px-2 py-1 text-[11px] text-ink-faint">
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
                        暂不支持
                      </Button>
                      <span className="text-[11px] text-ink-faint">当前版本仅接入 DSH</span>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {detectError && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
          {detectError}
        </p>
      )}

      {/* 已配置运行时 */}
      <Panel className="flex animate-rise flex-col gap-3 p-5 [animation-delay:80ms]">
        <div className="flex items-center gap-2">
          <ListIcon className="text-ink-dim" />
          <h3 className="text-[13px] font-medium tracking-wide text-ink">已配置运行时</h3>
          <span className={cn(badgeCls)}>{items.length}</span>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="ml-auto"
            onClick={() => setDialog({ runtime: null, initial: newRuntimeInput() })}
          >
            新建运行时
          </Button>
        </div>

        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {items.length === 0 && (
            <li className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
              暂无运行时
            </li>
          )}
          {items.map((r) => {
            const status = statuses[r.id]
            const running = status?.workload.running ?? 0
            const maxConcurrent = status?.workload.maxConcurrent ?? r.maxConcurrent
            const queued = status?.workload.queued ?? 0
            const probing = probingId === r.id
            const probe = r.lastProbe
            const showDetails = expandedProbeId === r.id && probe?.state === 'unavailable'
            return (
              <li
                key={r.id}
                className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
              >
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-ink-dim">
                  <TerminalIcon />
                </span>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{r.name}</span>
                    <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] tracking-wide text-ink-faint">
                      {r.protocolFamily}
                    </span>
                    <RuntimeStatusBadge
                      probe={probe}
                      testing={probing}
                      expanded={expandedProbeId === r.id}
                      onToggle={() => toggleProbeDetails(r.id)}
                    />
                    {probe?.cliVersion && (
                      <span className="text-[11px] text-ink-faint">CLI v{probe.cliVersion}</span>
                    )}
                    {!r.enabled && (
                      <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-faint">
                        已停用
                      </span>
                    )}
                  </div>

                  <span className="truncate font-mono text-[11px] text-ink-dim">
                    {r.command} --profile {r.profile} --stdio
                  </span>

                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
                    <span className="truncate font-mono" title={probe?.path ?? undefined}>
                      {probe?.path ?? '未解析到可执行文件'}
                    </span>
                    <span className="tabular-nums">
                      负载 {running}/{maxConcurrent}
                    </span>
                    {queued > 0 && (
                      <span className="text-amber-300 tabular-nums">排队 {queued}</span>
                    )}
                  </span>

                  {showDetails && (
                    <div className="flex flex-col gap-1 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-2.5 py-2">
                      <p className="text-[11px] text-red-300">{probe?.error ?? '未知错误'}</p>
                      {probe?.output && (
                        <pre className="max-h-32 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-ink-faint">
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-red-400 hover:text-red-300"
                    aria-label={`删除运行时 ${r.name}`}
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
