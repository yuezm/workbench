import { useState, type ReactElement } from 'react'
import {
  stageKindOf,
  type EntryMode,
  type OnChildrenSettled,
  type SpawnPolicy,
  type StageInput,
  type WorkflowInput,
  type WorkflowStage,
  type WorkflowWithStages,
} from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Field } from '../../../components/ui/field'
import { FormError } from '../../../components/ui/form-error'
import { Input } from '../../../components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import { cn } from '../../../lib/cn'
import { useKernelView } from '../../../shell/useKernelView'
import { STAGE_KIND_META } from '../model/stage-kinds'
import {
  dropStageIndexes,
  emptyStage,
  firstUserStageIndex,
  insertUserStage,
  isTerminalStage,
  nextUserStageName,
  userStageRange,
  withBuiltinStages,
} from '../model/stage-draft'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface WorkflowEditorProps {
  workflow: WorkflowWithStages | null
  /** 预填草稿（从 SOP 模板新建时用）；给了就以它为准，忽略 `workflow` 的推导 */
  initial?: WorkflowInput | null
  onSave: (input: WorkflowInput) => Promise<void>
  onCancel: () => void
}

function indexOfId(workflow: WorkflowWithStages, id: string | null): number {
  if (!id) return -1
  return workflow.stages.findIndex((s) => s.id === id)
}

/**
 * 阶段在编辑器里的「进入方式」：闸门不是独立 `entryMode`，而是 agent 阶段上的一个开关
 * （M11）。UI 上把它单列一项，是为了让人一眼看出这是一道判定关卡。
 *
 * 与协议里的阶段**类别**（`stageKindOf`：未开始 / 进行中 / 已完成 / 已关闭）是两件事，
 * 因此这里叫 `entryKind`——类别决定颜色与位置，进入方式决定进到这一阶段发生什么。
 */
type EntryKind = EntryMode | 'gate'

function entryKindOf(stage: StageInput): EntryKind {
  return stage.gate ? 'gate' : stage.entryMode
}

/**
 * 会派活 / 会判定的阶段（交给智能体、闸门）才展示流转目标与「要干什么」；
 * 不交接与交给用户只留名称与类型：前者没人执行、后者等人处理，这些字段都没有消费者。
 */
function hasFlowDetail(stage: StageInput): boolean {
  const kind = entryKindOf(stage)
  return kind === 'agent' || kind === 'gate'
}

/** 交接与拆子任务只属于真干活的智能体阶段：闸门只判定过没过，不交接、不拆子任务。 */
function hasRelayDetail(stage: StageInput): boolean {
  return entryKindOf(stage) === 'agent'
}

/**
 * 界面上不展示的字段，保存前一概归一——这些字段仍有消费者（交接在任务离开阶段时建关联任务、
 * 子任务落点是派活落点、`agentId` 会参与智能体存在性校验、`onComplete` 会改闸门的默认通过去向），
 * 留着就是看不见的配置。「要干什么」只对派活有意义、且没有副作用，原文保留，切回智能体时还能用。
 */
function pruneByEntryKind(stage: StageInput): StageInput {
  const kind = entryKindOf(stage)
  if (kind === 'agent') return stage
  if (kind === 'gate') {
    return {
      ...stage,
      // 闸门面板里没有「完成 / 出错」两个去向：留着会偷偷改掉「通过时进入」显示为默认时的真实落点
      onCompleteIndex: null,
      onRejectIndex: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
    }
  }
  return {
    id: stage.id,
    name: stage.name,
    entryMode: stage.entryMode,
    builtin: stage.builtin ?? null,
    agentId: null,
    onCompleteIndex: null,
    onRejectIndex: null,
    handoffWorkflowId: null,
    handoffStageId: null,
    subtaskStageId: null,
    onChildrenSettled: null,
    spawnPolicy: null,
    instructions: stage.instructions,
    // M20：验收条目只对派活 / 判定有意义，不展示的类型一并归一掉
    acceptance: [],
    // M21：轮次上限同理，只有会自己跑的阶段才有意义
    maxRounds: null,
    gate: null,
  }
}

/**
 * 保存前的归整：先按进入方式去掉看不见的字段，再按「终态不交接」清掉交接两块。
 *
 * 已完成 / 已取消的交接面板不展示，留着就是看不见的配置；内核也会直接以「不允许交接」拒收，
 * 与其让人对着弹窗里看不到的字段排查，不如在这里归一。
 */
function pruneStage(stage: StageInput): StageInput {
  const pruned = pruneByEntryKind(stage)
  if (!isTerminalStage(stage)) return pruned
  return { ...pruned, handoffWorkflowId: null, handoffStageId: null }
}

/** 下标型流转目标是否越界：越界说明它指向的阶段已被删掉 */
function outOfRange(index: number | null | undefined, count: number): boolean {
  return index != null && (index < 0 || index >= count)
}

/** 阶段上是否挂着已失效的流转目标（完成 / 出错 / 闸门两侧任一处） */
function hasDanglingTarget(stage: StageInput, count: number): boolean {
  return (
    outOfRange(stage.onCompleteIndex, count) ||
    outOfRange(stage.onRejectIndex, count) ||
    outOfRange(stage.gate?.onPassIndex, count) ||
    outOfRange(stage.gate?.onFailIndex, count)
  )
}

/**
 * 下拉框的取值：引用的候选已被删（智能体 / 工作流 / 阶段不在视图里了）时按空值展示。
 *
 * 上游 Select 只认候选里的值，认不到就显示占位文案；这里显式回落成空串，
 * 触发器因此显示占位文案而不是一片空白。
 */
function picked(raw: string | null | undefined, values: readonly string[]): string {
  return raw != null && values.includes(raw) ? raw : ''
}

/**
 * 草稿级校验：只拦「必填没填」与「引用已失效」——这两类能就地指出位置，用户改一下就好。
 * 语义判定（自指、闸门形态、交接目标是否存在、内置阶段的锁定）仍归内核，这里不重写一遍规则。
 */
interface DraftErrors {
  /** 工作流名称 */
  name?: string
  /** 表格级：某阶段的流转目标悬空 */
  form?: string
  /** 出错字段所属阶段的下标：校验失败时自动展开它 */
  stageIndex?: number
  /** 该阶段的名称 */
  stageName?: string
}

function validateDraft(draft: WorkflowInput): DraftErrors {
  const errors: DraftErrors = {}
  if (draft.name.trim() === '') errors.name = '工作流名称必填'
  const count = draft.stages.length

  // 内置阶段的名称由系统锁定（输入框只读），空名只可能出现在自己添加的阶段上
  const unnamed = draft.stages.findIndex((stage) => stage.name.trim() === '')
  if (unnamed >= 0) return { ...errors, stageIndex: unnamed, stageName: '阶段名称必填' }

  const dangling = draft.stages.findIndex((stage) => hasDanglingTarget(stage, count))
  if (dangling >= 0) {
    // 「阶段名称必填」的检查在前：走到这里时所有阶段名都已非空，不需要再兜一个「阶段N」
    const label = draft.stages[dangling].name.trim()
    return {
      ...errors,
      stageIndex: dangling,
      form: `「${label}」的流转目标已不在阶段列表里，请重新选择`,
    }
  }
  return errors
}

/**
 * 既有工作流 → 草稿：流转目标按 id 还原成下标，再补出内置阶段并排成规范顺序。
 *
 * `builtin` 键原样回传：内核据此锁名、锁位（老数据里没有这个键时由 `withBuiltinStages`
 * 按内置名认领或补出）。
 */
function toDraft(workflow: WorkflowWithStages | null): WorkflowInput {
  if (!workflow) {
    return {
      name: '',
      description: '',
      stages: withBuiltinStages([]),
    }
  }
  const stages = workflow.stages.map((s) => {
    const oc = indexOfId(workflow, s.onCompleteStageId)
    const rj = indexOfId(workflow, s.onRejectStageId)
    // M11：闸门去向按 id 还原成下标；找不到按 null（默认语义）
    const gp = s.gate ? indexOfId(workflow, s.gate.onPassStageId) : -1
    const gf = s.gate ? indexOfId(workflow, s.gate.onFailStageId) : -1
    return {
      // 回传既有阶段 id：更新时保留历史（否则每次保存都会重建阶段）
      id: s.id,
      name: s.name,
      entryMode: s.entryMode,
      builtin: s.builtin ?? null,
      agentId: s.agentId,
      onCompleteIndex: oc >= 0 ? oc : null,
      onRejectIndex: rj >= 0 ? rj : null,
      handoffWorkflowId: s.handoffWorkflowId,
      handoffStageId: s.handoffStageId,
      subtaskStageId: s.subtaskStageId ?? null,
      onChildrenSettled: s.onChildrenSettled ?? null,
      spawnPolicy: s.spawnPolicy ?? null,
      instructions: s.instructions ?? '',
      acceptance: s.acceptance ?? [],
      maxRounds: s.maxRounds ?? null,
      gate: s.gate
        ? {
            maxFails: s.gate.maxFails,
            onPassIndex: gp >= 0 ? gp : null,
            onFailIndex: gf >= 0 ? gf : null,
          }
        : null,
    }
  })
  return {
    name: workflow.name,
    description: workflow.description,
    stages: withBuiltinStages(stages),
  }
}

/** 阶段重排的结果：重排后的阶段与新的选中下标 */
export interface StageMove {
  stages: StageInput[]
  selected: number
}

/**
 * 上/下移一个自己添加的阶段：目标下标存在 stages 里，重排时要同步重映射，否则流转目标会指错阶段。
 * 选中跟随被移动的那一项；被换位的相邻项若正展开，选中也换到它新的下标。
 *
 * 越界（首行上移 / 末行下移）时原样返回：界面上这两个按钮本来就是禁用的，这里留同一道护栏；
 * 抽成纯函数后，单测可以直接用越界下标覆盖这一支。
 *
 * 内置阶段不由这里管：界面上不给它们上/下移，位置由内核按类别归一。
 */
export function moveStageInList(
  stages: StageInput[],
  selected: number,
  i: number,
  dir: -1 | 1,
): StageMove {
  const j = i + dir
  if (j < 0 || j >= stages.length) return { stages, selected }
  const remap = (idx: number | null | undefined): number | null => {
    if (idx == null) return null
    if (idx === i) return j
    if (dir === -1) return idx >= j && idx < i ? idx + 1 : idx
    return idx > i && idx <= j ? idx - 1 : idx
  }
  const next = stages.map((s) => ({
    ...s,
    onCompleteIndex: remap(s.onCompleteIndex),
    onRejectIndex: remap(s.onRejectIndex),
    // M11：闸门去向也是下标，重排必须同步重映射，否则判定会把任务送错阶段
    gate: s.gate
      ? {
          ...s.gate,
          onPassIndex: remap(s.gate.onPassIndex),
          onFailIndex: remap(s.gate.onFailIndex),
        }
      : null,
  }))
  const [moved] = next.splice(i, 1)
  next.splice(j, 0, moved)
  return {
    stages: next,
    selected: selected === i ? j : selected === j ? i : selected,
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
 *
 * M18：阶段序列恒含四个内置阶段（待办 / 已阻塞 / 已完成 / 已取消）。它们的名称、位置与
 * 类别由系统锁定——名称只读、不给删除、不给移动；其余字段照常可编辑。自己添加的阶段只能
 * 在用户区块里（待办之后、已阻塞之前）增删与排序。
 */
export function WorkflowEditor({
  workflow,
  initial,
  onSave,
  onCancel,
}: WorkflowEditorProps): ReactElement {
  const [draft, setDraft] = useState<WorkflowInput>(() => {
    const seed = initial ?? toDraft(workflow)
    // 预填草稿（模板）与既有工作流都过一遍规范形态：内置阶段补齐、顺序与下标一致
    return { ...seed, stages: withBuiltinStages(seed.stages) }
  })
  const [saving, setSaving] = useState(false)
  /** 校验结果：字段级错误与「目标悬空」这类表格级文案 */
  const [errors, setErrors] = useState<DraftErrors>({})
  /** 保存被宿主拒绝时的原因：就展示在按钮上方，草稿保持原样 */
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** 右侧展开的阶段下标；删除 / 新增后由对应 handler 修正 */
  const [selected, setSelected] = useState(() => firstUserStageIndex(draft.stages))
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

  /** 新阶段落在用户区块末尾（「已阻塞」之前）并直接展开它 */
  const addStage = (): void => {
    const inserted = insertUserStage(draft.stages, emptyStage(nextUserStageName(draft.stages)))
    setDraft((d) => ({ ...d, stages: inserted.stages }))
    setSelected(inserted.index)
  }

  /**
   * 删除一个自己添加的阶段：下标重映射（指向被删阶段的目标清空、后面的整体前移）在纯函数
   * `dropStageIndexes` 里，与保存前的「别处已删掉」过滤共用同一套规则。
   */
  const removeStage = (i: number): void =>
    setDraft((d) => ({ ...d, stages: dropStageIndexes(d.stages, [i]) }))

  /** 删除当前选中阶段：删完把选中落到相邻的一个 */
  const removeSelected = (): void => {
    const i = Math.min(selected, draft.stages.length - 1)
    removeStage(i)
    setSelected(Math.max(0, Math.min(i, draft.stages.length - 2)))
  }

  /**
   * 上/下移一个自己添加的阶段：重排与流转目标的重映射在纯函数里（moveStageInList），
   * 组件只负责把结果落到草稿与选中项上。
   */
  const moveStage = (i: number, dir: -1 | 1): void => {
    const next = moveStageInList(draft.stages, selected, i, dir)
    setDraft((d) => ({ ...d, stages: next.stages }))
    setSelected(next.selected)
  }

  /**
   * 保存：先就地校验（必填 / 悬空目标），再把 trim 过的草稿交给父级。
   *
   * 提交的是**整份阶段定义**（含四个内置阶段与它们的 `builtin` 键、既有 id）：内核据此认出
   * 内置阶段并锁名锁位，自己添加的阶段按 id 差量更新。
   *
   * 父级可能 rethrow（宿主拒收、桥接断开）：必须在这里 catch，否则 async 事件处理器
   * 只会产生一个无人接的拒绝 —— 界面上就是「点了保存什么都没发生」。
   * 失败时草稿原样留着，方便改完再提交。
   */
  const save = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    setSubmitError(null)
    const input: WorkflowInput = {
      ...draft,
      name: draft.name.trim(),
      stages: draft.stages.map((stage) => ({
        ...pruneStage(stage),
        name: stage.name.trim(),
        builtin: stage.builtin ?? null,
      })),
    }
    const next = validateDraft(input)
    setErrors(next)
    if (Object.keys(next).length > 0) {
      // 出错的阶段要顺手展开，不然提示藏在看不见的右侧面板里
      if (next.stageIndex !== undefined) setSelected(next.stageIndex)
      return
    }

    setSaving(true)
    try {
      await onSave(input)
    } catch (e) {
      setSubmitError(`保存失败：${errMsg(e)}`)
    } finally {
      setSaving(false)
    }
  }

  /** 改了哪个字段就撤掉对应的红字：不必等到下一次提交 */
  const clearError = (key: keyof DraftErrors): void =>
    setErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })

  const targetOptions = draft.stages.map((s, i) => ({ i, name: s.name || `阶段${i + 1}` }))
  const index = Math.min(selected, draft.stages.length - 1)
  const stage = draft.stages[index]
  /** 编辑器上的类别（未开始 / 进行中 / 已完成 / 已关闭）与它的配色 */
  const kindMeta = STAGE_KIND_META[stageKindOf(stage)]
  /** 内置阶段：名称 / 位置 / 类别由系统锁定，其它字段照常可编辑 */
  const builtin = stage.builtin != null
  /** 用户区块边界：新增、上移、下移、删除都只在这个区间里发生 */
  const range = userStageRange(draft.stages)
  /** 各下拉框的候选值：取值不在候选里时按空值展示（引用的对象已被删） */
  const targetValues = targetOptions.map((t) => String(t.i))
  const agentIds = agents.map((a) => a.id)
  const handoffWorkflowIds = handoffWorkflows.map((w) => w.id)
  const handoffStageIds =
    stage.handoffWorkflowId == null
      ? []
      : stagesOfWorkflow(stage.handoffWorkflowId).map((s) => s.id)
  const subtaskStageIds = draft.stages.flatMap((s) => (s.id === undefined ? [] : [s.id]))
  /** 当前展开阶段的序号文案（aria-label 用，与阶段列表一致是 1 基） */
  const n = index + 1
  /** 该阶段的字段级错误只在它被展开时展示（错误面板与字段同屏才有意义） */
  const stageErrors = errors.stageIndex === index ? errors : null

  return (
    <form className="flex flex-col gap-5" onSubmit={save}>
      <div className="flex items-center gap-2">
        <WorkflowIcon className="text-brand" />
        <div className="flex flex-col">
          <h3 className="text-base font-medium text-foreground">工作流定义</h3>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="名称" className="w-56" required error={errors.name}>
          <Input
            aria-label="工作流名称"
            value={draft.name}
            onChange={(e) => {
              clearError('name')
              setDraft((d) => ({ ...d, name: e.target.value }))
            }}
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
        {/* 左：阶段序列（序号 + 类别圆点 + 名字，点一条换右侧详情；上移 / 下移就在行尾） */}
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-xs font-medium text-faint-foreground">阶段</span>
          <ul className="flex flex-col gap-1" aria-label="阶段列表">
            {draft.stages.map((s, i) => {
              const isActive = i === index
              /** 内置阶段不给排序入口：位置由系统按类别排定 */
              const movable = s.builtin == null
              return (
                <li key={s.id ?? `new-${i}`} className="group flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`阶段${i + 1}`}
                    aria-current={isActive ? 'true' : undefined}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150 outline-none',
                      'focus-visible:ring-2 focus-visible:ring-ring/60',
                      isActive
                        ? 'bg-primary/15 text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                    onClick={() => setSelected(i)}
                  >
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded-md text-xs font-medium',
                        isActive ? 'bg-primary/25 text-brand' : 'bg-accent text-faint-foreground',
                      )}
                    >
                      {i + 1}
                    </span>
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        STAGE_KIND_META[stageKindOf(s)].dot,
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate">{s.name || `阶段${i + 1}`}</span>
                  </button>

                  {/* 排序按钮：hover / 键盘聚焦 / 当前阶段时显形，免得窄列里一直挂着图标。
                      内置阶段没有这两个按钮（位置锁定），首尾用户阶段各自只能单向移动。 */}
                  {movable && (
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
                        disabled={i <= range.start}
                        className="grid size-5 place-items-center rounded text-faint-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-25"
                        onClick={() => moveStage(i, -1)}
                      >
                        <MoveIcon dir="up" />
                      </button>
                      <button
                        type="button"
                        aria-label={`阶段${i + 1}下移`}
                        title="下移"
                        disabled={i >= range.end - 1}
                        className="grid size-5 place-items-center rounded text-faint-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-25"
                        onClick={() => moveStage(i, 1)}
                      >
                        <MoveIcon dir="down" />
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <Button type="button" variant="secondary" size="sm" onClick={addStage}>
            添加阶段
          </Button>
        </div>

        {/* 右：只展示选中的那个阶段 */}
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-end gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-primary/15 text-xs font-medium text-brand">
              {n}
            </span>
            <Field label="名称" className="min-w-0 flex-1" required error={stageErrors?.stageName}>
              <Input
                aria-label={`阶段${n}名称`}
                value={stage.name}
                // 内置阶段的名称由系统锁定：只读（不是 disabled——值仍要能读、能聚焦、能被读屏取到）
                readOnly={builtin}
                aria-readonly={builtin ? true : undefined}
                onChange={(e) => {
                  clearError('stageName')
                  patchStage(index, { name: e.target.value })
                }}
              />
            </Field>
            <span
              className={cn(
                'mb-1.5 rounded-sm px-1.5 py-0.5 text-xs',
                kindMeta.chip,
                kindMeta.text,
              )}
            >
              {kindMeta.label}
            </span>
            {builtin && (
              <span className="mb-1.5 rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">
                内置
              </span>
            )}
            {!builtin && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={removeSelected}
              >
                删除
              </Button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="类型" className="w-36">
              <Select
                value={entryKindOf(stage)}
                onValueChange={(v) => {
                  // 切到闸门：自动交给智能体并给出默认次数；切走则清掉闸门配置
                  if (v === 'gate') {
                    patchStage(index, {
                      entryMode: 'agent',
                      gate: { maxFails: 3, onPassIndex: null, onFailIndex: null },
                    })
                    return
                  }
                  patchStage(index, { entryMode: v as EntryMode, gate: null })
                }}
              >
                <SelectTrigger aria-label={`阶段${n}类型`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不交接</SelectItem>
                  <SelectItem value="agent">交给智能体</SelectItem>
                  <SelectItem value="gate">闸门（判定）</SelectItem>
                  <SelectItem value="user">交给用户</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {stage.entryMode === 'agent' && (
              <Field label="智能体" className="min-w-0 flex-1">
                <Select
                  value={picked(stage.agentId, agentIds)}
                  onValueChange={(v) => patchStage(index, { agentId: v || null })}
                >
                  <SelectTrigger aria-label={`阶段${n}智能体`} className="w-full">
                    <SelectValue placeholder="选择" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">选择</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>

          {!hasFlowDetail(stage) ? (
            <p className="mt-3 text-xs text-faint-foreground">
              {stage.entryMode === 'user'
                ? '交给用户：任务进到这个阶段就停下来等人处理，不需要智能体、流转目标、交接或子任务。'
                : '不交接：任务进到这个阶段不派活，由你在看板上拖到下一阶段；不需要智能体、流转目标、交接或子任务。'}
            </p>
          ) : stage.gate ? (
            <>
              {/* 闸门：先定次数预算，再定「过 / 没过」两个去向 */}
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="允许未通过" className="w-36">
                  <Select
                    value={String(stage.gate.maxFails)}
                    onValueChange={(v) =>
                      patchStage(index, { gate: { ...stage.gate!, maxFails: Number(v) } })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}闸门次数`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5, 10].map((times) => (
                        <SelectItem key={times} value={String(times)}>
                          {times} 次
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <p className="pb-2 text-xs text-faint-foreground">
                  第 {stage.gate.maxFails} 次仍未通过后放行
                </p>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Field label="通过时进入">
                  <Select
                    value={picked(
                      stage.gate.onPassIndex == null ? '' : String(stage.gate.onPassIndex),
                      targetValues,
                    )}
                    onValueChange={(v) =>
                      patchStage(index, {
                        gate: {
                          ...stage.gate!,
                          onPassIndex: v === '' ? null : Number(v),
                        },
                      })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}闸门通过时进入`} className="w-full">
                      <SelectValue placeholder="下一阶段" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">下一阶段</SelectItem>
                      {targetOptions.map((t) => (
                        <SelectItem key={t.i} value={String(t.i)}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="未通过时进入">
                  <Select
                    value={picked(
                      stage.gate.onFailIndex == null ? '' : String(stage.gate.onFailIndex),
                      targetValues,
                    )}
                    onValueChange={(v) =>
                      patchStage(index, {
                        gate: {
                          ...stage.gate!,
                          onFailIndex: v === '' ? null : Number(v),
                        },
                      })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}闸门未通过时进入`} className="w-full">
                      <SelectValue placeholder="原地不动" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">原地不动</SelectItem>
                      {targetOptions.map((t) => (
                        <SelectItem key={t.i} value={String(t.i)}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <p className="mt-1 text-xs text-faint-foreground">
                智能体跑完要给出「通过 /
                未通过」的判定；拿不出证据时任务停在闸门等人。闸门只判定，不交接、不拆子任务。
              </p>
            </>
          ) : (
            <>
              {/* 完成后 / 出错并排一行，与「类型」分开：目标阶段名再长也不用和智能体抢宽度 */}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Field label="完成后进入">
                  <Select
                    value={picked(
                      stage.onCompleteIndex == null ? '' : String(stage.onCompleteIndex),
                      targetValues,
                    )}
                    onValueChange={(v) =>
                      patchStage(index, { onCompleteIndex: v === '' ? null : Number(v) })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}完成后进入`} className="w-full">
                      <SelectValue placeholder="下一阶段" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">下一阶段</SelectItem>
                      {targetOptions.map((t) => (
                        <SelectItem key={t.i} value={String(t.i)}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="出错时进入">
                  <Select
                    value={picked(
                      stage.onRejectIndex == null ? '' : String(stage.onRejectIndex),
                      targetValues,
                    )}
                    onValueChange={(v) =>
                      patchStage(index, { onRejectIndex: v === '' ? null : Number(v) })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}出错时进入`} className="w-full">
                      <SelectValue placeholder="不指定" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">不指定</SelectItem>
                      {targetOptions.map((t) => (
                        <SelectItem key={t.i} value={String(t.i)}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <p className="mt-1 text-xs text-faint-foreground">
                末阶段完成后任务结束；「出错」指执行器崩溃或超时。
              </p>
            </>
          )}

          {/* 要干什么只对会派活 / 会判定的阶段有意义：不交接、交给用户时不展示 */}
          {hasFlowDetail(stage) && (
            <>
              {/* 阶段要干什么：这段文字会作为提示词的固定指令段交给智能体 */}
              <Field label="要干什么" className="mt-3">
                <Textarea
                  aria-label={`阶段${n}要干什么`}
                  className="min-h-24 resize-y"
                  placeholder={
                    '一句话写目标，别写操作清单。例如：\n### 目标\n让 <功能> 在主干上可运行，默认关闭\n\n### 产出\n- 代码：短分支 → PR\n\n### 边界\n- 不动 <模块>；参考做法（可跳过）：小步提交'
                  }
                  value={stage.instructions ?? ''}
                  onChange={(e) => patchStage(index, { instructions: e.target.value })}
                />
              </Field>

              {/* M20 验收：这条阶段「做完」的可判定口径，一条一行，进提示词带序号 */}
              <Field label="验收（做完的判据，一条一行）" className="mt-3">
                <Textarea
                  aria-label={`阶段${n}验收`}
                  className="min-h-20 resize-y"
                  placeholder={
                    '一条一句、可核对。例如：\n`pnpm check` 退出码 0\n新增测试覆盖每条 Given/When/Then\n不改数据库 schema'
                  }
                  value={(stage.acceptance ?? []).join('\n')}
                  onChange={(e) =>
                    patchStage(index, {
                      acceptance: e.target.value.split('\n'),
                    })
                  }
                />
              </Field>
              {(stage.acceptance ?? []).filter((item) => item.trim() !== '').length === 0 && (
                <p className="mt-1 text-xs text-faint-foreground">
                  没有验收条目时，本阶段跑到「run 正常结束」就算完成——等于让智能体自己说做完了。
                </p>
              )}

              {/* M21：验收未全达时原地续一轮的次数（1 = 不续轮） */}
              {(stage.acceptance ?? []).filter((item) => item.trim() !== '').length > 0 && (
                <Field label="阶段内最多跑几轮" className="mt-3 w-40">
                  <Select
                    value={String(stage.maxRounds ?? 1)}
                    onValueChange={(v) =>
                      patchStage(index, { maxRounds: v === '1' ? null : Number(v) })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}轮次上限`} className="w-full">
                      <SelectValue placeholder="1" />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5].map((round) => (
                        <SelectItem key={round} value={String(round)}>
                          {round === 1 ? '1（不续轮）' : `${round} 轮`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </>
          )}

          {/* 交接与子任务只属于真干活的智能体阶段：闸门只判定，不交接、不拆子任务 */}
          {hasRelayDetail(stage) && (
            <>
              {isTerminalStage(stage) ? (
                // 终态不许交接：内核会拒，界面上也不给这两块，省得配了却存不下去
                <p className="mt-3 border-t border-border pt-3 text-xs text-faint-foreground">
                  已完成 / 已取消是终态，不交接。
                </p>
              ) : (
                <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
                  <Field label="目标工作流" className="min-w-0 flex-1">
                    <Select
                      value={picked(stage.handoffWorkflowId, handoffWorkflowIds)}
                      onValueChange={(v) =>
                        patchStage(index, {
                          handoffWorkflowId: v === '' ? null : v,
                          handoffStageId: null,
                        })
                      }
                    >
                      <SelectTrigger aria-label={`阶段${n}交接目标工作流`} className="w-full">
                        <SelectValue placeholder="不交接" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">不交接</SelectItem>
                        {handoffWorkflows.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {stage.handoffWorkflowId != null && (
                    <Field label="目标阶段" className="min-w-0 flex-1">
                      <Select
                        value={picked(stage.handoffStageId, handoffStageIds)}
                        onValueChange={(v) =>
                          patchStage(index, { handoffStageId: v === '' ? null : v })
                        }
                      >
                        <SelectTrigger aria-label={`阶段${n}交接目标阶段`} className="w-full">
                          <SelectValue placeholder="首阶段" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">首阶段</SelectItem>
                          {stagesOfWorkflow(stage.handoffWorkflowId).map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                  <p className="w-full text-xs text-faint-foreground">
                    完成后在目标工作流建关联任务。
                  </p>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
                <Field label="子任务落点阶段" className="min-w-0 flex-1">
                  <Select
                    value={picked(stage.subtaskStageId, subtaskStageIds)}
                    onValueChange={(v) =>
                      patchStage(index, { subtaskStageId: v === '' ? null : v })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}子任务落点阶段`} className="w-full">
                      <SelectValue placeholder="跟随当前阶段" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">跟随当前阶段</SelectItem>
                      {/* 候选跟着草稿走：改过的阶段名立刻反映，不用等保存后再打开 */}
                      {draft.stages.map((item, i) =>
                        item.id === undefined ? null : (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name || `阶段${i + 1}`}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="子任务完成后" className="min-w-0 flex-1">
                  <Select
                    value={stage.onChildrenSettled ?? ''}
                    onValueChange={(v) =>
                      patchStage(index, {
                        onChildrenSettled: v === '' ? null : (v as OnChildrenSettled),
                      })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}子任务完成后`} className="w-full">
                      <SelectValue placeholder="按阶段推断" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">按阶段推断</SelectItem>
                      <SelectItem value="wake">唤醒父 Agent</SelectItem>
                      <SelectItem value="notify">仅通知</SelectItem>
                      <SelectItem value="complete">完成父任务</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="允许拆子任务" className="min-w-0 flex-1">
                  <Select
                    value={stage.spawnPolicy ?? ''}
                    onValueChange={(v) =>
                      patchStage(index, { spawnPolicy: v === '' ? null : (v as SpawnPolicy) })
                    }
                  >
                    <SelectTrigger aria-label={`阶段${n}允许拆子任务`} className="w-full">
                      <SelectValue placeholder="允许" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">允许</SelectItem>
                      <SelectItem value="off">禁止</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 悬空目标属于某个阶段：错误条跟着它所在的面板走，而不是只剩页脚一句 */}
      {stageErrors?.form !== undefined && <FormError message={stageErrors.form} />}
      {/* 保存被拒：表格级原因贴在提交按钮上方（阶段面板没展示时兜底） */}
      {errors.form !== undefined && stageErrors?.form === undefined && (
        <FormError message={errors.form} />
      )}
      <FormError message={submitError} />

      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button type="submit" variant="default" size="sm" disabled={saving} className="ml-auto">
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  )
}
