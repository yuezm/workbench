// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import type { Fact, KernelPort } from '../../src/kernel/types'
import type { Agent, Runtime, Task, WorkflowWithStages } from '../../src/protocol/entities'
import { openDatabase } from '../../src/host/db'
import { createStore, type Store } from '../../src/host/store/index'
import {
  advanceTask,
  applyStageEffects,
  applyTaskEffects,
  buildTaskPrompt,
  type RunCreator,
} from '../../src/host/task-effects'

const AT = '2026-01-01T00:00:00.000Z'
const OWNER = { kind: 'owner', via: 'ui' } as const

interface CreatedRun {
  id: string
  input: Parameters<RunCreator['runCreate']>[0]
}

interface World {
  db: DatabaseSync
  store: Store
  repo: RunCreator & { runs: CreatedRun[] }
  queued: string[]
}

let world: World
let commandSeq = 0

function nextCommandId(): string {
  commandSeq += 1
  return `cmd-${commandSeq}`
}

function createWorld(): World {
  const db = openDatabase(':memory:')
  const kernel: KernelPort = { decide, project, viewSpec }
  const store = createStore({ db, kernel })
  store.ensureProjection()
  const runs: CreatedRun[] = []
  const repo = {
    runs,
    runCreate(input: CreatedRun['input']) {
      const id = `run-${runs.length + 1}`
      runs.push({ id, input })
      return { id }
    },
  }
  return { db, store, repo, queued: [] }
}

/** 事实 → 新建实体 id（本文件只用于种子）。 */
function createdId(facts: readonly Fact[], type: Fact['type']): string {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error('缺少事实: ' + type)
  switch (fact.type) {
    case 'runtime.created':
      return (fact.payload as { runtime: Runtime }).runtime.id
    case 'agent.created':
      return (fact.payload as { agent: Agent }).agent.id
    case 'workflow.created':
      return (fact.payload as { workflow: { id: string } }).workflow.id
    case 'task.created':
      return (fact.payload as { task: Task }).task.id
    default:
      throw new Error('事实不携带实体 id: ' + fact.type)
  }
}

function seedRuntime(): Runtime {
  const facts = world.store.dispatch({
    type: 'runtime.create',
    commandId: nextCommandId(),
    input: { name: 'ds' },
  }).facts
  return findRuntime(createdId(facts, 'runtime.created'))
}

function seedAgent(runtimeId: string): Agent {
  const facts = world.store.dispatch({
    type: 'agent.create',
    commandId: nextCommandId(),
    input: { name: 'coder', runtimeId, systemPrompt: 'sys' },
  }).facts
  return findAgent(createdId(facts, 'agent.created'))
}

function seedWorkflow(stages: Array<Record<string, unknown>>): WorkflowWithStages {
  const facts = world.store.dispatch({
    type: 'workflow.create',
    commandId: nextCommandId(),
    input: { name: 'w', stages },
  }).facts
  return findWorkflow(createdId(facts, 'workflow.created'))
}

function seedTask(workflowId: string, stageId?: string): Task {
  const facts = world.store.dispatch({
    type: 'task.create',
    commandId: nextCommandId(),
    input: { title: 'T', description: 'd', workflowId, ...(stageId ? { stageId } : {}) },
  }).facts
  return findTask(createdId(facts, 'task.created'))
}

function findRuntime(id: string): Runtime {
  const runtime = world.store.query('runtimes.all').find((item) => item.id === id)
  if (!runtime) throw new Error('运行时不存在: ' + id)
  return runtime
}

function findAgent(id: string): Agent {
  const agent = world.store.query('agents.all').find((item) => item.id === id)
  if (!agent) throw new Error('智能体不存在: ' + id)
  return agent
}

function findWorkflow(id: string): WorkflowWithStages {
  const workflow = world.store.query('workflows.all').find((item) => item.id === id)
  if (!workflow) throw new Error('工作流不存在: ' + id)
  return workflow
}

function findTask(id: string): Task {
  const task = world.store.query('task.byId', { taskId: id })
  if (!task) throw new Error('任务不存在: ' + id)
  return task
}

function effectsDeps() {
  return {
    store: world.store,
    repo: world.repo,
    onQueue: (runId: string) => world.queued.push(runId),
    commandId: nextCommandId,
  }
}

function taskFact(task: Task, from?: string | null, to?: string | null): Fact {
  if (from === undefined) {
    return {
      seq: 1,
      type: 'task.created',
      actor: OWNER,
      at: AT,
      payload: { task },
    }
  }
  return {
    seq: 2,
    type: 'task.moved',
    actor: OWNER,
    at: AT,
    payload: { task, from, to: to ?? null },
  }
}

beforeEach(() => {
  commandSeq = 0
  world = createWorld()
})
afterEach(() => world.db.close())

describe('buildTaskPrompt', () => {
  it('systemPrompt / 任务标题 / 描述 / 阶段名 依次拼接，空段过滤', () => {
    const agent = { systemPrompt: 'sys' } as Agent
    const task = { title: 'T', description: 'd' } as Task
    expect(buildTaskPrompt(agent, task, '执行')).toBe('sys\n\n# 任务：T\n\nd\n\n# 阶段：执行')
    expect(buildTaskPrompt(agent, task, null)).toBe('sys\n\n# 任务：T\n\nd')
  })

  it('空 systemPrompt / 空描述都不留下空段', () => {
    const agent = { systemPrompt: '' } as Agent
    const task = { title: 'T', description: '' } as Task
    expect(buildTaskPrompt(agent, task, '阶段')).toBe('# 任务：T\n\n# 阶段：阶段')
  })
})

describe('applyStageEffects', () => {
  it('只认 createRun：none / waitUser 不建 run', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([{ name: '出门', entryMode: 'agent', agentId: agent.id }])
    const task = seedTask(workflow.id, workflow.stages[0].id)

    expect(applyStageEffects(effectsDeps(), task, [{ type: 'none' }])).toEqual([])
    expect(applyStageEffects(effectsDeps(), task, [{ type: 'waitUser' }])).toEqual([])
    expect(world.repo.runs).toHaveLength(0)
    expect(world.queued).toEqual([])
  })

  it('createRun：按智能体绑定的运行时建 queued run，并把 runId 交给 onQueue', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([{ name: '出门', entryMode: 'agent', agentId: agent.id }])
    const task = seedTask(workflow.id, workflow.stages[0].id)

    const ids = applyStageEffects(effectsDeps(), task, [
      { type: 'createRun', stageId: workflow.stages[0].id, agentId: agent.id },
    ])

    expect(ids).toHaveLength(1)
    expect(world.queued).toEqual(ids)
    const run = world.repo.runs[0]
    expect(run.id).toBe(ids[0])
    expect(run.input).toMatchObject({
      taskId: task.id,
      stageId: workflow.stages[0].id,
      agentId: agent.id,
      runtimeId: runtime.id,
      status: 'queued',
    })
    expect(run.input.prompt).toBe('sys\n\n# 任务：T\n\nd\n\n# 阶段：出门')
  })

  it('createRun 的阶段不在工作流里：照常建 run，prompt 不带阶段段', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([{ name: '出门', entryMode: 'agent', agentId: agent.id }])
    const task = seedTask(workflow.id, workflow.stages[0].id)

    const ids = applyStageEffects(effectsDeps(), task, [
      { type: 'createRun', stageId: 'st-404', agentId: agent.id },
    ])

    expect(ids).toHaveLength(1)
    expect(world.repo.runs[0].input.stageId).toBe('st-404')
    expect(world.repo.runs[0].input.prompt).toBe('sys\n\n# 任务：T\n\nd')
  })
})

describe('applyTaskEffects', () => {
  it('task.created 进入 agent 阶段：建 run 并通知调度器', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([{ name: '执行', entryMode: 'agent', agentId: agent.id }])
    const task = seedTask(workflow.id)

    const ids = applyTaskEffects(effectsDeps(), [taskFact(task)])

    expect(ids).toHaveLength(1)
    expect(world.queued).toEqual(ids)
    expect(world.repo.runs[0].input.stageId).toBe(workflow.stages[0].id)
  })

  it('task.created 进入 none 阶段：不建 run', () => {
    const workflow = seedWorkflow([{ name: '待办', entryMode: 'none' }])
    const task = seedTask(workflow.id)

    expect(applyTaskEffects(effectsDeps(), [taskFact(task)])).toEqual([])
    expect(world.repo.runs).toHaveLength(0)
  })

  it('task.created 进入 user 阶段：等人，不建 run', () => {
    const workflow = seedWorkflow([{ name: '审核', entryMode: 'user' }])
    const task = seedTask(workflow.id)

    expect(applyTaskEffects(effectsDeps(), [taskFact(task)])).toEqual([])
    expect(world.queued).toEqual([])
  })

  it('task.moved 进入新阶段：建 run；from === to 不重复触发', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([
      { name: '待办', entryMode: 'none' },
      { name: '执行', entryMode: 'agent', agentId: agent.id },
    ])
    const task = seedTask(workflow.id, workflow.stages[1].id)

    const again = applyTaskEffects(effectsDeps(), [
      taskFact(task, workflow.stages[1].id, workflow.stages[1].id),
    ])
    expect(again).toEqual([])
    expect(world.repo.runs).toHaveLength(0)

    const moved = applyTaskEffects(effectsDeps(), [
      taskFact(task, workflow.stages[0].id, workflow.stages[1].id),
    ])
    expect(moved).toHaveLength(1)
    expect(world.queued).toEqual(moved)
    expect(world.repo.runs[0].input.stageId).toBe(workflow.stages[1].id)
  })

  it('已完成任务 / 无当前阶段：不建 run', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([{ name: '执行', entryMode: 'agent', agentId: agent.id }])
    const task = seedTask(workflow.id)
    world.store.dispatch({ type: 'task.complete', commandId: nextCommandId(), id: task.id })
    const completed = findTask(task.id)

    expect(applyTaskEffects(effectsDeps(), [taskFact(completed)])).toEqual([])

    const noStage: Task = { ...task, currentStageId: null }
    expect(applyTaskEffects(effectsDeps(), [taskFact(noStage)])).toEqual([])
    expect(world.repo.runs).toHaveLength(0)
  })

  it('工作流 / 智能体不存在：抛可读错误', () => {
    const task = {
      id: 't',
      workflowId: 'ghost',
      status: 'active',
      currentStageId: 'st',
    } as Task
    expect(() => applyTaskEffects(effectsDeps(), [taskFact(task)])).toThrow(/工作流不存在/)

    const workflow = seedWorkflow([{ name: '待办', entryMode: 'none' }])
    const seeded = seedTask(workflow.id)
    expect(() =>
      applyStageEffects(effectsDeps(), seeded, [
        { type: 'createRun', stageId: workflow.stages[0].id, agentId: 'ghost' },
      ]),
    ).toThrow(/智能体不存在/)
  })

  it('非任务事实（配置类）：直接跳过，不建 run', () => {
    const workflow = seedWorkflow([{ name: '待办', entryMode: 'none' }])
    const configFact: Fact = {
      seq: 1,
      type: 'workflow.created',
      actor: OWNER,
      at: AT,
      payload: {
        workflow: {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          createdAt: workflow.createdAt,
        },
      },
    }

    expect(applyTaskEffects(effectsDeps(), [configFact])).toEqual([])
    expect(world.repo.runs).toHaveLength(0)
  })
})

describe('advanceTask', () => {
  it('RUN_SUCCEEDED：推进到下一 agent 阶段并建下一条 run', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([
      { name: '执行1', entryMode: 'agent', agentId: agent.id },
      { name: '执行2', entryMode: 'agent', agentId: agent.id },
    ])
    const task = seedTask(workflow.id)

    const advanced = advanceTask(
      effectsDeps(),
      task.id,
      { type: 'RUN_SUCCEEDED', runId: 'r1' },
      (id) => world.queued.push(id),
    )

    expect(advanced.currentStageId).toBe(workflow.stages[1].id)
    expect(advanced.status).toBe('active')
    expect(world.repo.runs).toHaveLength(1)
    expect(world.repo.runs[0].input.stageId).toBe(workflow.stages[1].id)
    expect(world.queued).toEqual([world.repo.runs[0].id])
  })

  it('RUN_SUCCEEDED 到终端：任务完成，不再建 run', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([{ name: '唯一', entryMode: 'agent', agentId: agent.id }])
    const task = seedTask(workflow.id)

    const advanced = advanceTask(effectsDeps(), task.id, { type: 'RUN_SUCCEEDED', runId: 'r1' })

    expect(advanced.status).toBe('completed')
    expect(world.repo.runs).toHaveLength(0)
    expect(findTask(task.id).status).toBe('completed')
  })

  it('RUN_FAILED 在首阶段：原地零效果（不写库、不建 run）', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([
      { name: '执行', entryMode: 'agent', agentId: agent.id },
      { name: '完成', entryMode: 'none' },
    ])
    const task = seedTask(workflow.id)

    const advanced = advanceTask(effectsDeps(), task.id, { type: 'RUN_FAILED', runId: 'r1' })

    expect(advanced.currentStageId).toBe(workflow.stages[0].id)
    expect(advanced.status).toBe('active')
    expect(world.repo.runs).toHaveLength(0)
  })

  it('RUN_FAILED 打回上一阶段：落回目标阶段', () => {
    const runtime = seedRuntime()
    const agent = seedAgent(runtime.id)
    const workflow = seedWorkflow([
      { name: '执行', entryMode: 'agent', agentId: agent.id },
      { name: '审核', entryMode: 'user' },
    ])
    const task = seedTask(workflow.id, workflow.stages[1].id)

    const advanced = advanceTask(effectsDeps(), task.id, { type: 'RUN_FAILED', runId: 'r1' })

    expect(advanced.currentStageId).toBe(workflow.stages[0].id)
    expect(world.repo.runs).toHaveLength(1)
  })

  it('任务不存在 / 当前阶段无效：抛错', () => {
    expect(() =>
      advanceTask(effectsDeps(), 'ghost', { type: 'RUN_SUCCEEDED', runId: 'r' }),
    ).toThrow(/任务不存在/)

    const workflow = seedWorkflow([{ name: '只有一个', entryMode: 'none' }])
    const task = seedTask(workflow.id)
    world.db.prepare('UPDATE tasks SET current_stage_id=NULL WHERE id=?').run(task.id)
    expect(() =>
      advanceTask(effectsDeps(), task.id, { type: 'RUN_SUCCEEDED', runId: 'r' }),
    ).toThrow(/任务当前阶段无效/)
  })
})
