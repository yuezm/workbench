/**
 * 系统内置阶段（M18）：每个工作流恒有「待办 / 已阻塞 / 已完成 / 已取消」四个阶段。
 *
 * 纯函数，只回答三件事：
 * 1. 提交来的阶段里哪些是内置阶段（按 `builtin` 键认；老数据 / 模板只给了名字的按名字认领）；
 * 2. 缺哪些内置阶段（新建补齐默认值，更新按既有行还原——内置阶段因此「删不掉」）；
 * 3. 内置阶段的规范顺序：待办 → 自己添加的阶段 → 已阻塞 → 已完成 → 已取消。
 *
 * 名称、类别与位置是系统锁的；其它字段（进入时交给 / 智能体 / 要干什么 / 闸门 / 流转目标）
 * 与普通阶段一样可改。已完成 / 已取消是终态，不允许再配跨工作流交接。
 */
import {
  BUILTIN_STAGE_KEYS,
  BUILTIN_STAGE_NAMES,
  type BuiltinStageKey,
  type StageInput,
  type WorkflowStage,
} from '../../protocol/entities'

/**
 * 内置阶段的识别结果。
 *
 * `keys[i]` 与提交的阶段一一对应（null = 自己添加的阶段）；`missing` 是需要补建 / 还原的
 * 内置键（新建时是默认值，更新时按既有行还原）。
 */
export interface BuiltinResolution {
  keys: Array<BuiltinStageKey | null>
  missing: BuiltinStageKey[]
  error: string | null
}

/** 内置阶段的最小输入：进入时停下，等人手动操作。 */
export function builtinStageInput(key: BuiltinStageKey): StageInput {
  return {
    name: BUILTIN_STAGE_NAMES[key],
    entryMode: 'none',
    builtin: key,
    agentId: null,
    onCompleteIndex: null,
    onRejectIndex: null,
    handoffs: [],
    subtaskStageId: null,
    onChildrenSettled: null,
    spawnPolicy: null,
    instructions: '',
    acceptance: [],
    maxRounds: null,
    gate: null,
  }
}

/** 名称 → 内置键（不是内置名返回 null）。 */
function builtinKeyOfName(name: string): BuiltinStageKey | null {
  const trimmed = name.trim()
  for (const key of BUILTIN_STAGE_KEYS) {
    if (BUILTIN_STAGE_NAMES[key] === trimmed) return key
  }
  return null
}

const fail = (message: string): BuiltinResolution => ({ keys: [], missing: [], error: message })

/**
 * 识别内置阶段并算出缺哪些。
 *
 * 认领顺序：既有行（按 id，更新时唯一可信的来源）→ 显式 `builtin` 键 → 内置名称。
 * 因此：
 * - 内置阶段改名会被拒（既有行名字对不上、或显式键与名字不符）；
 * - 内置阶段换个 id 重建也会被拒（旧 id 只认自己那个键，其余按缺失还原）；
 * - 老数据 / 模板里叫「待办」「已完成」的阶段按内置阶段认领，不会被当成重名。
 */
export function resolveBuiltinStages(
  inputs: readonly StageInput[],
  existing: readonly WorkflowStage[] | null,
): BuiltinResolution {
  const byId = new Map<string, WorkflowStage>()
  const byBuiltin = new Map<BuiltinStageKey, WorkflowStage>()
  for (const stage of existing ?? []) {
    byId.set(stage.id, stage)
    if (stage.builtin) byBuiltin.set(stage.builtin, stage)
  }

  const keys: Array<BuiltinStageKey | null> = []
  const owner = new Map<BuiltinStageKey, number>()

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]
    const id = input.id?.trim() ?? ''
    const previous = id === '' ? undefined : byId.get(id)
    let key: BuiltinStageKey | null = input.builtin ?? null

    if (previous?.builtin != null) {
      const locked = previous.builtin
      if (key !== null && key !== locked) {
        return fail(`阶段「${previous.name}」是内置阶段，类别不可修改`)
      }
      if (key === null) {
        // 没带标记：名称必须仍是内置名，否则视为改名
        if (builtinKeyOfName(input.name) !== locked) {
          return fail(`内置阶段「${previous.name}」不可改名`)
        }
        key = locked
      }
    } else if (key === null) {
      key = builtinKeyOfName(input.name)
    }

    if (key !== null) {
      const expected = BUILTIN_STAGE_NAMES[key]
      if (input.name.trim() !== expected) {
        return fail(`内置阶段名称固定为「${expected}」`)
      }
      // 已有内置行只能由它自己（按 id）认领：换个 id 重建 = 删除内置阶段；
      // 自己添加的阶段改名撞上内置阶段名则属于重名冲突，提示改名
      const claimed = byBuiltin.get(key)
      if (claimed !== undefined && claimed.id !== id) {
        return fail(
          previous !== undefined && previous.builtin == null
            ? `阶段「${expected}」的名称与内置阶段冲突，请改名`
            : `内置阶段「${expected}」不可删除后重建`,
        )
      }
      const taken = owner.get(key)
      if (taken !== undefined) return fail(`内置阶段「${expected}」重复`)
      owner.set(key, index)
    }
    keys.push(key)
  }

  const missing = BUILTIN_STAGE_KEYS.filter((key) => !owner.has(key))
  return { keys, missing, error: null }
}

/**
 * 规范顺序：待办 → 自己添加的阶段（保持提交顺序）→ 已阻塞 → 已完成 → 已取消。
 *
 * 不变量：内置阶段的位置由系统定，用户阶段的相对顺序由用户定。
 */
export function orderStagesByBuiltin<T extends { builtin: BuiltinStageKey | null }>(
  entries: readonly T[],
): T[] {
  const pick = (key: BuiltinStageKey): T | undefined => entries.find((item) => item.builtin === key)
  const users = entries.filter((item) => item.builtin === null)
  const head = pick('todo')
  const tail = (['blocked', 'done', 'cancelled'] as const)
    .map(pick)
    .filter((item): item is T => item !== undefined)
  return [...(head === undefined ? [] : [head]), ...users, ...tail]
}
