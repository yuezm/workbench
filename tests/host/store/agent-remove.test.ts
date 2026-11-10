// @vitest-environment node
/**
 * 删智能体：被对话引用时必须由内核拒掉，而不是把 SQLite 的
 * `FOREIGN KEY constraint failed` 原样抛到界面（BUG 现场：点删除 Leader 报错）。
 *
 * 用真实内核（decide / project / viewSpec）+ 真实 store：这条链路里
 * `conversations.agent_id` 是 `ON DELETE RESTRICT`，内核不先查引用，投影层写
 * `agent.removed` 时就会撞外键。
 */
import { describe, expect, it } from 'vitest'
import { decide } from '../../../src/kernel/decide'
import { nextWakeAt } from '../../../src/kernel/next-wake'
import { project } from '../../../src/kernel/project'
import type { KernelPort } from '../../../src/kernel/types'
import { viewSpec } from '../../../src/kernel/view-spec'
import { StoreError, createStore } from '../../../src/host/store/index'
import { captureError, countRows, createMemoryDb } from './test-support'

const realKernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

/** 建一条最小链路：运行时 → 智能体 → 对话；返回 store 与 id。 */
function seedChat() {
  const db = createMemoryDb()
  const store = createStore({ db, kernel: realKernel })

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

  store.dispatch({ type: 'chat.create', commandId: 'c-cv', agentId: agent.id, title: '对话' })
  const conversation = store.query('conversations.all')[0]
  if (conversation === undefined) throw new Error('对话没建出来')

  return { db, store, agent, conversation }
}

describe('删智能体：对话引用（FOREIGN KEY 回归）', () => {
  it('被对话引用时给出可读的 conflict，不抛外键错误、不删行', () => {
    const { db, store, agent, conversation } = seedChat()
    const factsBefore = store.factsCount()

    const error = captureError(() =>
      store.dispatch({ type: 'agent.remove', commandId: 'c-rm', id: agent.id }),
    )

    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).code).toBe('conflict')
    expect(error.message).toBe(
      '智能体被 1 个对话引用（含已归档），无法删除：先删除这些对话，再回来删智能体',
    )
    // 拒删 = 零事实、零变更：智能体与对话都还在（外键错误时同样不落库，但界面拿不到原因）
    expect(store.factsCount()).toBe(factsBefore)
    expect(countRows(db, 'agents')).toBe(1)
    expect(countRows(db, 'conversations')).toBe(1)

    // 删掉对话之后同一个智能体可以正常删除：错误文案指的出口是通的
    store.dispatch({
      type: 'chat.remove',
      commandId: 'c-cv2',
      conversationId: conversation.id,
    })
    store.dispatch({ type: 'agent.remove', commandId: 'c-rm2', id: agent.id })
    expect(countRows(db, 'agents')).toBe(0)
  })

  it('归档（不是删除）的对话仍算引用：提示里写明含已归档', () => {
    const { store, agent, conversation } = seedChat()
    store.dispatch({
      type: 'chat.archive',
      commandId: 'c-arc',
      conversationId: conversation.id,
    })

    const error = captureError(() =>
      store.dispatch({ type: 'agent.remove', commandId: 'c-rm', id: agent.id }),
    )
    expect(error).toBeInstanceOf(StoreError)
    expect(error.message).toBe(
      '智能体被 1 个对话引用（含已归档），无法删除：先删除这些对话，再回来删智能体',
    )
  })
})
