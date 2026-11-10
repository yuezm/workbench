/**
 * 工作流草稿的阶段列表（M18）：内置阶段的补齐、规范排序与插入。
 *
 * 全部是纯函数（不依赖 React、不做 IO）：编辑器只把结果落到草稿上，单测直接比对数组。
 *
 * 不变量：
 * 1. 草稿恒有四个内置阶段，顺序固定：待办 → 自己添加的阶段 → 已阻塞 → 已完成 → 已取消；
 * 2. 内置阶段的名称与位置由系统定，用户阶段的相对顺序由用户定；
 * 3. 草稿里的流转目标（完成 / 出错 / 闸门两侧）都是**本数组的下标**，任何插入 / 排序都要
 *    同步重映射——否则界面上看不出异常，但流转会指到别的阶段。
 *
 * 老数据（M18 之前建的工作流）视图里可能既没有 `builtin` 键、也没有内置阶段：按内核同一
 * 口径「名字恰好叫内置名的阶段认领成内置阶段」，认领不到才补一条无 id 的内置项
 * （保存时由内核分配 id）。
 */
import {
  BUILTIN_STAGE_KEYS,
  BUILTIN_STAGE_NAMES,
  type BuiltinStageKey,
  type StageInput,
} from '../../../../../protocol/entities'

/** 新阶段的默认值（新建工作流 / 添加阶段共用）：进到这个阶段不派活，由人拖着走。 */
export function emptyStage(name: string): StageInput {
  return {
    name,
    entryMode: 'none',
    // 自己添加的阶段恒为 null（内置键由系统给，不给用户填）
    builtin: null,
    onCompleteIndex: null,
    onRejectIndex: null,
    handoffWorkflowId: null,
    handoffStageId: null,
    subtaskStageId: null,
    onChildrenSettled: null,
    spawnPolicy: null,
    instructions: '',
    acceptance: [],
    maxRounds: null,
    gate: null,
  }
}

/** 内置阶段的最小输入：进入时停下，等人手动操作。 */
export function builtinStageDraft(key: BuiltinStageKey): StageInput {
  return { ...emptyStage(BUILTIN_STAGE_NAMES[key]), builtin: key }
}

/** 名称 → 内置键（不是内置名返回 null）。 */
export function builtinKeyOfName(name: string | undefined): BuiltinStageKey | null {
  const trimmed = (name ?? '').trim()
  return BUILTIN_STAGE_KEYS.find((key) => BUILTIN_STAGE_NAMES[key] === trimmed) ?? null
}

/** 自己添加的阶段（`builtin` 为空）；内置阶段恒有键。 */
export function isUserStage(stage: StageInput): boolean {
  return stage.builtin == null
}

/**
 * 终态内置阶段（已完成 / 已取消）：不允许跨工作流交接，面板上不展示交接两块。
 *
 * 只按 `builtin` 判定——类别是按内置键算的，用户阶段永远不是终态。
 */
export function isTerminalStage(stage: StageInput): boolean {
  return stage.builtin === 'done' || stage.builtin === 'cancelled'
}

/**
 * 用户阶段区块的边界 `[start, end)`：`start` 是「待办」之后，`end` 是「已阻塞」之前。
 *
 * 依赖 `withBuiltinStages` 的规范排序，因此不需要回溯查找：「待办」恰好占第 0 位，
 * 用户阶段紧接其后，其余三个内置阶段排在区块之后。
 */
export function userStageRange(stages: readonly StageInput[]): { start: number; end: number } {
  const start = 1
  return { start, end: start + stages.filter(isUserStage).length }
}

/** 默认展开的阶段：第一个自己添加的阶段（模板 / 既有工作流一进来就落在有内容的阶段上）。 */
export function firstUserStageIndex(stages: readonly StageInput[]): number {
  return Math.max(0, stages.findIndex(isUserStage))
}

/**
 * 把草稿阶段规整成规范形态：认领内置阶段、补出缺的内置阶段、按类别排序、重映射下标。
 *
 * 幂等：对已经规范化的列表再跑一次，顺序与字段都不变。
 */
export function withBuiltinStages(stages: readonly StageInput[]): StageInput[] {
  const claimed = new Map<BuiltinStageKey, { draft: StageInput; from: number }>()
  const users: Array<{ draft: StageInput; from: number }> = []
  stages.forEach((stage, from) => {
    const key = stage.builtin ?? builtinKeyOfName(stage.name)
    if (key !== null && !claimed.has(key)) {
      // 认领时保留原对象的一切（id / 智能体 / 闸门…），只补上内置键
      claimed.set(key, { draft: { ...stage, builtin: key }, from })
      return
    }
    users.push({ draft: stage, from })
  })

  const ordered: StageInput[] = []
  /** 旧下标 → 新下标：每个旧阶段都会被放进新数组，所以每个旧下标都有落点 */
  const moved: number[] = []
  const place = (entry: { draft: StageInput; from: number }): void => {
    moved[entry.from] = ordered.length
    ordered.push(entry.draft)
  }
  const take = (key: BuiltinStageKey): void => {
    const entry = claimed.get(key)
    if (entry === undefined) ordered.push(builtinStageDraft(key))
    else place(entry)
  }
  take('todo')
  for (const user of users) place(user)
  take('blocked')
  take('done')
  take('cancelled')

  const target = (index: number | null | undefined): number | null => {
    if (index == null) return null
    // 越界 / 指不到的下标原样留着：保存前的悬空目标校验要能就地指出位置
    if (stages[index] === undefined) return index
    return moved[index]
  }
  return ordered.map((stage) => ({
    ...stage,
    onCompleteIndex: target(stage.onCompleteIndex),
    onRejectIndex: target(stage.onRejectIndex),
    gate: stage.gate
      ? {
          ...stage.gate,
          onPassIndex: target(stage.gate.onPassIndex),
          onFailIndex: target(stage.gate.onFailIndex),
        }
      : null,
  }))
}

/**
 * 删掉若干下标的阶段：指向被删阶段的目标清空，它后面的下标整体前移。
 *
 * 用户点「删除」与保存前丢掉「别处已删掉」的阶段共用这一套重映射——不重映射的话，
 * 界面上看不出任何异常，但流转会静默指到别的阶段。
 */
export function dropStageIndexes(
  stages: readonly StageInput[],
  removed: readonly number[],
): StageInput[] {
  const gone = new Set(removed)
  const target = (index: number | null | undefined): number | null => {
    if (index == null) return null
    if (gone.has(index)) return null
    let shift = 0
    for (const i of gone) if (i < index) shift += 1
    return index - shift
  }
  return stages
    .filter((_, i) => !gone.has(i))
    .map((stage) => ({
      ...stage,
      onCompleteIndex: target(stage.onCompleteIndex),
      onRejectIndex: target(stage.onRejectIndex),
      gate: stage.gate
        ? {
            ...stage.gate,
            onPassIndex: target(stage.gate.onPassIndex),
            onFailIndex: target(stage.gate.onFailIndex),
          }
        : null,
    }))
}

/**
 * 保存前按最新定义过滤：`id` 已经不在库里的阶段（别处删掉了 / 本机迁移脚本改过）直接丢掉。
 *
 * 为什么必须过滤：内核按「回传的 id 必须属于本工作流」严格校验，一个已删 id 就会整份拒收，
 * 界面上只剩一个 uuid，用户只能重启应用——而外部进程直接写库不经过宿主的事实广播，
 * 渲染层的 `workflows.all` 会一直停在旧值，光重开弹窗也不够。
 *
 * `subtaskStageId` 指向被丢掉的阶段时一并清空：内核不校验这一列，留着是看不见的死引用。
 */
export function dropVanishedStages(
  stages: readonly StageInput[],
  liveIds: ReadonlySet<string>,
): StageInput[] {
  const gone = stages.flatMap((stage, i) =>
    stage.id !== undefined && !liveIds.has(stage.id) ? [i] : [],
  )
  if (gone.length === 0) return [...stages]
  return dropStageIndexes(stages, gone).map((stage) =>
    stage.subtaskStageId != null && !liveIds.has(stage.subtaskStageId)
      ? { ...stage, subtaskStageId: null }
      : stage,
  )
}

/** 新阶段插入的位置：「已阻塞」之前 = 用户阶段区块末尾（待办占 1 个位置）。 */
export function insertStageIndex(stages: readonly StageInput[]): number {
  return userStageRange(stages).end
}

/** 添加阶段的默认名称：按自己添加的阶段数编号，不把内置阶段算进去。 */
export function nextUserStageName(stages: readonly StageInput[]): string {
  return `阶段${stages.filter(isUserStage).length + 1}`
}

/** 插入的结果：新列表与新区段的下标（编辑器要顺手展开它） */
export interface StageInsert {
  stages: StageInput[]
  index: number
}

/**
 * 把一个阶段插到用户区块末尾：插入点之后的阶段整体后移一位，指向它们的目标同步 +1。
 *
 * 与上/下移、删除共用同一套「下标重映射」规则：不重映射的话，指向「已阻塞 / 已完成」的
 * 流转会静默差一位。
 */
export function insertUserStage(stages: readonly StageInput[], stage: StageInput): StageInsert {
  const at = insertStageIndex(stages)
  const shift = (index: number | null | undefined): number | null => {
    if (index == null) return null
    return index >= at ? index + 1 : index
  }
  const next: StageInput[] = stages.map((item) => ({
    ...item,
    onCompleteIndex: shift(item.onCompleteIndex),
    onRejectIndex: shift(item.onRejectIndex),
    gate: item.gate
      ? {
          ...item.gate,
          onPassIndex: shift(item.gate.onPassIndex),
          onFailIndex: shift(item.gate.onFailIndex),
        }
      : null,
  }))
  next.splice(at, 0, stage)
  return { stages: next, index: at }
}
