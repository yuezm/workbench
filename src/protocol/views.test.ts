import { describe, expect, it } from 'vitest'
import type { Task } from './entities'
import {
  VIEW_IDS,
  type ActiveRun,
  type ViewId,
  type ViewParams,
  type ViewResult,
  type ViewResults,
} from './views'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/** 视图结果映射的键必须恰好覆盖 VIEW_IDS。 */
const resultsCover: Assert<Equal<keyof ViewResults, ViewId>> = true
/** 带参数的视图按 id 取到参数形状；无参数视图为 undefined。 */
const workflowParams: Assert<Equal<ViewParams<'tasks.byWorkflow'>, { workflowId: string }>> = true
const taskParams: Assert<Equal<ViewParams<'task.byId'>, { taskId: string }>> = true
const noParams: Assert<Equal<ViewParams<'agents.all'>, undefined>> = true
/** 泛型取到的返回类型与映射一致。 */
const resultByView: Assert<Equal<ViewResult<'task.byId'>, Task | null>> = true

const activeRun = {
  id: 'r1',
  taskId: 't1',
  stageId: null,
  status: 'queued',
} satisfies ActiveRun

describe('protocol/views', () => {
  it('VIEW_IDS 是 M1 最小集合且顺序稳定', () => {
    expect([...VIEW_IDS]).toEqual([
      'workflows.all',
      'agents.all',
      'runtimes.all',
      'tasks.byWorkflow',
      'task.byId',
      'runs.active-by-task',
    ])
  })

  it('视图 id 不重复，均为小写点分', () => {
    expect(new Set(VIEW_IDS).size).toBe(VIEW_IDS.length)
    for (const id of VIEW_IDS) expect(id).toMatch(/^[a-z-]+\.[A-Za-z-]+$/)
  })

  it('视图类型映射完整（类型级断言）', () => {
    expect(resultsCover).toBe(true)
    expect(workflowParams).toBe(true)
    expect(taskParams).toBe(true)
    expect(noParams).toBe(true)
    expect(resultByView).toBe(true)
  })

  it('活跃 run 只暴露内核判断所需字段', () => {
    expect(Object.keys(activeRun).sort()).toEqual(['id', 'stageId', 'status', 'taskId'])
    expect(activeRun.status).toBe('queued')
  })
})
