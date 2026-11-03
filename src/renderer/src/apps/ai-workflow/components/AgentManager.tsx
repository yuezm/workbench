import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  Agent,
  AgentInput,
  AiWorkflowApi,
  Runtime,
} from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { Panel, badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { wfApi } from '../api'
import { AgentDialog } from './AgentDialog'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 订阅 ai-workflow 变更事件；注入的 api 可能没有 onChanged（测试桩） */
function subscribe(cb: () => void): () => void {
  const onChanged = (wfApi() as Partial<AiWorkflowApi>).onChanged
  return onChanged ? onChanged(cb) : () => {}
}

function RobotIcon({ className }: { className?: string }): ReactElement {
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
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4.5" />
      <path d="M9 14h.01M15 14h.01" />
      <path d="M9.5 17.5h5" />
    </svg>
  )
}

/** 智能体页：智能体清单；新建走弹窗表单 */
export function AgentManager(): ReactElement {
  const [agents, setAgents] = useState<Agent[]>([])
  const [runtimes, setRuntimes] = useState<Runtime[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 非空 = 弹窗打开中，值为表单预填 */
  const [draft, setDraft] = useState<AgentInput | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [a, r] = await Promise.all([wfApi().agents.list(), wfApi().runtimes.list()])
      setAgents(a)
      setRuntimes(r)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [a, r] = await Promise.all([wfApi().agents.list(), wfApi().runtimes.list()])
        if (!alive) return
        setAgents(a)
        setRuntimes(r)
      } catch (e) {
        if (alive) setError(errMsg(e))
      }
    })()
    // 运行时是本表单的上游：新增/删除运行时后要同步「绑定运行时」下拉
    const off = subscribe(() => {
      if (alive) void refresh()
    })
    return () => {
      alive = false
      off()
    }
  }, [refresh])

  const create = async (input: AgentInput): Promise<void> => {
    await wfApi().agents.create(input)
    setDraft(null)
    await refresh()
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await wfApi().agents.remove(id)
      await refresh()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const runtimeName = (id: string): string => runtimes.find((r) => r.id === id)?.name ?? id

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* 已配置智能体 */}
      <Panel className="flex animate-rise flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <RobotIcon className="text-focus" />
          <h3 className="text-[13px] font-medium tracking-wide text-ink">已配置智能体</h3>
          <span className={cn(badgeCls)}>{agents.length}</span>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="ml-auto"
            onClick={() =>
              setDraft({
                name: '',
                description: '',
                runtimeId: runtimes[0]?.id ?? '',
                systemPrompt: '',
              })
            }
          >
            新建智能体
          </Button>
        </div>

        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {agents.length === 0 && (
            <li className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
              暂无智能体
            </li>
          )}
          {agents.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-ink-dim">
                <RobotIcon />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-ink">{a.name}</span>
                <span className="truncate text-[11px] text-ink-faint">
                  {runtimeName(a.runtimeId)}
                  {a.description ? ` · ${a.description}` : ''}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300"
                onClick={() => void remove(a.id)}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
      </Panel>

      {draft !== null && (
        <AgentDialog
          runtimes={runtimes}
          initial={draft}
          onSubmit={create}
          onCancel={() => setDraft(null)}
        />
      )}
    </div>
  )
}
