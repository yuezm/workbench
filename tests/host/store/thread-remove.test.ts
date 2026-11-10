// @vitest-environment node
/**
 * 删除线程的宿主侧清理（M17）：库里删 run / task / thread 行，磁盘上同步清掉
 * `<artifacts>/threads/<threadId>/`（index.md 与 runs/*）——那些就是这个线程的执行记录。
 *
 * 用真实内核端口（decide / project / viewSpec）而不是假内核：这条路径的价值就在
 * 「事实 → 投影 → 视图」与磁盘清理一起成立，假内核会把事实与投影的对应关系盖住。
 */
import type { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decide } from '../../../src/kernel/decide'
import { nextWakeAt } from '../../../src/kernel/next-wake'
import { project } from '../../../src/kernel/project'
import { viewSpec } from '../../../src/kernel/view-spec'
import type { Task } from '../../../src/protocol/entities'
import type { KernelPort } from '../../../src/kernel/types'
import { createStore } from '../../../src/host/store/index'
import { createMemoryDb } from './test-support'

/** 真实内核端口：store 只认这四个纯函数。 */
const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

let openDbs: DatabaseSync[] = []
let tempRoots: string[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
  tempRoots = []
})

function memory(): DatabaseSync {
  const db = createMemoryDb()
  openDbs.push(db)
  return db
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'wb-thread-'))
  tempRoots.push(root)
  return root
}

/** 建一条工作流 + 一个入口不交给智能体的阶段（不派 run，执行记录由用例自己造）。 */
function seedTask(store: ReturnType<typeof createStore>): { taskId: string; threadId: string } {
  const created = store.dispatch({
    type: 'workflow.create',
    commandId: 'wf-1',
    input: { name: '研发', stages: [{ name: '待办', entryMode: 'none' }] },
  })
  const workflowId = (created.facts[0]?.payload as { workflow: { id: string } }).workflow.id
  const stageId = (created.facts[1]?.payload as { stage: { id: string } }).stage.id
  const taskResult = store.dispatch({
    type: 'task.create',
    commandId: 'task-1',
    input: { title: '写计划', workflowId, stageId },
  })
  const taskId = (
    taskResult.facts.find((fact) => fact.type === 'task.created')?.payload as {
      task: { id: string }
    }
  ).task.id
  const task = store.query('task.byId', { taskId }) as Task
  return { taskId, threadId: task.threadId as string }
}

describe('thread.remove：执行记录随线程一起消失', () => {
  it('删掉 run / task / thread 行，并清掉该线程的落盘归档目录', () => {
    const db = memory()
    const root = tempRoot()
    const artifactsRoot = path.join(root, 'artifacts')
    const store = createStore({ db, kernel, artifactsRoot })
    const { taskId, threadId } = seedTask(store)

    // 宿主落盘的执行记录（index.md + 一个 run 的流水）
    const runDir = path.join(artifactsRoot, 'threads', threadId, 'runs', 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(path.join(artifactsRoot, 'threads', threadId, 'index.md'), '# 线程执行索引\n')
    writeFileSync(path.join(runDir, 'transcript.jsonl'), '{"type":"text","text":"hi"}\n')
    expect(existsSync(path.join(artifactsRoot, 'threads', threadId))).toBe(true)

    const result = store.dispatch({ type: 'thread.remove', commandId: 'rm-1', threadId })

    expect(result.facts.map((fact) => fact.type)).toEqual(['task.removed', 'thread.removed'])
    expect(store.query('thread.byId', { threadId })).toBeNull()
    expect(store.query('task.byId', { taskId })).toBeNull()
    // 执行记录目录整体消失：不留下没有线程归属的 index.md / runs
    expect(existsSync(path.join(artifactsRoot, 'threads', threadId))).toBe(false)
  })

  it('没有配置 artifactsRoot 时只删行，清理一步跳过（不抛错）', () => {
    const db = memory()
    const store = createStore({ db, kernel })
    const { taskId, threadId } = seedTask(store)

    expect(() =>
      store.dispatch({ type: 'thread.remove', commandId: 'rm-1', threadId }),
    ).not.toThrow()
    expect(store.query('thread.byId', { threadId })).toBeNull()
    expect(store.query('task.byId', { taskId })).toBeNull()
  })

  it('同一 commandId 重放：返回原事实，目录已清也不报错', () => {
    const db = memory()
    const root = tempRoot()
    const artifactsRoot = path.join(root, 'artifacts')
    const store = createStore({ db, kernel, artifactsRoot })
    const { threadId } = seedTask(store)

    store.dispatch({ type: 'thread.remove', commandId: 'rm-1', threadId })
    const replay = store.dispatch({ type: 'thread.remove', commandId: 'rm-1', threadId })

    expect(replay.facts.map((fact) => fact.type)).toEqual(['task.removed', 'thread.removed'])
    expect(existsSync(path.join(artifactsRoot, 'threads', threadId))).toBe(false)
  })
})

describe('task.remove：线程里的任务删光时同步删线程', () => {
  it('删掉线程里最后一个任务：线程行一起消失，落盘归档目录一起清掉', () => {
    const db = memory()
    const root = tempRoot()
    const artifactsRoot = path.join(root, 'artifacts')
    const store = createStore({ db, kernel, artifactsRoot })
    const { taskId, threadId } = seedTask(store)

    const runDir = path.join(artifactsRoot, 'threads', threadId, 'runs', 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(path.join(artifactsRoot, 'threads', threadId, 'index.md'), '# 线程执行索引\n')

    const result = store.dispatch({ type: 'task.remove', commandId: 'rm-task', id: taskId })

    // 口径与 thread.remove 一致：先删任务行，再删线程行（执行记录随任务一起删）
    expect(result.facts.map((fact) => fact.type)).toEqual(['task.removed', 'thread.removed'])
    expect(store.query('task.byId', { taskId })).toBeNull()
    expect(store.query('thread.byId', { threadId })).toBeNull()
    // 线程没了，它的落盘归档不能留孤本
    expect(existsSync(path.join(artifactsRoot, 'threads', threadId))).toBe(false)
  })

  it('线程里还有别的任务时线程保留，删光剩下的才连线程一起删', () => {
    const db = memory()
    const store = createStore({ db, kernel })
    const { taskId, threadId } = seedTask(store)
    const parent = store.query('task.byId', { taskId }) as Task
    const createdChild = store.dispatch({
      type: 'task.create',
      commandId: 'task-2',
      input: {
        title: '写实现',
        workflowId: parent.workflowId,
        stageId: parent.currentStageId ?? undefined,
        parentTaskId: taskId,
      },
    })
    const childId = (
      createdChild.facts.find((fact) => fact.type === 'task.created')?.payload as {
        task: { id: string }
      }
    ).task.id
    // 子任务继承父任务线程
    expect((store.query('task.byId', { taskId: childId }) as Task).threadId).toBe(threadId)

    const first = store.dispatch({ type: 'task.remove', commandId: 'rm-1', id: taskId })
    expect(first.facts.map((fact) => fact.type)).toEqual(['task.removed'])
    expect(store.query('thread.byId', { threadId })).not.toBeNull()

    const second = store.dispatch({ type: 'task.remove', commandId: 'rm-2', id: childId })
    expect(second.facts.map((fact) => fact.type)).toEqual(['task.removed', 'thread.removed'])
    expect(store.query('thread.byId', { threadId })).toBeNull()
  })
})
