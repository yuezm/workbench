import { useState, type ReactElement } from 'react'
import type {
  EntryMode,
  OnChildrenSettled,
  SpawnPolicy,
  StageInput,
  WorkflowInput,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Field } from '../../../components/ui/field'
import { Input, fieldCls } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'
import { useKernelView } from '../../../shell/useKernelView'

interface WorkflowEditorProps {
  workflow: WorkflowWithStages | null
  onSave: (input: WorkflowInput) => Promise<void>
  onCancel: () => void
}

function indexOfId(workflow: WorkflowWithStages, id: string | null): number {
  if (!id) return -1
  return workflow.stages.findIndex((s) => s.id === id)
}

/** 新阶段的默认值（新建工作流 / 添加阶段共用） */
function emptyStage(name: string): StageInput {
  return {
    name,
    entryMode: 'none',
    onCompleteIndex: null,
    onRejectIndex: null,
    handoffWorkflowId: null,
    handoffStageId: null,
    subtaskStageId: null,
    onChildrenSettled: null,
    spawnPolicy: null,
    instructions: '',
  }
}

function toDraft(workflow: WorkflowWithStages | null): WorkflowInput {
  if (!workflow) {
    return {
      name: '',
      description: '',
      stages: [emptyStage('待办')],
    }
  }
  return {
    name: workflow.name,
    description: workflow.description,
    stages: workflow.stages.map((s) => {
      const oc = indexOfId(workflow, s.onCompleteStageId)
      const rj = indexOfId(workflow, s.onRejectStageId)
      return {
        // 回传既有阶段 id：更新时保留历史（否则每次保存都会重建阶段）
        id: s.id,
        name: s.name,
        entryMode: s.entryMode,
        agentId: s.agentId,
        onCompleteIndex: oc >= 0 ? oc : null,
        onRejectIndex: rj >= 0 ? rj : null,
        handoffWorkflowId: s.handoffWorkflowId,
        handoffStageId: s.handoffStageId,
        subtaskStageId: s.subtaskStageId ?? null,
        onChildrenSettled: s.onChildrenSettled ?? null,
        spawnPolicy: s.spawnPolicy ?? null,
        instructions: s.instructions ?? '',
      }
    }),
  }
}

function WorkflowIcon({ className }: { className?: string }): ReactElement {
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
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 8.2v7.6" />
      <path d="M8.2 6h3.3a3.9 3.9 0 0 1 4.3 3.9" />
    </svg>
  )
}

function MoveIcon({ dir }: { dir: 'up' | 'down' }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {dir === 'up' ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}
    </svg>
  )
}

/**
 * 工作流编辑器：左侧阶段序列，右侧只展开**当前选中的那一个阶段**。
 *
 * 阶段多的时候一屏铺满所有详情既读不下也改不动，所以详情按选中收敛；
 * 上移 / 下移 / 删除作用在选中阶段上，保存仍提交整份定义（阶段 id 稳定）。
 * 每个阶段都能写「要干什么」：这段文字会拼进进入该阶段的任务提示词交给智能体。
 */
export function WorkflowEditor({ workflow, onSave, onCancel }: WorkflowEditorProps): ReactElement {
  const [draft, setDraft] = useState<WorkflowInput>(() => toDraft(workflow))
  const [saving, setSaving] = useState(false)
  /** 右侧展开的阶段下标；删除 / 新增后由对应 handler 修正 */
  const [selected, setSelected] = useState(0)
  // 阶段绑定的智能体清单：自己订阅视图，不再由页面传入
  const agents = useKernelView('agents.all') ?? []
  // 交接目标候选：全部工作流里排除当前工作流（内核保存时还会再校验一次）
  const workflows = useKernelView('workflows.all') ?? []
  const handoffWorkflows = workflows.filter((item) => item.id !== workflow?.id)
  /** 交接目标阶段的候选：只取目标工作流自己的阶段 */
  const stagesOfWorkflow = (workflowId: string): WorkflowStage[] =>
    workflows.find((item) => item.id === workflowId)?.stages ?? []

  const patchStage = (i: number, patch: Partial<StageInput>): void =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s, k) => (k === i ? { ...s, ...patch } : s)) }))

  const addStage = (): void => {
    // 新阶段追加到末尾并直接展开它（`draft` 是本次渲染的快照，长度即新下标）
    setDraft((d) => ({ ...d, stages: [...d.stages, emptyStage(`阶段${d.stages.length + 1}`)] }))
    setSelected(draft.stages.length)
  }

  const removeStage = (i: number): void =>
    setDraft((d) => ({ ...d, stages: d.stages.filter((_, k) => k !== i) }))

  /** 删除当前选中阶段：删完把选中落到相邻的一个（没有阶段时归零） */
  const removeSelected = (): void => {
    const i = Math.min(selected, draft.stages.length - 1)
    removeStage(i)
    setSelected(Math.max(0, Math.min(i, draft.stages.length - 2)))
  }

  /**
   * 上/下移一个阶段：目标下标存在 stages 里，重排时要同步重映射，否则流转目标会指错阶段。
   * 选中跟随被移动的那一项；被换位的相邻项若正展开，选中也换到它新的下标。
   */
  const moveStage = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= draft.stages.length) return
    setDraft((d) => {
      const remap = (idx: number | null | undefined): number | null => {
        if (idx == null) return null
        if (idx === i) return j
        if (dir === -1) return idx >= j && idx < i ? idx + 1 : idx
        return idx > i && idx <= j ? idx - 1 : idx
      }
      const stages = d.stages.map((s) => ({
        ...s,
        onCompleteIndex: remap(s.onCompleteIndex),
        onRejectIndex: remap(s.onRejectIndex),
      }))
      const [moved] = stages.splice(i, 1)
      stages.splice(j, 0, moved)
      return { ...d, stages }
    })
    setSelected((current) => (current === i ? j : current === j ? i : current))
  }

  const save = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  const targetOptions = draft.stages.map((s, i) => ({ i, name: s.name || `阶段${i + 1}` }))
  const index = Math.min(selected, draft.stages.length - 1)
  const stage = draft.stages[index]
  /** 当前展开阶段的序号文案（aria-label 用，与阶段列表一致是 1 基） */
  const n = index + 1

  return (
    <form className="flex flex-col gap-5" onSubmit={save}>
      <div className="flex items-center gap-2">
        <WorkflowIcon className="text-focus-soft" />
        <div className="flex flex-col">
          <h3 className="text-[13px] font-medium tracking-wide text-ink">工作流定义</h3>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="名称" className="w-56">
          <Input
            aria-label="工作流名称"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
        <Field label="描述" className="min-w-0 flex-1">
          <Input
            aria-label="工作流描述"
            value={draft.description ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
        {/* 左：阶段序列（序号 + 名字，点一条换右侧详情；上移 / 下移就在行尾） */}
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-[11px] font-medium tracking-wide text-ink-faint">阶段</span>
          <ul className="flex flex-col gap-1" aria-label="阶段列表">
            {draft.stages.map((s, i) => {
              const isActive = i === index
              return (
                <li key={s.id ?? `new-${i}`} className="group flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`阶段${i + 1}`}
                    aria-current={isActive ? 'true' : undefined}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors duration-150 outline-none',
                      'focus-visible:ring-2 focus-visible:ring-focus/60',
                      isActive
                        ? 'bg-focus/15 text-ink'
                        : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink',
                    )}
                    onClick={() => setSelected(i)}
                  >
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-medium',
                        isActive ? 'bg-focus/25 text-focus-soft' : 'bg-white/[0.05] text-ink-faint',
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="truncate">{s.name || `阶段${i + 1}`}</span>
                  </button>

                  {/* 排序按钮：hover / 键盘聚焦 / 当前阶段时显形，免得窄列里一直挂着图标 */}
                  <div
                    className={cn(
                      'flex shrink-0 items-center transition-opacity duration-150',
                      'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
                      isActive && 'opacity-100',
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`阶段${i + 1}上移`}
                      title="上移"
                      disabled={i === 0}
                      className="grid size-5 place-items-center rounded text-ink-faint transition-colors duration-150 outline-none hover:bg-white/[0.08] hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/60 disabled:pointer-events-none disabled:opacity-25"
                      onClick={() => moveStage(i, -1)}
                    >
                      <MoveIcon dir="up" />
                    </button>
                    <button
                      type="button"
                      aria-label={`阶段${i + 1}下移`}
                      title="下移"
                      disabled={i === draft.stages.length - 1}
                      className="grid size-5 place-items-center rounded text-ink-faint transition-colors duration-150 outline-none hover:bg-white/[0.08] hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/60 disabled:pointer-events-none disabled:opacity-25"
                      onClick={() => moveStage(i, 1)}
                    >
                      <MoveIcon dir="down" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          <Button type="button" variant="secondary" size="sm" onClick={addStage}>
            添加阶段
          </Button>
        </div>

        {/* 右：只展示选中的那个阶段 */}
        {stage === undefined ? (
          <p className="grid place-items-center rounded-xl border border-dashed border-line p-6 text-xs text-ink-faint">
            还没有阶段，先「添加阶段」
          </p>
        ) : (
          <div className="rounded-xl border border-line bg-surface p-3">
            <div className="flex items-end gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-focus/15 text-[11px] font-medium text-focus-soft">
                {n}
              </span>
              <Field label="名称" className="min-w-0 flex-1">
                <Input
                  aria-label={`阶段${n}名称`}
                  value={stage.name}
                  onChange={(e) => patchStage(index, { name: e.target.value })}
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300"
                onClick={removeSelected}
              >
                删除
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="进入时" className="w-36">
                <Select
                  ariaLabel={`阶段${n}进入方式`}
                  value={stage.entryMode}
                  onChange={(v) => patchStage(index, { entryMode: v as EntryMode })}
                  options={[
                    { value: 'none', label: '不交接' },
                    { value: 'agent', label: '交给智能体' },
                    { value: 'user', label: '交给用户' },
                  ]}
                />
              </Field>
              {stage.entryMode === 'agent' && (
                <Field label="智能体" className="min-w-0 flex-1">
                  <Select
                    ariaLabel={`阶段${n}智能体`}
                    value={stage.agentId ?? ''}
                    onChange={(v) => patchStage(index, { agentId: v || null })}
                    options={[
                      { value: '', label: '选择' },
                      ...agents.map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </Field>
              )}
            </div>

            {/* 完成后 / 打回并排一行，与「进入时」分开：目标阶段名再长也不用和智能体抢宽度 */}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Field label="完成后进入">
                <Select
                  ariaLabel={`阶段${n}完成后进入`}
                  value={stage.onCompleteIndex == null ? '' : String(stage.onCompleteIndex)}
                  onChange={(v) =>
                    patchStage(index, { onCompleteIndex: v === '' ? null : Number(v) })
                  }
                  options={[
                    { value: '', label: '下一阶段' },
                    ...targetOptions.map((t) => ({ value: String(t.i), label: t.name })),
                  ]}
                />
              </Field>
              <Field label="打回退回到">
                <Select
                  ariaLabel={`阶段${n}打回退回到`}
                  value={stage.onRejectIndex == null ? '' : String(stage.onRejectIndex)}
                  onChange={(v) =>
                    patchStage(index, { onRejectIndex: v === '' ? null : Number(v) })
                  }
                  options={[
                    { value: '', label: '不指定' },
                    ...targetOptions.map((t) => ({ value: String(t.i), label: t.name })),
                  ]}
                />
              </Field>
            </div>
            <p className="mt-1 text-[11px] text-ink-faint">末阶段完成后任务结束。</p>

            {/* 阶段要干什么：这段文字会作为提示词的固定指令段交给智能体 */}
            <Field label="要干什么" className="mt-3">
              <textarea
                aria-label={`阶段${n}要干什么`}
                className={cn(fieldCls, 'min-h-24 resize-y py-2 leading-relaxed')}
                placeholder="写清这个阶段具体要做什么，例如：读需求、出实现方案、列出改动文件；进到本阶段的任务会带上这段说明交给智能体。"
                value={stage.instructions ?? ''}
                onChange={(e) => patchStage(index, { instructions: e.target.value })}
              />
            </Field>

            <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <Field label="目标工作流" className="min-w-0 flex-1">
                <Select
                  ariaLabel={`阶段${n}交接目标工作流`}
                  value={stage.handoffWorkflowId ?? ''}
                  onChange={(v) =>
                    patchStage(index, {
                      handoffWorkflowId: v === '' ? null : v,
                      handoffStageId: null,
                    })
                  }
                  options={[
                    { value: '', label: '不交接' },
                    ...handoffWorkflows.map((item) => ({ value: item.id, label: item.name })),
                  ]}
                />
              </Field>
              {stage.handoffWorkflowId != null && (
                <Field label="目标阶段" className="min-w-0 flex-1">
                  <Select
                    ariaLabel={`阶段${n}交接目标阶段`}
                    value={stage.handoffStageId ?? ''}
                    onChange={(v) => patchStage(index, { handoffStageId: v === '' ? null : v })}
                    options={[
                      { value: '', label: '首阶段' },
                      ...stagesOfWorkflow(stage.handoffWorkflowId).map((item) => ({
                        value: item.id,
                        label: item.name,
                      })),
                    ]}
                  />
                </Field>
              )}
              <p className="w-full text-[11px] text-ink-faint">完成后在目标工作流建关联任务。</p>
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <Field label="子任务落点阶段" className="min-w-0 flex-1">
                <Select
                  ariaLabel={`阶段${n}子任务落点阶段`}
                  value={stage.subtaskStageId ?? ''}
                  onChange={(v) => patchStage(index, { subtaskStageId: v === '' ? null : v })}
                  options={[
                    { value: '', label: '跟随当前阶段' },
                    ...(workflow?.stages ?? []).map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                />
              </Field>
              <Field label="子任务完成后" className="min-w-0 flex-1">
                <Select
                  ariaLabel={`阶段${n}子任务完成后`}
                  value={stage.onChildrenSettled ?? ''}
                  onChange={(v) =>
                    patchStage(index, {
                      onChildrenSettled: v === '' ? null : (v as OnChildrenSettled),
                    })
                  }
                  options={[
                    { value: '', label: '按阶段推断' },
                    { value: 'wake', label: '唤醒父 Agent' },
                    { value: 'notify', label: '仅通知' },
                    { value: 'complete', label: '完成父任务' },
                  ]}
                />
              </Field>
              <Field label="允许拆子任务" className="min-w-0 flex-1">
                <Select
                  ariaLabel={`阶段${n}允许拆子任务`}
                  value={stage.spawnPolicy ?? ''}
                  onChange={(v) =>
                    patchStage(index, { spawnPolicy: v === '' ? null : (v as SpawnPolicy) })
                  }
                  options={[
                    { value: '', label: '允许' },
                    { value: 'off', label: '禁止' },
                  ]}
                />
              </Field>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button type="submit" variant="primary" size="sm" disabled={saving} className="ml-auto">
          保存
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  )
}
