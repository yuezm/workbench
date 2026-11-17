// @vitest-environment node
/**
 * BUG 回归：飞书发「你好，你是谁」回「没派出去：话题不存在: <uuid>」。
 *
 * 现场链路是 hub 先 `thread.open` 建话题、再 `chat.create{threadId}` 把会话挂上去；
 * 两条命令各自都对，但 `chat.create` 的视图切片里没有 `threads`——内核看到的是空表，
 * 于是刚建好的话题被判 `not_found`。只走 decide 单测（`tests/kernel/decide.chat.test.ts`
 * 手搓 view）永远发现不了，必须用真实 `viewSpec` + 真实投影走一遍 store。
 */
import { describe, expect, it } from 'vitest'
import { decide } from '@workbench/kernel/decide'
import { nextWakeAt } from '@workbench/kernel/core/next-wake'
import { project } from '@workbench/kernel/scopes/project'
import { viewSpec } from '@workbench/kernel/scopes/view-spec'
import type { Fact, KernelPort } from '@workbench/kernel/core/types'
import type { Conversation } from '@workbench/protocol/entities'
import type { ThreadRow } from '@workbench/protocol/thread'
import { StoreError, createStore } from '@workbench/host-store/index'
import { captureError, createMemoryDb } from './test-support'

/** 真实内核端口：这条链路的坑就在「事实 → 投影 → 视图切片」，假内核会盖住它。 */
const realKernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

const payloadOf = <T>(facts: readonly Fact[], type: string): T => {
  const fact = facts.find((item) => item.type === type)
  if (fact === undefined) throw new Error(`缺少事实: ${type}`)
  return fact.payload as T
}

/** 建一条最小链路：运行时 → 智能体（会话的归属者）。 */
function seedAgent(store: ReturnType<typeof createStore>): string {
  store.dispatch({
    type: 'runtime.create',
    commandId: 'c-rt',
    input: { name: '本机 dsh', executorKey: 'dsh', command: 'dsh' },
  })
  const runtime = store.query('runtimes.all')[0]
  if (runtime === undefined) throw new Error('运行时没建出来')
  store.dispatch({
    type: 'agent.create',
    commandId: 'c-ag',
    input: { name: 'Leader', runtimeId: runtime.id },
  })
  const agent = store.query('agents.all')[0]
  if (agent === undefined) throw new Error('智能体没建出来')
  return agent.id
}

describe('chat.create 挂话题：hub 的「先开话题、再建会话」必须真的接上', () => {
  it('同一进程里刚 thread.open 的话题，chat.create 能挂上去（视图切片含 threads）', () => {
    const store = createStore({ db: createMemoryDb(), kernel: realKernel })
    const agentId = seedAgent(store)

    const opened = store.dispatch({
      type: 'thread.open',
      commandId: 'c-topic',
      source: 'feishu',
      externalRef: 'lark:oc_1:om_root',
      title: '你好，你是谁',
    })
    const threadId = payloadOf<{ thread: ThreadRow }>(opened.facts, 'thread.opened').thread.id

    const created = store.dispatch({
      type: 'chat.create',
      commandId: 'c-cv',
      agentId,
      title: '你好，你是谁',
      threadId,
    })

    const conversation = payloadOf<{ conversation: Conversation }>(
      created.facts,
      'conversation.created',
    ).conversation
    expect(conversation.threadId).toBe(threadId)
    // 落库后按话题取会话也要能查到（下一句入站靠它续接）
    expect(store.query('conversations.byThread', { threadId }).map((item) => item.id)).toEqual([
      conversation.id,
    ])
  })

  it('话题确实不存在时仍然是 not_found（修复不放宽校验）', () => {
    const store = createStore({ db: createMemoryDb(), kernel: realKernel })
    const agentId = seedAgent(store)

    const error = captureError(() =>
      store.dispatch({
        type: 'chat.create',
        commandId: 'c-cv',
        agentId,
        threadId: 'th-404',
      }),
    )

    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).code).toBe('not_found')
    expect(error.message).toBe('话题不存在: th-404')
  })
})
