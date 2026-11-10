/**
 * 评审命令（M14）。
 *
 * 只有一条：`review.export`（把评审报告提升为项目文档）。它是一次**编排命令**：
 * 内核只做归属校验（任务存在、挂在项目上、定位得到报告）并零事实返回；真正写文件
 * 由宿主做（`host/commands` 的 `exportReview`），因为内核不读也不写文件系统。
 *
 * 为什么要有它：报告正文只落在 `<userData>/artifacts/...`（应用数据，不进仓库），
 * 而「这次评审的结论」有时需要进项目的 `docs/` 供人评审、给外部单位看。这个动作必须是
 * **人显式点**的——自动把每次评审写进仓库会把 git 历史变成运行日志。
 */
import type { Input } from '../../protocol/inputs'
import type { Decision, View } from '../types'
import { done, reject } from './common'
import { findReportForExport } from '../review'

export function exportReview(
  view: View,
  input: Extract<Input, { type: 'review.export' }>,
): Decision {
  const task = view.tasks.get(input.taskId)
  if (task === undefined) return reject('not_found', '任务不存在: ' + input.taskId)
  const project = task.projectId === null ? undefined : view.projects.get(task.projectId)
  if (project === undefined) {
    return reject('conflict', '任务未归属项目，无法落到 docs/reviews（先给任务选一个项目）')
  }
  const report = findReportForExport(view, input.taskId, input.reportId)
  if (report === undefined) {
    return reject(
      'conflict',
      input.reportId === undefined
        ? '这个任务还没有评审报告可导出'
        : '报告不存在: ' + input.reportId,
    )
  }
  // 零事实：命令只表达「人要导出」，产物在宿主侧，事实日志里不留痕
  return done([])
}
