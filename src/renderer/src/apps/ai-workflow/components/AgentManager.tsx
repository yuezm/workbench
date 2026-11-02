import { useEffect, useState, type ReactElement } from 'react'
import type { Agent, Runtime } from '../../../../../shared/ai-workflow-api'
import { wfApi } from '../api'

const inputCls =
  'rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-sm text-ink outline-none focus:border-focus'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function AgentManager(): ReactElement {
  const [agents, setAgents] = useState<Agent[]>([])
  const [runtimes, setRuntimes] = useState<Runtime[]>([])
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [runtimeId, setRuntimeId] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')

  const reload = async (): Promise<void> => {
    try {
      const [a, r] = await Promise.all([wfApi().agents.list(), wfApi().runtimes.list()])
      setAgents(a)
      setRuntimes(r)
      setRuntimeId((prev) => prev || r[0]?.id || '')
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [a, r] = await Promise.all([wfApi().agents.list(), wfApi().runtimes.list()])
        if (!alive) return
        setAgents(a)
        setRuntimes(r)
        setRuntimeId(r[0]?.id ?? '')
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
      await wfApi().agents.create({ name, description, runtimeId, systemPrompt })
      setName('')
      setDescription('')
      setSystemPrompt('')
      await reload()
    } catch (e) {
      setError(errMsg(e))
    }
  }
  const remove = async (id: string): Promise<void> => {
    try {
      await wfApi().agents.remove(id)
      await reload()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const runtimeName = (id: string): string => runtimes.find((r) => r.id === id)?.name ?? id

  return (
    <div className="flex flex-col gap-3">
      {runtimes.length === 0 && (
        <p className="text-xs text-ink-faint">请先在上方添加一个运行时。</p>
      )}
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          名称
          <input
            aria-label="智能体名称"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          运行时
          <select
            aria-label="智能体运行时"
            className={inputCls}
            value={runtimeId}
            onChange={(e) => setRuntimeId(e.target.value)}
          >
            {runtimes.length === 0 && <option value="">（无）</option>}
            {runtimes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          描述
          <input
            aria-label="智能体描述"
            className={inputCls}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-ink-dim">
          能力（System Prompt）
          <input
            aria-label="智能体能力"
            className={inputCls}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={!runtimeId}
          className="rounded-lg bg-focus/15 px-3 py-1.5 text-sm text-focus hover:bg-focus/25 disabled:opacity-40"
        >
          添加智能体
        </button>
      </form>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {agents.length === 0 && <li className="px-3 py-2 text-xs text-ink-faint">暂无智能体</li>}
        {agents.map((a) => (
          <li key={a.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <span className="flex flex-col">
              <span className="font-medium text-ink">{a.name}</span>
              <span className="text-xs text-ink-faint">
                {runtimeName(a.runtimeId)}
                {a.description ? ` · ${a.description}` : ''}
              </span>
            </span>
            <button
              type="button"
              className="text-xs text-red-400 hover:underline"
              onClick={() => void remove(a.id)}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
