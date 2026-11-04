/**
 * 宿主存储层门面（M1 T5）：一次输入 = 校验 → 装载视图切片 → decide → 单事务
 * 「追加事实 + 应用 project 变更 + 更新投影元信息」。
 *
 * 内核通过注入的 `KernelPort` 使用：本目录只 `import type` 内核契约、不 import 任何内核实现，
 * 因此单测用假 kernel 即可，不依赖 `kernel/decide` 的具体实现。
 *
 * 写路径唯一的例外是重建（`ensureProjection` / `rebuild`）：它按 seq 顺序 fold `project`。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Command } from '../../protocol/commands'
import type { ViewId, ViewParams, ViewResult } from '../../protocol/views'
import type {
  Environment,
  Fact,
  Id,
  IdKind,
  Iso,
  KernelPort,
  Limits,
  Seq,
} from '../../kernel/types'
import { validateCommand } from '../../protocol/validate'
import { withTx } from '../schema'
import { lastSeq, appendFacts, factsCount, factsSince } from './facts'
import { createProjectionWriter, type ProjectionWrite } from './projection-apply'
import {
  currentProjectionFormat,
  ensureProjection,
  rebuildProjection,
  writeProjectionMeta,
} from './projection'
import { SeqConflictError, StoreError } from './errors'
import { loadView, queryView } from './views'

export { StoreError } from './errors'
export type { StoreErrorCode } from './errors'

/**
 * 默认限制：M1 的两项（阶段上限与 `protocol/validate` 一致、数组上限取迁移/帧批次量级）
 * + M2 的调度口径（SPEC-kernel「类型契约」原值；测试可注入缩短，语义不变）。
 */
export const DEFAULT_LIMITS: Limits = {
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 300_000,
  backoffCapMs: 3_600_000,
  runTimeoutMs: 1_800_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
}

export interface StoreOptions {
  db: DatabaseSync
  kernel: KernelPort
  /** 时钟由宿主注入；默认 `new Date().toISOString()`。 */
  now?: () => Iso
  /** id 生成器由宿主注入；默认 `randomUUID`（测试注入确定性 id）。 */
  newId?: () => Id
  /** 内核环境时区；默认取本机时区。 */
  timezone?: string
  /** 内核限制；默认 `DEFAULT_LIMITS`。 */
  limits?: Limits
}

export interface DispatchResult {
  /** 本次提交的事实（带 seq；空数组 = 决策未产生事实，也没有写库）。 */
  facts: Fact[]
}

export interface EnsureProjectionResult {
  rebuilt: boolean
}

export interface Store {
  dispatch(input: unknown): DispatchResult
  query<T extends ViewId>(view: T, params?: ViewParams<T>): ViewResult<T>
  /** 启动对账：指纹失配或 seq 落后则重建。 */
  ensureProjection(): EnsureProjectionResult
  /** 强制重建（测试与维护入口）。 */
  rebuild(): void
  factsSince(seq: Seq): Fact[]
  factsCount(): number
}

const systemTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * 装配 store：`db` 必须已建好 schema（`openDatabase` + `SCHEMA_SQL`）。
 *
 * 启动对账是调用方的事：装配根在开始 dispatch 前先调用一次 `ensureProjection()`
 * （SPEC-host 启动顺序：校验投影指纹 → 重建 → 再接收命令）。dispatch 自己不对账，
 * 只保证「追加事实 + 应用变更 + 写元信息」这一段的原子性。
 */
export function createStore(options: StoreOptions): Store {
  const { db, kernel } = options
  const now = options.now ?? (() => new Date().toISOString())
  const newId = options.newId ?? (() => randomUUID())
  const timezone = options.timezone ?? systemTimezone()
  const limits = options.limits ?? DEFAULT_LIMITS

  const environment = (): Environment => ({
    timezone,
    limits,
    nextId: (_kind: IdKind) => newId(),
  })

  /** 单次尝试：装载 → 决策 → 单事务写入；序号冲突抛 `SeqConflictError` 交给 dispatch 重试。 */
  const attemptDispatch = (command: Command): DispatchResult => {
    const view = loadView(db, kernel.viewSpec(command))
    const decision = kernel.decide(view, command, now(), environment())
    if (decision.reject) throw new StoreError(decision.reject.code, decision.reject.message)
    if (decision.facts.length === 0) return { facts: [] }

    const writer = createProjectionWriter(db)
    return withTx(db, () => {
      // 阶段行有自引用外键（on_complete_stage_id / on_reject_stage_id）：同批创建的新阶段
      // 可能先写入「指向后面才插入的阶段」的那一行，立即校验会失败，延到 COMMIT 再校验。
      db.exec('PRAGMA defer_foreign_keys = ON')
      // 视图装载之后、事务开始之前可能有别的写者提交了事实：seq 不等就放弃本次尝试。
      if (lastSeq(db) !== view.seq) throw new SeqConflictError()
      const facts = appendFacts(db, decision.facts)
      const writes: ProjectionWrite[] = []
      for (const fact of facts) {
        for (const change of kernel.project(fact)) writes.push({ change, at: fact.at })
      }
      writer.applyAll(writes)
      writeProjectionMeta(db, currentProjectionFormat(), facts[facts.length - 1].seq)
      return { facts }
    })
  }

  const dispatch = (input: unknown): DispatchResult => {
    const validated = validateCommand(input)
    if (!validated.ok) throw new StoreError('invalid_input', validated.message)
    try {
      return attemptDispatch(validated.command)
    } catch (error) {
      if (!(error instanceof SeqConflictError)) throw error
      try {
        return attemptDispatch(validated.command)
      } catch (retryError) {
        if (retryError instanceof SeqConflictError) {
          throw new StoreError('conflict', '事实日志序号冲突，请重试')
        }
        throw retryError
      }
    }
  }

  const query = <T extends ViewId>(view: T, params?: ViewParams<T>): ViewResult<T> =>
    queryView(db, view, params) as ViewResult<T>

  return {
    dispatch,
    query,
    ensureProjection: () => ensureProjection(db, kernel),
    rebuild: () => rebuildProjection(db, kernel),
    factsSince: (seq) => factsSince(db, seq),
    factsCount: () => factsCount(db),
  }
}
