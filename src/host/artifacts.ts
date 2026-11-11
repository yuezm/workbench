/**
 * 产物落盘（M14 / M15 / M16）。
 *
 * 正文类数据不留在库里：库只存实体、状态与引用，正文一律写到**应用数据目录**，
 * 一个 run 一个目录，人可以直接打开看：
 *
 * ```
 * <root>/threads/<threadId>/
 *   index.md                              # 线程执行索引（run → 任务/阶段/轮次/状态）
 *   runs/<runId>/
 *     meta.json                           # 机器可读元数据
 *     prompt.md                           # 本轮派发给智能体的完整提示词
 *     transcript.jsonl                    # 全帧流水（thinking/text/tool_call/tool_result/status）
 *     output.md                           # 本轮产出正文
 *     review.md                           # 评审报告正文
 * ```
 *
 * 三个口径：
 *
 * 1. **路径只依赖 threadId + runId**：`rev` / 阶段名 / 标题都在决策期才知道，
 *    而落盘发生在派发之前或之后的不同时刻；路径必须先可算，否则引用与文件对不上。
 *    人类可读的关联（任务、阶段、轮次、时间）进 `meta.json` 与 `index.md`，不进路径。
 * 2. **原子写**：先写 `.tmp` 再 `rename`，崩溃只会留 `.tmp`，不会让下游读到半截文件。
 * 3. **失败不阻断运行**：落盘是增强项，磁盘满 / 权限不足时回执照常返回、任务照常推进。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { RunEvent, RunRow } from '../protocol/entities'
import type { Receipt } from '../protocol/inputs'
import type { ReviewArtifact } from '../protocol/review'

/** 报告正文的相对路径（`root` 之下）；只用 id，不用标题。 */
export function reviewArtifactPath(root: string, threadId: string, runId: string): string {
  return path.join(root, 'threads', threadId, 'runs', runId, 'review.md')
}

/**
 * 本轮正文的相对路径（`root` 之下，M15）：与 `review.md` 同目录。
 *
 * 「任务索引」按 `threadId + runId` 确定性拼出这个路径，再由执行器用 `read` 打开；
 * 因此路径**只能依赖 id**，不能依赖标题、`rev` 或任何决策期才知道的值。
 */
export function runOutputPath(root: string, threadId: string, runId: string): string {
  return path.join(root, 'threads', threadId, 'runs', runId, 'output.md')
}

/** 原子写：先写 `.tmp` 再 `rename`；失败只留 `.tmp` 被清掉，不产生半截文件。 */
function writeAtomic(target: string, text: string): boolean {
  const temp = `${target}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, target)
    return true
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败也不影响运行（文件本来就不存在或已被移走）
    }
    return false
  }
}

/**
 * 写一份报告正文，返回引用；失败返回 null（调用方保持 `artifact` 为空）。
 *
 * `dir` 不存在时递归创建；`.tmp` 只在本函数内出现，`rename` 之后文件即可见。
 */
export function writeReviewArtifact(
  root: string,
  threadId: string,
  runId: string,
  text: string,
): ReviewArtifact | null {
  const target = reviewArtifactPath(root, threadId, runId)
  if (!writeAtomic(target, text)) return null
  return {
    path: target,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

/**
 * 写本轮正文（`output.md`），返回是否写成（M15）。
 *
 * 失败不抛错：索引仍会给出这个路径，读取方读不到就按「该轮没有落盘」处理，
 * 与报告正文的既有口径一致（落盘是增强项，不改变 run 终态）。
 */
export function writeRunOutput(
  root: string,
  threadId: string,
  runId: string,
  text: string,
): boolean {
  return writeAtomic(runOutputPath(root, threadId, runId), text)
}

/**
 * 把一份文档写进项目的 `docs/`（「提升为文档」出口）。
 *
 * 与 `writeReviewArtifact` 的区别：这里失败**必须抛错**——这是用户显式点的动作，
 * 悄悄失败比报错更糟。目标目录不存在时递归创建；同样走临时文件 + rename。
 */
export function writeProjectDoc(dir: string, fileName: string, text: string): string {
  const target = path.join(dir, fileName)
  const temp = `${target}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, target)
    return target
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败不影响错误上抛
    }
    throw error
  }
}

/**
 * 回执 → 带回正文引用的回执（宿主在派发 `run.receipt` 前调用）。
 *
 * 只对**带评审内容**的回执落盘：有 `verdict` 或非空 `findings`；运行没挂线程时跳过
 * （没有线程就没有稳定的产物目录）。没有配置 `root` 时不落盘。
 */
export function withReviewArtifact(
  root: string | undefined,
  run: Pick<RunRow, 'id' | 'threadId'>,
  receipt: Receipt,
): Receipt {
  if (root === undefined || run.threadId === null) return receipt
  const hasFindings = (receipt.findings?.length ?? 0) > 0
  if (!hasFindings && receipt.verdict === undefined) return receipt
  const artifact = writeReviewArtifact(root, run.threadId, run.id, receipt.output ?? '')
  return artifact === null ? receipt : { ...receipt, artifact }
}

/**
 * 终态回执落盘（M15）：挂线程的 `stage` run 都写一份 `output.md`，有评审内容时另写 `review.md`。
 *
 * 必须在 `run.receipt` 之前调用：索引只列终态 run，文件与终态同批可见，不会出现
 * 「索引指向一个还没写出来的文件」。正文为空而 `error` 非空时写错误说明，
 * 保证索引指过去总有东西可读；两处落盘失败都不改变回执。
 */
export function withRunArtifacts(
  root: string | undefined,
  run: Pick<RunRow, 'id' | 'threadId' | 'purpose'>,
  receipt: Receipt,
): Receipt {
  if (root === undefined || run.threadId === null) return receipt
  if (run.purpose === 'stage') {
    const output = (receipt.output ?? '').trim()
    // 失败但没有错误正文时退到 `errorCode`：任务索引按规则给 `output.md` 路径，
    // 一条永远读不到的死链接比一段「timeout」更糟。
    const reason = (receipt.error ?? '').trim() !== '' ? receipt.error : receipt.errorCode
    const body =
      output !== ''
        ? (receipt.output as string)
        : reason === undefined || reason === null || reason.trim() === ''
          ? ''
          : `# 错误\n\n${reason}\n`
    if (body !== '') writeRunOutput(root, run.threadId, run.id, body)
  }
  return withReviewArtifact(root, run, receipt)
}

// ---------- 执行归档（M16）：一个 run 一个可读目录 ----------

/** 归档用的名称标签：由装配根从视图查，缺名称时留 null（只影响可读性，不影响落盘）。 */
export interface RunArchiveLabels {
  taskId: string | null
  taskTitle: string | null
  stageId: string | null
  stageName: string | null
  agentId: string | null
  agentName: string | null
}

/** 归档关心的 run 列（渲染 meta 只需这些；测试可传字面量）。 */
export type ArchiveRun = Pick<
  RunRow,
  | 'id'
  | 'threadId'
  | 'taskId'
  | 'stageId'
  | 'agentId'
  | 'purpose'
  | 'turn'
  | 'status'
  | 'executorKey'
  | 'startedAt'
  | 'endedAt'
  | 'createdAt'
  | 'durationMs'
  | 'exitCode'
  | 'errorCode'
  | 'error'
  | 'sessionId'
  | 'usage'
>

/** `meta.json` 的形状：机器可读的那一份（人不读它，人读 `index.md`）。 */
export interface RunArchiveMeta extends RunArchiveLabels {
  schemaVersion: number
  runId: string
  threadId: string
  purpose: string
  turn: number
  status: string
  executorKey: string
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  exitCode: number | null
  errorCode: string | null
  error: string | null
  sessionId: string | null
  usage: unknown
  frames: { total: number; thinking: number; text: number; toolCall: number; toolResult: number }
  files: string[]
}

export const RUN_ARCHIVE_SCHEMA_VERSION = 1

/** run 目录：`<root>/threads/<threadId>/runs/<runId>`（只用 id）。 */
export function runDirPath(root: string, threadId: string, runId: string): string {
  return path.join(root, 'threads', threadId, 'runs', runId)
}

/** 派发提示词：`runs/<runId>/prompt.md`。 */
export function runPromptPath(root: string, threadId: string, runId: string): string {
  return path.join(runDirPath(root, threadId, runId), 'prompt.md')
}

/** 全帧流水：`runs/<runId>/transcript.jsonl`。 */
export function runTranscriptPath(root: string, threadId: string, runId: string): string {
  return path.join(runDirPath(root, threadId, runId), 'transcript.jsonl')
}

/** 元数据：`runs/<runId>/meta.json`。 */
export function runMetaPath(root: string, threadId: string, runId: string): string {
  return path.join(runDirPath(root, threadId, runId), 'meta.json')
}

/** 线程执行索引：`threads/<threadId>/index.md`。 */
export function threadIndexPath(root: string, threadId: string): string {
  return path.join(root, 'threads', threadId, 'index.md')
}

/** 表头里的派发信息：给人看的上下文块，不参与执行（模型读的是后面的原文）。 */
function renderPromptDoc(
  run: Pick<ArchiveRun, 'id' | 'turn'>,
  labels: RunArchiveLabels,
  prompt: string,
  at: string,
): string {
  const head = [
    '<!-- 本轮派发信息（宿主写入，修改不影响执行）',
    `runId: ${run.id}`,
    `turn: ${run.turn}`,
    `任务: ${labels.taskTitle ?? '-'} <${labels.taskId ?? '-'}>`,
    `阶段: ${labels.stageName ?? '-'} <${labels.stageId ?? '-'}>`,
    `智能体: ${labels.agentName ?? '-'} <${labels.agentId ?? '-'}>`,
    `派发时间: ${at}`,
    '-->',
    '',
  ].join('\n')
  return head + (prompt.endsWith('\n') ? prompt : `${prompt}\n`)
}

/**
 * 写本轮派发提示词（M16）。
 *
 * 只对挂线程的 `stage` run 生效：聊天 run 的提示词由对话消息还原，阶段 run 的提示词
 * 是内核按阶段 + 线程上下文拼出来的那一份——出问题时最先要看的就是它。
 */
export function writeRunPrompt(
  root: string | undefined,
  run: Pick<ArchiveRun, 'id' | 'threadId' | 'purpose' | 'turn'>,
  labels: RunArchiveLabels,
  prompt: string,
  at: string,
): boolean {
  if (root === undefined || run.threadId === null || run.purpose !== 'stage') return false
  if (prompt.trim() === '') return false
  return writeAtomic(
    runPromptPath(root, run.threadId, run.id),
    renderPromptDoc(run, labels, prompt, at),
  )
}

/** 全帧流水（JSON Lines）：每行是一条原样帧，`jq` 可直接按 `type` 过滤。 */
export function renderTranscript(frames: readonly RunEvent[]): string {
  if (frames.length === 0) return ''
  return `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`
}

/** 帧统计：写进 meta，一眼看出这轮有没有思考、调了多少工具。 */
export function summarizeFrames(frames: readonly RunEvent[]): RunArchiveMeta['frames'] {
  const summary = { total: frames.length, thinking: 0, text: 0, toolCall: 0, toolResult: 0 }
  for (const frame of frames) {
    if (frame.type === 'thinking') summary.thinking += 1
    else if (frame.type === 'text') summary.text += 1
    else if (frame.type === 'tool_call') summary.toolCall += 1
    else if (frame.type === 'tool_result') summary.toolResult += 1
  }
  return summary
}

/** 组装 `meta.json`：状态以回执为准（投影行可能还没被终态事实刷新）。 */
export function buildRunMeta(
  run: ArchiveRun,
  labels: RunArchiveLabels,
  frames: readonly RunEvent[],
  receipt: Pick<
    Receipt,
    'status' | 'sessionId' | 'usage' | 'exitCode' | 'errorCode' | 'error' | 'durationMs'
  >,
  at: string,
  files: readonly string[],
): RunArchiveMeta {
  return {
    schemaVersion: RUN_ARCHIVE_SCHEMA_VERSION,
    runId: run.id,
    threadId: run.threadId ?? '',
    ...labels,
    purpose: run.purpose,
    turn: run.turn,
    status: receipt.status,
    executorKey: run.executorKey,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? at,
    durationMs: receipt.durationMs ?? run.durationMs,
    exitCode: receipt.exitCode ?? run.exitCode,
    errorCode: receipt.errorCode ?? run.errorCode,
    error: receipt.error ?? run.error,
    sessionId: receipt.sessionId ?? run.sessionId,
    usage: receipt.usage ?? run.usage,
    frames: summarizeFrames(frames),
    files: [...files],
  }
}

/** 读线程下所有 `meta.json`（坏文件跳过：索引是重建出来的，不能因为一行坏 JSON 就空）。 */
export function readRunMetas(root: string, threadId: string): RunArchiveMeta[] {
  const dir = path.join(root, 'threads', threadId, 'runs')
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const metas: RunArchiveMeta[] = []
  for (const entry of entries) {
    const file = path.join(dir, entry, 'meta.json')
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunArchiveMeta
      if (typeof parsed?.runId === 'string') metas.push(parsed)
    } catch {
      // 单项损坏只丢这一条：其余 run 仍要出现在索引里
    }
  }
  return metas.sort((left, right) =>
    (left.startedAt ?? left.createdAt).localeCompare(right.startedAt ?? right.createdAt),
  )
}

/** 表格单元格：竖线与换行会破坏 Markdown 表格，统一转义。 */
function cell(value: string | null | undefined): string {
  const text = value === null || value === undefined || value.trim() === '' ? '-' : value.trim()
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** 时间列：`2026-11-10T08:07:00.123Z` → `11-10 08:07`（UTC，与事实日志同源）。 */
function stamp(value: string | null): string {
  if (value === null || value.length < 16) return '-'
  return `${value.slice(5, 10)} ${value.slice(11, 16)}`
}

/** 用时列：毫秒转「12.4s」/「1m02s」，无耗时写 `-`。 */
function elapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/**
 * 线程执行索引（Markdown）：**这是人找产物的入口**。
 *
 * 用户能记住的是「任务 + 阶段 + 第几轮」，不是 UUID；所以索引必须把
 * runId 与任务/阶段/轮次/状态/文件清单排在一张表里。整表由 `meta.json` 重建，
 * 同一个 run 重跑只会覆盖自己那一行。
 *
 * 表里**只链 `output.md`**（M27）：其余文件是排查材料（`prompt.md` /
 * `transcript.jsonl` / `meta.json`）或评审正文（`review.md`，模型侧的入口在
 * 「待修复清单」段，不靠这里），给人的正文入口一个就够；`runId` 列保留，
 * 要看别的文件按 runId 进目录即可。评审报告存在时行内加 `·review` 纯文本标记，
 * 保住「这轮有没有评审」这个信号。
 */
export function renderThreadIndex(threadId: string, metas: readonly RunArchiveMeta[]): string {
  const lines = [
    `# 线程执行索引`,
    '',
    `- 线程：\`${threadId}\``,
    `- 每个 run 一个目录：\`runs/<runId>/\`，内含 \`prompt.md\`（派发提示词）、`,
    '  `transcript.jsonl`（全帧流水，含 thinking 帧）、`output.md`（本轮正文）、`review.md`（评审报告，若有）、`meta.json`（元数据）。',
    '- 表里只链 `output.md`；其余文件按 `runId` 进目录看。`·review` = 该轮落过评审报告。',
    '- 本表由宿主在每次 run 终态时重建；时间列为 UTC。',
    '',
    '| # | 时间 | 阶段 | 任务 | 轮次 | 状态 | 用时 | runId | 产出 |',
    '| - | ---- | ---- | ---- | ---- | ---- | ---- | ----- | ---- |',
  ]
  metas.forEach((meta, index) => {
    // 只给正文链接；没有 output.md（空正文且无错误）时退到「-」，与「只列确实存在的文件」同口径
    const links = meta.files
      .filter((file) => INDEX_LINKED_FILES.includes(file))
      .map((file) => `[\`${file}\`](runs/${meta.runId}/${file})`)
    const review = meta.files.includes('review.md') ? '·review' : ''
    const body = [...links, review].filter((part) => part !== '').join(' ') || '-'
    lines.push(
      `| ${index + 1} | ${stamp(meta.startedAt ?? meta.createdAt)} | ${cell(meta.stageName)} | ${cell(meta.taskTitle)} | ` +
        `${meta.turn} | ${meta.status} | ${elapsed(meta.durationMs)} | \`${meta.runId}\` | ${body} |`,
    )
  })
  if (metas.length === 0) lines.push('| - | - | 还没有终态 run | - | - | - | - | - | - |')
  return `${lines.join('\n')}\n`
}

/** 重建一个线程的索引（读目录 → 渲染 → 原子写）。失败不抛错。 */
export function writeThreadIndex(root: string, threadId: string): boolean {
  return writeAtomic(
    threadIndexPath(root, threadId),
    renderThreadIndex(threadId, readRunMetas(root, threadId)),
  )
}

/** 归档目录里一个 run 的固定文件顺序（`meta.files` 按它排列，缺的跳过）。 */
const RUN_ARCHIVE_FILES = ['prompt.md', 'transcript.jsonl', 'output.md', 'review.md'] as const

/**
 * 索引里挂链接的文件（M27）：只有正文。
 *
 * `meta.files` 继续记全四件套（排查与脚本要用），但索引只给 `output.md` 一个入口——
 * 模型据索引读正文、人据索引找正文，两个消费者要的都是它；`prompt.md` /
 * `transcript.jsonl` 是排查材料（体量大、不该被当上下文整读），`meta.json` 是脚本输入。
 */
const INDEX_LINKED_FILES: readonly string[] = ['output.md']

/** 读文本；缺失或不可读返回 null（「与渲染结果比对」用它，读不到就算不一致）。 */
function readTextOrNull(target: string): string | null {
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

/** 读单个 `meta.json`；缺失或坏 JSON 返回 undefined（回填是尽力而为）。 */
function readRunMeta(target: string): RunArchiveMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as RunArchiveMeta
    return typeof parsed?.runId === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 从全帧流水拼正文：与执行器累计 `state.text` 同口径——只取 `text` 帧，按顺序原样追加。
 *
 * 中间的 `thinking` / `tool_call` / `tool_result` 帧不进正文；坏行跳过（一行坏不该废掉整轮）。
 */
function textFromTranscript(target: string): string {
  let raw: string
  try {
    raw = readFileSync(target, 'utf8')
  } catch {
    return ''
  }
  const parts: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const frame = JSON.parse(trimmed) as { type?: unknown; text?: unknown }
      if (frame.type === 'text' && typeof frame.text === 'string') parts.push(frame.text)
    } catch {
      // 坏行跳过
    }
  }
  return parts.join('')
}

/**
 * 回填历史 run 的 `output.md`（一次性，幂等）。
 *
 * 为什么要它：`output.md` 落盘晚于最早的终态归档，老 run 只有 `transcript.jsonl`——
 * 任务索引按规则给模型一个 `output.md` 路径，模型读一次失败才回退，每轮都白吃一次。
 * 这里把正文从流水里拼回来，与 `withRunArtifacts` 同口径：
 * `text` 帧拼接非空就用它，否则用 `meta.error` 写 `# 错误` 段（都没有就跳过）。
 *
 * 三条边界：
 * - 已有 `output.md` 的 run 一律不动（幂等，重复调用无副作用）；
 * - 补写成功后按固定顺序重算 `meta.files`，让索引能把新文件列出来；
 * - 顺带校准 `meta.files` 与磁盘的一致性：已下线的产物类型（如 `thinking.md`）不再被索引列出，
 *   所以这条路径也是「删掉一种产物」之后的陈留清理入口；
 * - 索引也在这里对齐渲染口径：磁盘上的 `index.md` 与当前 `renderThreadIndex` 的输出不一致
 *   （渲染格式改过 / 手工编辑过 / 半截写入）就重写。否则改一次表格形态，老线程的索引会一直
 *   停在旧格式，直到它下一次有 run 终态——那可能永远不来；
 * - 全程 `writeAtomic` + 容错读取，坏文件只跳过那一条，不影响其余 run 与整表重建。
 *
 * @returns 实际补写的 run 数（调用方可据此决定要不要提示用户）
 */
export function backfillRunOutputs(root: string | undefined): number {
  if (root === undefined) return 0
  const threadsDir = path.join(root, 'threads')
  let threads: string[]
  try {
    threads = readdirSync(threadsDir)
  } catch {
    return 0
  }
  let filled = 0
  for (const threadId of threads) {
    let runIds: string[]
    try {
      runIds = readdirSync(path.join(threadsDir, threadId, 'runs'))
    } catch {
      continue
    }
    let indexDirty = false
    for (const runId of runIds) {
      const dir = runDirPath(root, threadId, runId)
      const meta = readRunMeta(runMetaPath(root, threadId, runId))
      let touched = false
      if (!existsSync(runOutputPath(root, threadId, runId))) {
        const text = textFromTranscript(runTranscriptPath(root, threadId, runId))
        const reason = (meta?.error ?? '').trim() !== '' ? meta?.error : meta?.errorCode
        const body =
          text.trim() !== ''
            ? text
            : reason === undefined || reason === null || reason.trim() === ''
              ? ''
              : `# 错误\n\n${reason}\n`
        if (body !== '' && writeRunOutput(root, threadId, runId, body)) {
          filled += 1
          touched = true
        }
      }
      // `files` 与磁盘不一致就重写：删掉的产物类型（如 `thinking.md`）不能再被索引继续列出。
      if (meta !== undefined) {
        const actual = RUN_ARCHIVE_FILES.filter((file) => existsSync(path.join(dir, file)))
        if (actual.join(',') !== meta.files.join(',')) {
          meta.files = actual
          writeAtomic(runMetaPath(root, threadId, runId), `${JSON.stringify(meta, null, 2)}\n`)
          touched = true
        }
      }
      if (touched) indexDirty = true
    }
    // 索引口径自愈：渲染结果与磁盘内容不一致就重写（缺文件、格式改版、手工编辑都归到这里）
    const rendered = renderThreadIndex(threadId, readRunMetas(root, threadId))
    if (indexDirty || readTextOrNull(threadIndexPath(root, threadId)) !== rendered) {
      writeThreadIndex(root, threadId)
    }
  }
  return filled
}

/** `archiveRunTerminal` 的入参（宿主在 `run.receipt` 之前调用）。 */
export interface RunArchiveInput {
  run: ArchiveRun
  labels: RunArchiveLabels
  frames: readonly RunEvent[]
  receipt: Receipt
  /** 终态落盘时刻（ISO）；`runs.endedAt` 还没被投影刷到时用它兜底 */
  at: string
}

/**
 * 终态归档（M16）：写 `transcript.jsonl` / `meta.json`，再重建线程索引。
 *
 * 调用顺序要求：先 `withRunArtifacts`（写 `output.md` / `review.md`），再调本函数——
 * `meta.json` 的 `files` 列的是**已经存在**的文件，顺序反了会漏报。
 * 每一步落盘都走 `writeAtomic`（失败返回 false，不抛错），归档失败不影响回执与推进。
 */
export function archiveRunTerminal(root: string | undefined, input: RunArchiveInput): void {
  const { run, labels, frames, receipt, at } = input
  if (root === undefined || run.threadId === null || run.purpose !== 'stage') return
  const threadId = run.threadId
  const files: string[] = []
  if (existsSync(runPromptPath(root, threadId, run.id))) files.push('prompt.md')
  const transcript = renderTranscript(frames)
  if (transcript !== '' && writeAtomic(runTranscriptPath(root, threadId, run.id), transcript))
    files.push('transcript.jsonl')
  if (existsSync(runOutputPath(root, threadId, run.id))) files.push('output.md')
  if (existsSync(reviewArtifactPath(root, threadId, run.id))) files.push('review.md')
  const meta = buildRunMeta(run, labels, frames, receipt, at, files)
  writeAtomic(runMetaPath(root, threadId, run.id), `${JSON.stringify(meta, null, 2)}\n`)
  writeThreadIndex(root, threadId)
}
