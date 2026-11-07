/**
 * 线程命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, Iso, View } from '../types'
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
import { done, OWNER, reject } from './common'

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
