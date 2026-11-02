import { useEffect, useState, type ReactElement } from 'react'
import type { Runtime } from '../../../../../shared/ai-workflow-api'
import { wfApi } from '../api'

const inputCls =
  'rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-sm text-ink outline-none focus:border-focus'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function parseArgs(text: string): string[] {
  const t = text.trim()
  return t ? t.split(/\s+/) : []
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
    <div className="flex flex-col gap-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          名称
          <input
            aria-label="运行时名称"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          命令
          <input
            aria-label="运行时命令"
            className={inputCls}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          参数（空格分隔，可用 {'{prompt}'}）
          <input
            aria-label="运行时参数"
            className={inputCls}
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          prompt 传递
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
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          工作目录（可选）
          <input
            aria-label="运行时工作目录"
            className={inputCls}
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-focus/15 px-3 py-1.5 text-sm text-focus hover:bg-focus/25"
        >
          添加运行时
        </button>
      </form>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {items.length === 0 && <li className="px-3 py-2 text-xs text-ink-faint">暂无运行时</li>}
        {items.map((r) => (
          <li key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <span className="flex flex-col">
              <span className="font-medium text-ink">{r.name}</span>
              <span className="text-xs text-ink-faint">
                {r.command} {r.args.join(' ')} · {r.promptMode}
              </span>
            </span>
            <button
              type="button"
              className="text-xs text-red-400 hover:underline"
              onClick={() => void remove(r.id)}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
