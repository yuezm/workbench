// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db'
import { createAiWorkflowHandler, registerAiWorkflowIpc } from './ipc'
import { Repository } from './repository'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'

const { ipcMainMock } = vi.hoisted(() => ({ ipcMainMock: { handle: vi.fn() } }))
vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

let db: DatabaseSync
let repo: Repository
let notify: ReturnType<typeof vi.fn>
let handle: ReturnType<typeof createAiWorkflowHandler>

beforeEach(() => {
  vi.clearAllMocks()
  db = openDb(':memory:')
  repo = new Repository(db)
  notify = vi.fn()
  handle = createAiWorkflowHandler(repo, notify as unknown as () => void)
})
afterEach(() => db.close())

describe('ai-workflow handler：运行时/智能体', () => {
  it('runtimes.create 后 list 可见，并触发 changed', () => {
    handle('runtimes.create', [{ name: 'ds', command: 'dsh' }])
    expect(notify).toHaveBeenCalledTimes(1)
    const list = handle('runtimes.list', []) as Array<{ name: string }>
    expect(list.map((r) => r.name)).toEqual(['ds'])
    expect(notify).toHaveBeenCalledTimes(1) // list 不触发
  })

  it('agents.create 绑定运行时；被引用运行时删除报错且不触发 changed', () => {
    const rt = handle('runtimes.create', [{ name: 'ds', command: 'dsh' }]) as { id: string }
    handle('agents.create', [{ name: 'coder', runtimeId: rt.id }])
    expect(notify).toHaveBeenCalledTimes(2)
    notify.mockClear()
    expect(() => handle('runtimes.remove', [rt.id])).toThrow(/引用/)
    expect(notify).not.toHaveBeenCalled()
  })

  it('未知方法抛错', () => {
    expect(() => handle('nope.nope', [])).toThrow(/未知方法/)
  })
})

describe('registerAiWorkflowIpc', () => {
  it('在单一 RPC 通道上注册 handler', () => {
    registerAiWorkflowIpc({ repo, notifyChanged: notify as unknown as () => void })
    expect(ipcMainMock.handle).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, expect.any(Function))
    const h = ipcMainMock.handle.mock.calls[0][1] as (
      e: unknown,
      m: string,
      a: unknown[],
    ) => unknown
    expect(h({}, 'runtimes.list', [])).toEqual([])
  })
})
