// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentById,
  createdId,
  runtimeById,
  taskById,
  workflowById,
} from '../../../src/main/ai-workflow/projection-lookup'
import {
  createAgent,
  createRuntime,
  createTask,
  createWorkflow,
  createWorld,
  nextCommandId,
  resetCommandIds,
  type TestWorld,
} from './test-support'

let world: TestWorld

beforeEach(() => {
  resetCommandIds()
  world = createWorld()
})
afterEach(() => world.db.close())

describe('createdId', () => {
  it('按事实类型取新实体 id（四类 create 事实）', () => {
    const runtime = createRuntime(world, { name: 'ds' })
    const workflow = createWorkflow(world, {
      name: 'w',
      stages: [{ name: 's', entryMode: 'none' }],
    })

    const runtimeFacts = world.store.dispatch({
      type: 'runtime.create',
      commandId: nextCommandId(),
      input: { name: 'ds2' },
    }).facts
    const agentFacts = world.store.dispatch({
      type: 'agent.create',
      commandId: nextCommandId(),
      input: { name: 'a2', runtimeId: runtime.id },
    }).facts
    const workflowFacts = world.store.dispatch({
      type: 'workflow.create',
      commandId: nextCommandId(),
      input: { name: 'w2', stages: [{ name: 's', entryMode: 'none' }] },
    }).facts
    const taskFacts = world.store.dispatch({
      type: 'task.create',
      commandId: nextCommandId(),
      input: { title: 'T2', workflowId: workflow.id },
    }).facts

    expect(runtimeById(world.store, createdId(runtimeFacts, 'runtime.created')).name).toBe('ds2')
    expect(agentById(world.store, createdId(agentFacts, 'agent.created')).name).toBe('a2')
    expect(workflowById(world.store, createdId(workflowFacts, 'workflow.created')).name).toBe('w2')
    expect(taskById(world.store, createdId(taskFacts, 'task.created')).title).toBe('T2')
  })

  it('缺少目标事实：报「缺少事实」并带上类型', () => {
    expect(() => createdId([], 'runtime.created')).toThrow('缺少事实: runtime.created')
  })

  it('事实不携带实体 id（update 类）：报错并带上事实类型', () => {
    const runtime = createRuntime(world, { name: 'ds' })
    const facts = world.store.dispatch({
      type: 'runtime.update',
      commandId: nextCommandId(),
      id: runtime.id,
      patch: { name: 'ds2' },
    }).facts

    expect(() => createdId(facts, 'runtime.updated')).toThrow('事实不携带实体 id: runtime.updated')
  })
})

describe('投影按 id 取实体', () => {
  it('取到投影行原样返回', () => {
    const runtime = createRuntime(world, { name: 'ds', maxConcurrent: 2 })
    const agent = createAgent(world, { name: 'coder', runtimeId: runtime.id })
    const workflow = createWorkflow(world, {
      name: 'w',
      stages: [{ name: 's', entryMode: 'none' }],
    })
    const task = createTask(world, { title: 'T', workflowId: workflow.id })

    expect(runtimeById(world.store, runtime.id)).toEqual(runtime)
    expect(agentById(world.store, agent.id)).toEqual(agent)
    expect(workflowById(world.store, workflow.id)).toEqual(workflow)
    expect(workflowById(world.store, workflow.id).stages).toHaveLength(1)
    expect(taskById(world.store, task.id)).toEqual(task)
  })

  it('取不到：按实体给可读错误', () => {
    expect(() => runtimeById(world.store, 'ghost-rt')).toThrow('运行时不存在: ghost-rt')
    expect(() => agentById(world.store, 'ghost-ag')).toThrow('智能体不存在: ghost-ag')
    expect(() => workflowById(world.store, 'ghost-wf')).toThrow('工作流不存在: ghost-wf')
    expect(() => taskById(world.store, 'ghost-tk')).toThrow('任务不存在: ghost-tk')
  })
})
