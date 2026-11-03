import { useEffect, useState, type ReactElement } from 'react'
import type { Runtime } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/cn'
import { wfApi } from '../api'

const panelCls =
  'rounded-2xl border border-line bg-white/[0.03] backdrop-blur-xl shadow-[0_1px_0_rgb(255_255_255/5%)_inset,0_20px_50px_-30px_rgb(0_0_0/70%)]'
const inputCls =
  'h-9 w-full rounded-lg border border-line bg-black/25 px-3 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors duration-200 hover:border-line-strong focus:border-focus/70 focus:bg-black/35'
const labelCls = 'text-[11px] font-medium tracking-wide text-ink-faint'
const badgeCls = 'rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[11px] tabular-nums text-ink-dim'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function parseArgs(text: string): string[] {
  const t = text.trim()
  return t ? t.split(/\s+/) : []
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

export function RuntimeManager(): ReactElement {
  const [items, setItems] = useState<Runtime[]>([])
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('dsh')
  const [argsText, setArgsText] = useState('')
  const [promptMode, setPromptMode] = useState<'arg' | 'stdin'>('arg')
  const [workdir, setWorkdir] = useState('')

  const reload = async (): Promise<void> => {
    try {
      setItems(await wfApi().runtimes.list())
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }
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

  return (
    <div className="flex flex-col gap-4">
      {/* 新增运行时 */}
      <form className={cn(panelCls, 'flex animate-rise flex-col gap-4 p-5')} onSubmit={submit}>
        <div className="flex items-center gap-2">
          <TerminalIcon className="text-focus" />
          <h3 className="text-[13px] font-medium tracking-wide text-ink">新增运行时</h3>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>名称</span>
            <input
              aria-label="运行时名称"
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>命令</span>
            <input
              aria-label="运行时命令"
              className={inputCls}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>prompt 传递</span>
            <select
              aria-label="prompt 传递方式"
              className={inputCls}
              value={promptMode}
              onChange={(e) => setPromptMode(e.target.value as 'arg' | 'stdin')}
            >
              <option value="arg">参数</option>
              <option value="stdin">标准输入</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={labelCls}>参数（空格分隔，可用 {'{prompt}'}）</span>
            <input
              aria-label="运行时参数"
              className={cn(inputCls, 'font-mono')}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>工作目录（可选）</span>
            <input
              aria-label="运行时工作目录"
              className={cn(inputCls, 'font-mono')}
              value={workdir}
              onChange={(e) => setWorkdir(e.target.value)}
            />
          </label>
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
      <section
        className={cn(panelCls, 'flex animate-rise flex-col gap-3 p-5 [animation-delay:80ms]')}
      >
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
      </section>
    </div>
  )
}
