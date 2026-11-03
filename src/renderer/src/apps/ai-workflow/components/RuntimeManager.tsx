import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AiWorkflowApi, DetectedRuntime, Runtime } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { Field } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import { Panel, badgeCls } from '../../../components/ui/panel'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'
import { wfApi } from '../api'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function parseArgs(text: string): string[] {
  const t = text.trim()
  return t ? t.split(/\s+/) : []
}

/** 检测接口可能不存在（测试桩 / 旧 preload）：缺失时返回空清单 */
function detectRuntimes(): Promise<DetectedRuntime[]> {
  const fn = (wfApi().runtimes as Partial<AiWorkflowApi['runtimes']>).detect
  return fn ? fn() : Promise.resolve([])
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

export function RuntimeManager(): ReactElement {
  const [items, setItems] = useState<Runtime[]>([])
  const [detected, setDetected] = useState<DetectedRuntime[]>([])
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('dsh')
  const [argsText, setArgsText] = useState('')
  const [promptMode, setPromptMode] = useState<'arg' | 'stdin'>('arg')
  const [workdir, setWorkdir] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    try {
      setItems(await wfApi().runtimes.list())
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  const scan = useCallback(async (): Promise<void> => {
    setDetecting(true)
    try {
      setDetected(await detectRuntimes())
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

  // 进入设置即自动识别本机已安装的 CLI
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

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    try {
      await wfApi().runtimes.create({
        name,
        command,
        args: parseArgs(argsText),
        promptMode,
        workdir: workdir.trim() || null,
      })
      setName('')
      setArgsText('')
      setWorkdir('')
      await reload()
    } catch (e) {
      setError(errMsg(e))
    }
  }
  const remove = async (id: string): Promise<void> => {
    try {
      await wfApi().runtimes.remove(id)
      await reload()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  /** 把检测到的 CLI 预填进表单；名称与既有运行时冲突时加命令后缀 */
  const prefill = (d: DetectedRuntime): void => {
    const taken = items.some((r) => r.name === d.label)
    setName(taken ? `${d.label} (${d.command})` : d.label)
    setCommand(d.command)
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

      {/* 新增运行时 */}
      <form
        className={cn(
          'flex animate-rise flex-col gap-4 rounded-2xl border border-line bg-white/[0.03] p-5',
          'shadow-[0_1px_0_rgb(255_255_255/5%)_inset,0_20px_50px_-30px_rgb(0_0_0/70%)] backdrop-blur-xl',
          '[animation-delay:80ms]',
        )}
        onSubmit={submit}
      >
        <div className="flex items-center gap-2">
          <TerminalIcon className="text-focus" />
          <h3 className="text-[13px] font-medium tracking-wide text-ink">新增运行时</h3>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="名称">
            <Input aria-label="运行时名称" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="命令">
            <Input
              aria-label="运行时命令"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </Field>
          <Field label="prompt 传递">
            <Select
              ariaLabel="prompt 传递方式"
              value={promptMode}
              onChange={(v) => setPromptMode(v === 'stdin' ? 'stdin' : 'arg')}
              options={[
                { value: 'arg', label: '参数' },
                { value: 'stdin', label: '标准输入' },
              ]}
            />
          </Field>
          <Field label={`参数（空格分隔，可用 {'{prompt}'}）`} className="sm:col-span-2">
            <Input
              aria-label="运行时参数"
              className="font-mono"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
          </Field>
          <Field label="工作目录（可选）">
            <Input
              aria-label="运行时工作目录"
              className="font-mono"
              value={workdir}
              onChange={(e) => setWorkdir(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm">
            添加运行时
          </Button>
        </div>
      </form>

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* 已有运行时 */}
      <Panel className="flex animate-rise flex-col gap-3 p-5 [animation-delay:160ms]">
        <div className="flex items-center gap-2">
          <ListIcon className="text-ink-dim" />
          <h3 className="text-[13px] font-medium tracking-wide text-ink">已配置运行时</h3>
          <span className={cn(badgeCls, 'ml-auto')}>{items.length}</span>
        </div>

        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {items.length === 0 && (
            <li className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
              暂无运行时
            </li>
          )}
          {items.map((r) => (
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
          ))}
        </ul>
      </Panel>
    </div>
  )
}
