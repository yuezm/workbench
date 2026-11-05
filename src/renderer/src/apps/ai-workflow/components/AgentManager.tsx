import { useState, type ReactElement } from 'react'
import type { AgentInput, Runtime } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Panel, badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'
import { AgentDialog, RUNTIME_HEALTH_LABEL, runtimeHealth, type RuntimeHealth } from './AgentDialog'

/** 状态点配色：可用绿、不可用红、未检测灰 */
const HEALTH_DOT: Record<RuntimeHealth, string> = {
  ready: 'bg-emerald-400',
  unavailable: 'bg-red-400',
  unknown: 'bg-white/25',
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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
  // 智能体与运行时都来自内核视图：CRUD 成功后由事实批次失效重取，无需手动 refresh
  const agentsState = useKernelViewState('agents.all')
  const runtimesState = useKernelViewState('runtimes.all')
  const agents = agentsState.data ?? []
  const runtimes = runtimesState.data ?? []
  /** 写操作失败（读错误单独展示在动作错误之前） */
  const [actionError, setActionError] = useState<string | null>(null)
  /** 非空 = 弹窗打开中，值为表单预填 */
  const [draft, setDraft] = useState<AgentInput | null>(null)

  const readError = agentsState.error ?? runtimesState.error
  const error = actionError ?? readError

  const create = async (input: AgentInput): Promise<void> => {
    await getKernelStore().dispatch({ type: 'agent.create', commandId: '', input })
    setDraft(null)
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await getKernelStore().dispatch({ type: 'agent.remove', commandId: '', id })
    } catch (e) {
      setActionError(errMsg(e))
    }
  }

  const runtimeOf = (id: string): Runtime | undefined => runtimes.find((r) => r.id === id)
  const runtimeName = (id: string): string => runtimeOf(id)?.name ?? id

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
          {agents.map((a) => {
            const runtime = runtimeOf(a.runtimeId)
            const health: RuntimeHealth = runtime ? runtimeHealth(runtime) : 'unknown'
            return (
              <li
                key={a.id}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-ink-dim">
                  <RobotIcon />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-ink">{a.name}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
                    <span
                      aria-hidden="true"
                      className={cn('size-1.5 shrink-0 rounded-full', HEALTH_DOT[health])}
                    />
                    <span className="truncate">
                      运行时：{runtimeName(a.runtimeId)} · {RUNTIME_HEALTH_LABEL[health]}
                      {a.description ? ` · ${a.description}` : ''}
                    </span>
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-red-400 hover:text-red-300"
                  aria-label={`删除智能体 ${a.name}`}
                  onClick={() => void remove(a.id)}
                >
                  删除
                </Button>
              </li>
            )
          })}
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
