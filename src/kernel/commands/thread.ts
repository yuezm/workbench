/**
 * 线程命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, FactDraft, Iso, View } from '../types'
import {
  boundFacts,
  closedFacts,
  findThreadByKey,
  makeNote,
  noteFacts,
  withBinding,
  withNote,
  withStatus,
} from '../threads'
import { done, OWNER, ownerDraft, reject, runsOfTask } from './common'

export function noteThread(
  view: View,
  input: Extract<Input, { type: 'thread.note' }>,
  now: Iso,
  env: Environment,
): Decision {
  const thread = view.threads.get(input.threadId)
  if (!thread) return reject('not_found', '线程不存在: ' + input.threadId)
  const note = makeNote(env, 'owner', input.text.trim(), now)
  const next = withNote(thread, note, now)
  return done(noteFacts(next, note, OWNER, now))
}

export function closeThread(
  view: View,
  input: Extract<Input, { type: 'thread.close' }>,
  now: Iso,
): Decision {
  // 人工归档：幂等（已关闭零事实）；新事件到达会自动重开
  const thread = view.threads.get(input.threadId)
  if (!thread) return reject('not_found', '线程不存在: ' + input.threadId)
  if (thread.status === 'closed') return done([])
  return done(closedFacts(withStatus(thread, 'closed', now), 'manual', OWNER, now))
}

export function bindThread(
  view: View,
  input: Extract<Input, { type: 'thread.bind' }>,
  now: Iso,
): Decision {
  // 把隐式线程绑定到外部入口：目标键不能被别的线程占用（身份唯一）
  const thread = view.threads.get(input.threadId)
  if (!thread) return reject('not_found', '线程不存在: ' + input.threadId)
  const source = input.source.trim()
  const externalRef = input.externalRef.trim()
  const existing = findThreadByKey(view, source, externalRef)
  if (existing !== undefined && existing.id !== thread.id) {
    return reject('conflict', '入口已被线程占用: ' + source + '/' + externalRef)
  }
  const bound = withBinding(thread, source, externalRef, now)
  return done(boundFacts(bound, source, externalRef, OWNER, now))
}

/**
 * 删除线程（连同它的执行记录）：线程行消失，线程内各任务的 run 记录逐条清除。
 *
 * 口径与 `task.remove` 对齐（D13）：先逐条 `run.removed`，再删任务行，最后删线程行——
 * 重建时先删 run 再删任务，与「删线程」的可见结果一致；评论 / 评审报告由投影层按
 * `task_id` 联删，落盘归档（`<artifacts>/threads/<threadId>/`）由宿主按 threadId 清理。
 *
 * 线程内还有执行中的 run 时 reject：车队还在跑，删掉的执行记录会被后续回执写回来。
 * 线程不存在按幂等删除（零事实）。
 */
export function removeThread(
  view: View,
  input: Extract<Input, { type: 'thread.remove' }>,
  now: Iso,
): Decision {
  const thread = view.threads.get(input.threadId)
  if (!thread) return done([])
  const taskIds = new Set(thread.taskIds)
  for (const run of view.runs.values()) {
    if (run.taskId === null || !taskIds.has(run.taskId)) continue
    if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting') {
      return reject('conflict', '线程内还有执行中的任务，先停止执行再删除线程')
    }
  }
  const facts: FactDraft[] = []
  for (const taskId of thread.taskIds) {
    // 执行记录先删（与 task.remove 同序）：run 行没了，run_events / 卡片随之联删
    for (const run of runsOfTask(view, taskId)) {
      facts.push(ownerDraft('run.removed', { runId: run.id }, now))
    }
    const task = view.tasks.get(taskId)
    if (task !== undefined) facts.push(ownerDraft('task.removed', { task }, now))
  }
  facts.push(ownerDraft('thread.removed', { thread }, now))
  return done(facts)
}
