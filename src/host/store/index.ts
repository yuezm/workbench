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
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Input } from '../../protocol/inputs'
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
import { validateInput } from '../../protocol/validate'
import { withTx } from '../schema'
import { lastSeq, appendFacts, factsBetween, factsCount, factsSince } from './facts'
import { createProjectionWriter, type ProjectionWrite } from './projection-apply'
import { backfillBuiltinStages, type BuiltinBackfillResult } from './builtin-stages'
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
  runTimeoutMs: 3_600_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
  maxSpawnItems: 32,
  maxSpawnDepth: 8,
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
  /**
   * 产物落盘根（M15）：随视图交给内核拼「任务索引」的产物路径。
   * 缺省 null 时索引只给 runId（测试与未配置产物的场景）。
   */
  artifactsRoot?: string | null
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
  /**
   * 启动补齐内置阶段（M18）：每个工作流补成「待办 / 已阻塞 / 已完成 / 已取消」四件套。
   * 幂等；必须在 `ensureProjection()` 之后调用。
   */
  ensureBuiltinStages(): BuiltinBackfillResult
  /** 强制重建（测试与维护入口）。 */
  rebuild(): void
  factsSince(seq: Seq): Fact[]
  factsCount(): number
  /**
   * 命令幂等回放（M5）：该 `commandId` 已提交过则返回原事实，否则 null。
   * 编排类命令（需要宿主探测/前置取消）由命令路由用它做入口幂等。
   */
  commandFacts(commandId: string): Fact[] | null
  /** 记录一条编排类命令的结果（幂等）；已存在则忽略（首次记录优先）。 */
  rememberCommand(commandId: string, facts: readonly Fact[]): void
  /**
   * 下一次内核唤醒时刻（宿主唯一定时器用）：按 `clock.tick` 的 viewSpec 装载视图，
   * 交给注入的 `kernel.nextWakeAt`；kernel 未提供该能力时返回 null（时钟不排期）。
   */
  nextWakeAt(now: Iso): Iso | null
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
  const artifactsRoot = options.artifactsRoot ?? null

  const environment = (): Environment => ({
    timezone,
    limits,
    nextId: (_kind: IdKind) => newId(),
  })

  /** 命令的幂等键；宿主内部输入没有 `commandId`（幂等由租约/回执哈希保证）。 */
  const commandIdOf = (input: Input): string | null => {
    const value = (input as { commandId?: unknown }).commandId
    return typeof value === 'string' && value !== '' ? value : null
  }

  /** 已提交过的命令事实；区间不连续（编排命令混了多次提交）时按「零事实」回放。 */
  const readCommandFacts = (commandId: string): Fact[] | null => {
    const row = db
      .prepare('SELECT first_seq, fact_count FROM commands WHERE command_id = ?')
      .get(commandId) as unknown as { first_seq: number; fact_count: number } | undefined
    return row === undefined ? null : factsBetween(db, row.first_seq, row.fact_count)
  }

  /**
   * 记录命令结果（幂等）。区间连续才能按 seq 回放；不连续（编排命令）只记录
   * 「命令已处理」，回放返回空事实——调用方要的值由命令路由另算。
   * `INSERT OR IGNORE`：同一命令多次提交时首次记录优先。
   */
  const writeCommand = (commandId: string, facts: readonly Fact[], at: Iso): void => {
    const first = facts[0]?.seq
    const contiguous =
      first !== undefined && facts.every((fact, index) => fact.seq === first + index)
    db.prepare(
      'INSERT OR IGNORE INTO commands (command_id, first_seq, fact_count, at) VALUES (?, ?, ?, ?)',
    ).run(commandId, contiguous ? first : 0, contiguous ? facts.length : 0, at)
  }

  /** 单次尝试：装载 → 决策 → 单事务写入；序号冲突抛 `SeqConflictError` 交给 dispatch 重试。 */
  const attemptDispatch = (command: Input, commandId: string | null): DispatchResult => {
    const view = loadView(db, kernel.viewSpec(command), artifactsRoot)
    const decision = kernel.decide(view, command, now(), environment())
    if (decision.reject) throw new StoreError(decision.reject.code, decision.reject.message)
    if (decision.facts.length === 0) {
      // 零事实命令也要记幂等（重复提交仍返回空事实，不重复决策）
      if (commandId !== null) withTx(db, () => writeCommand(commandId, [], now()))
      return { facts: [] }
    }

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
      if (commandId !== null) writeCommand(commandId, facts, facts[facts.length - 1].at)
      return { facts }
    })
  }

  /**
   * 线程删除后的落盘清理：`<artifacts>/threads/<threadId>/`（`index.md` 与 `runs/*`）就是
   * 这个线程的执行记录，库里的 run 行已随事实删除，磁盘上不能留孤本。
   * 清理失败不改变命令结果（归档与其它落盘路径同口径：增益项不拖垮写路径）。
   */
  const dropThreadArtifacts = (facts: readonly Fact[]): void => {
    if (artifactsRoot === null) return
    for (const fact of facts) {
      if (fact.type !== 'thread.removed') continue
      const threadId = (fact.payload as { thread: { id: string } }).thread.id
      try {
        rmSync(path.join(artifactsRoot, 'threads', threadId), { recursive: true, force: true })
      } catch {
        // 目录不存在 / 被占用：删除结果不受影响
      }
    }
  }

  const dispatch = (input: unknown): DispatchResult => {
    const validated = validateInput(input)
    if (!validated.ok) throw new StoreError('invalid_input', validated.message)
    const commandId = commandIdOf(validated.input)
    if (commandId !== null) {
      const replay = readCommandFacts(commandId)
      if (replay !== null) {
        dropThreadArtifacts(replay)
        return { facts: replay }
      }
    }
    try {
      const result = attemptDispatch(validated.input, commandId)
      dropThreadArtifacts(result.facts)
      return result
    } catch (error) {
      if (!(error instanceof SeqConflictError)) throw error
      try {
        const result = attemptDispatch(validated.input, commandId)
        dropThreadArtifacts(result.facts)
        return result
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
    ensureBuiltinStages: () => backfillBuiltinStages(db, kernel, newId, now),
    rebuild: () => rebuildProjection(db, kernel),
    factsSince: (seq) => factsSince(db, seq),
    factsCount: () => factsCount(db),
    commandFacts: (commandId) => readCommandFacts(commandId),
    rememberCommand: (commandId, facts) => {
      withTx(db, () => writeCommand(commandId, facts, now()))
    },
    nextWakeAt: (at) => {
      if (!kernel.nextWakeAt) return null
      const view = loadView(db, kernel.viewSpec({ type: 'clock.tick' }), artifactsRoot)
      return kernel.nextWakeAt(view, at, environment())
    },
  }
}
