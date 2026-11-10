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
  const temp = `${target}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, target)
    return {
      path: target,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(text, 'utf8'),
    }
  } catch {
    // 落盘失败不留半截文件：清掉临时文件后按「没有正文」处理
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败也不影响运行（文件本来就不存在或已被移走）
    }
    return null
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
