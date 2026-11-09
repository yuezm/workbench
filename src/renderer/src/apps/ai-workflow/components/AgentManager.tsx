import { useState, type ReactElement } from 'react'
import type { Agent, AgentInput, Runtime } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { FormError } from '../../../components/ui/form-error'
import { Panel, badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'
import { AgentDialog, RUNTIME_HEALTH_LABEL, runtimeHealth, type RuntimeHealth } from './AgentDialog'

/** 状态点配色：可用绿、不可用红、未检测灰 */
const HEALTH_DOT: Record<RuntimeHealth, string> = {
  ready: 'bg-success',
  unavailable: 'bg-destructive',
  unknown: 'bg-muted-foreground',
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

/** 打开弹窗时记录：编辑目标（null = 新建）与预填值 */
interface DialogState {
  agent: Agent | null
  initial: AgentInput
}

/** 智能体页：智能体清单；新建 / 编辑走同一个弹窗表单 */
export function AgentManager(): ReactElement {
  // 智能体与运行时都来自内核视图：CRUD 成功后由事实批次失效重取，无需手动 refresh
  const agentsState = useKernelViewState('agents.all')
  const runtimesState = useKernelViewState('runtimes.all')
  const agents = agentsState.data ?? []
  const runtimes = runtimesState.data ?? []
  /** 写操作失败（读错误单独展示在动作错误之前） */
  const [actionError, setActionError] = useState<string | null>(null)
  /** 正在删除的智能体 id：删除期间该行按钮禁用并说明原因，避免连点删两次 */
  const [removingId, setRemovingId] = useState<string | null>(null)
  /** 非 null = 弹窗打开中 */
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const readError = agentsState.error ?? runtimesState.error
  const error = actionError ?? readError

  const submit = async (input: AgentInput): Promise<void> => {
    const store = getKernelStore()
    if (dialog?.agent) {
      await store.dispatch({
        type: 'agent.update',
        commandId: '',
        id: dialog.agent.id,
        patch: input,
      })
    } else {
      await store.dispatch({ type: 'agent.create', commandId: '', input })
    }
    setDialog(null)
  }

  const remove = async (id: string): Promise<void> => {
    setRemovingId(id)
    setActionError(null)
    try {
      await getKernelStore().dispatch({ type: 'agent.remove', commandId: '', id })
    } catch (e) {
      setActionError(errMsg(e))
    } finally {
      setRemovingId(null)
    }
  }

  const runtimeOf = (id: string): Runtime | undefined => runtimes.find((r) => r.id === id)
  const runtimeName = (id: string): string => runtimeOf(id)?.name ?? id

  return (
    <div className="flex flex-col gap-4">
      {/* 写命令失败可关掉；读视图失败是持续状态，不给关闭入口 */}
      <FormError
        message={error}
        onDismiss={actionError === null ? undefined : () => setActionError(null)}
      />

      {/* 已配置智能体 */}
      <Panel className="flex animate-rise flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <RobotIcon className="text-brand" />
          <h3 className="text-base font-medium text-foreground">已配置智能体</h3>
          <span className={cn(badgeCls)}>{agents.length}</span>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="ml-auto"
            onClick={() =>
              setDialog({
                agent: null,
                initial: {
                  name: '',
                  description: '',
                  runtimeId: runtimes[0]?.id ?? '',
                  systemPrompt: '',
                },
              })
            }
          >
            新建智能体
          </Button>
        </div>

        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {agents.length === 0 && (
            <li className="grid place-items-center rounded-xl border border-dashed border-border py-6 text-sm text-faint-foreground">
              暂无智能体
            </li>
          )}
          {agents.map((a) => {
            const runtime = runtimeOf(a.runtimeId)
            const health: RuntimeHealth = runtime ? runtimeHealth(runtime) : 'unknown'
            return (
              <li
                key={a.id}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-muted-foreground">
                  <RobotIcon />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">{a.name}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-faint-foreground">
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
                  aria-label={`编辑智能体 ${a.name}`}
                  onClick={() =>
                    setDialog({
                      agent: a,
                      initial: {
                        name: a.name,
                        description: a.description,
                        runtimeId: a.runtimeId,
                        systemPrompt: a.systemPrompt,
                      },
                    })
                  }
                >
                  编辑
                </Button>
                {/* 删除进行中给可见状态：按钮变灰本身不解释原因 */}
                {removingId === a.id && (
                  <span className="text-xs text-faint-foreground">删除中…</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`删除智能体 ${a.name}`}
                  disabled={removingId === a.id}
                  onClick={() => void remove(a.id)}
                >
                  删除
                </Button>
              </li>
            )
          })}
        </ul>
      </Panel>

      {dialog !== null && (
        <AgentDialog
          runtimes={runtimes}
          initial={dialog.initial}
          mode={dialog.agent ? 'edit' : 'create'}
          onSubmit={submit}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}
