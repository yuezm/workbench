import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  AiWorkflowApi,
  DetectedRuntime,
  Runtime,
  RuntimeInput,
  RuntimeTestResult,
} from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { Panel, badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { wfApi } from '../api'
import { RuntimeDialog } from './RuntimeDialog'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 检测接口可能不存在（测试桩 / 旧 preload）：缺失时返回空清单 */
function detectRuntimes(): Promise<DetectedRuntime[]> {
  const fn = (wfApi().runtimes as Partial<AiWorkflowApi['runtimes']>).detect
  return fn ? fn() : Promise.resolve([])
}

/** 连通性测试接口同理；缺失时显式失败，由行内结果展示 */
async function testRuntime(id: string): Promise<RuntimeTestResult> {
  const fn = (wfApi().runtimes as Partial<AiWorkflowApi['runtimes']>).test
  if (!fn) throw new Error('当前 preload 不支持连通性测试')
  return fn(id)
}

/** 只保留仍在清单里的运行时结果（删除条目后不残留旧结论） */
function keepResults(
  prev: Record<string, RuntimeTestResult>,
  list: Runtime[],
): Record<string, RuntimeTestResult> {
  const ids = new Set(list.map((r) => r.id))
  return Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)))
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

/** 运行时页：检测清单 + 已配置清单；新建走弹窗表单 */
export function RuntimeManager(): ReactElement {
  const [items, setItems] = useState<Runtime[]>([])
  const [detected, setDetected] = useState<DetectedRuntime[]>([])
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 非空 = 弹窗打开中，值为表单预填 */
  const [draft, setDraft] = useState<RuntimeInput | null>(null)
  /** 正在测试的运行时 id（各行的按钮状态互相独立） */
  const [testingId, setTestingId] = useState<string | null>(null)
  /** 各运行时最近一次连通性测试结果，按 id 记住 */
  const [testResults, setTestResults] = useState<Record<string, RuntimeTestResult>>({})

  const reload = useCallback(async (): Promise<void> => {
    try {
      const list = await wfApi().runtimes.list()
      setItems(list)
      setTestResults((prev) => keepResults(prev, list))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  const scan = useCallback(async (): Promise<void> => {
    setDetecting(true)
    try {
      setDetected(await detectRuntimes())
      // 重新扫描后旧的连通性结论可能已过期，统一清掉
      setTestResults({})
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setDetecting(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await wfApi().runtimes.list()
        if (alive) setItems(list)
      } catch (e) {
        if (alive) setError(errMsg(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 进入该页即自动识别本机已安装的 CLI
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await detectRuntimes()
        if (alive) setDetected(list)
      } catch (e) {
        if (alive) setError(errMsg(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const create = async (input: RuntimeInput): Promise<void> => {
    await wfApi().runtimes.create(input)
    setDraft(null)
    await reload()
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await wfApi().runtimes.remove(id)
      await reload()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  /**
   * 连通性测试：只影响该行的行内结果，不阻塞整页、不写页面级 error。
   * 失败（含 preload 缺接口）同样落成该行的失败结论。
   */
  const runTest = async (id: string): Promise<void> => {
    setTestingId(id)
    try {
      const result = await testRuntime(id)
      setTestResults((prev) => ({ ...prev, [id]: result }))
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, code: null, elapsedMs: 0, output: '', error: errMsg(e) },
      }))
    } finally {
      setTestingId(null)
    }
  }

  /** 把检测到的 CLI 预填进弹窗表单；名称与既有运行时冲突时加命令后缀 */
  const prefill = (d: DetectedRuntime): void => {
    const taken = items.some((r) => r.name === d.label)
    setDraft({
      name: taken ? `${d.label} (${d.command})` : d.label,
      command: d.command,
      args: [],
      promptMode: 'arg',
      workdir: null,
    })
  }

  const addedCommands = new Set(items.map((r) => r.command))

  return (
    <div className="flex flex-col gap-4">
      {/* 自动识别本机已安装的运行时 */}
      <Panel className="flex animate-rise flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <ScanIcon className="text-focus" />
          <h3 className="text-[13px] font-medium tracking-wide text-ink">已安装的运行时</h3>
          <span className={cn(badgeCls, 'ml-auto')}>{detected.length}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={detecting}
            onClick={() => void scan()}
          >
            {detecting ? '扫描中…' : '重新扫描'}
          </Button>
        </div>

        {detected.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-4 text-xs text-ink-faint">
            {detecting
              ? '正在扫描本机 PATH…'
              : '未检测到已安装的 CLI（dsh / claude / codex / gemini / opencode 等），可在下方手动填写命令。'}
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {detected.map((d) => {
              const added = addedCommands.has(d.command)
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
                  ) : (
                    <Button type="button" variant="secondary" size="sm" onClick={() => prefill(d)}>
                      使用
                    </Button>
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

      {/* 已有运行时 */}
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
            onClick={() =>
              setDraft({ name: '', command: 'dsh', args: [], promptMode: 'arg', workdir: null })
            }
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
            const testing = testingId === r.id
            const result = testResults[r.id]
            return (
              <li
                key={r.id}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-ink-dim">
                  <TerminalIcon />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-ink">{r.name}</span>
                  <span className="truncate font-mono text-[11px] text-ink-faint">
                    {r.command} {r.args.join(' ')} · {r.promptMode}
                  </span>
                </span>
                {result && !testing && (
                  <span
                    // 输出尾部放进 title，失败时便于直接排查 stderr
                    title={result.output}
                    className={cn(
                      'max-w-56 shrink-0 truncate rounded-full px-2 py-1 text-[11px] tabular-nums',
                      result.ok
                        ? 'bg-emerald-400/10 text-emerald-300'
                        : 'bg-red-400/10 text-red-300',
                    )}
                  >
                    {result.ok
                      ? `连通 · ${result.elapsedMs}ms`
                      : `失败：${result.error ?? '未知错误'}`}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`测试运行时 ${r.name}`}
                  disabled={testing}
                  onClick={() => void runTest(r.id)}
                >
                  {testing ? '测试中…' : '测试'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-red-400 hover:text-red-300"
                  onClick={() => void remove(r.id)}
                >
                  删除
                </Button>
              </li>
            )
          })}
        </ul>
      </Panel>

      {draft !== null && (
        <RuntimeDialog initial={draft} onSubmit={create} onCancel={() => setDraft(null)} />
      )}
    </div>
  )
}
