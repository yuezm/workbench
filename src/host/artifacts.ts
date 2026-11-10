/**
 * 评审报告正文落盘（M14）。
 *
 * 报告正文是长文本，塞进提示词预算只会被截断（老实现就是 `runs.output` 头部 2000 码点）。
 * 这里把正文写到**应用数据目录**，内核只拿引用（路径 / sha256 / 字节数）进报告行：
 *
 * ```
 * <root>/threads/<threadId>/runs/<runId>/review.md
 * ```
 *
 * 三个口径：
 *
 * 1. **路径只依赖 runId + threadId**，不依赖 `rev`——`rev` 由内核在决策时算，
 *    而落盘发生在派发之前；路径必须先可算，否则引用与文件对不上。
 * 2. **原子写**：先写 `.tmp` 再 `rename`，崩溃只会留 `.tmp`，不会让下游读到半截文件。
 * 3. **失败不阻断运行**：落盘是增强项，磁盘满 / 权限不足时原样返回回执（报告行里
 *    `artifact` 为 null，索引段退化成「完整清单：报告 id」），任务照常推进。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { RunRow } from '../protocol/entities'
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
    const body =
      output !== ''
        ? (receipt.output as string)
        : receipt.error === undefined || receipt.error.trim() === ''
          ? ''
          : `# 错误\n\n${receipt.error}\n`
    if (body !== '') writeRunOutput(root, run.threadId, run.id, body)
  }
  return withReviewArtifact(root, run, receipt)
}
