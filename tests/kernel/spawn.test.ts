import { describe, expect, it } from 'vitest'
import type { Agent, Runtime, Task, Workflow, WorkflowStage } from '../../src/protocol/entities'
import type { SpawnTask } from '../../src/protocol/inputs'
import {
  childrenSettledFacts,
  resolveSubtaskStage,
  spawnDepth,
  spawnFacts,
} from '../../src/kernel/spawn'
import type { Environment, Limits, View } from '../../src/kernel/types'

const AT = '2026-11-06T12:00:00.000Z'

const LIMITS: Limits = {
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 300_000,
  backoffCapMs: 3_600_000,
  runTimeoutMs: 1_800_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
  maxSpawnItems: 32,
  maxSpawnDepth: 8,
}

let counter = 0
const env = (): Environment => ({
  timezone: 'Asia/Shanghai',
  limits: LIMITS,
  nextId: (kind) => `${kind}-${(counter += 1)}`,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '进行中',
  position: 1,
  entryMode: 'agent',
  agentId: 'ag-1',
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffWorkflowId: null,
  handoffStageId: null,
  subtaskStageId: null,
  onChildrenSettled: null,
  spawnPolicy: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 'tk-1',
  title: '实现登录模块',
  description: '',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: 'th-1',
  parentTaskId: null,
  spawnedByRunId: null,
  batchNo: null,
  spawnKey: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const workflow: Workflow = { id: 'wf-1', name: '研发', description: '', createdAt: AT }

const agent: Agent = {
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  createdAt: AT,
}

const runtime: Runtime = {
  id: 'rt-1',
  name: 'dsh',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: AT,
  lastProbe: null,
}

const thread = {
  id: 'th-1',
  source: 'manual',
  externalRef: null,
  title: '父任务',
  status: 'open' as const,
  taskIds: ['tk-1'],
  rootTaskIds: ['tk-1'],
  concurrency: 1,
  notesVersion: 0,
  notes: [],
  events: [],
  lastActivityAt: AT,
  createdAt: AT,
}

function makeView(over: Partial<View> = {}): View {
  return {
    seq: 0,
    workflows: new Map([[workflow.id, workflow]]),
    stages: new Map([['st-1', stage()]]),
    agents: new Map([[agent.id, agent]]),
    runtimes: new Map([[runtime.id, runtime]]),
    tasks: new Map([['tk-1', task()]]),
    runs: new Map(),
    cards: new Map(),
    conversations: new Map(),
    messages: new Map(),
    threads: new Map([[thread.id, thread]]),
    taskComments: new Map(),
    activeTaskIds: new Set(),
    rules: [],
    rulesVersion: 0,
    ruleSetReplacedAt: null,
    ruleFiredAt: new Map(),
    pluginSettings: [],
    pluginSettingsVersion: 0,
    ...over,
  }
}

const run = { id: 'run-1', taskId: 'tk-1' }

function createdTasks(facts: ReturnType<typeof spawnFacts>): Task[] {
  return facts
    .filter((fact) => fact.type === 'task.created')
    .map((fact) => (fact.payload as { task: Task }).task)
}

const spawn = (over: Partial<SpawnTask> = {}): SpawnTask => ({
  subject: '子任务',
  ...over,
})

describe('kernel/spawn：spawnFacts', () => {
  it('建 N 个子任务：parentTaskId 挂父、继承线程、origin=spawn、spawnedByRunId=父 run', () => {
    const view = makeView()
    const facts = spawnFacts(view, run, [spawn({ key: 'a' }), spawn({ subject: 'B' })], AT, env(), {
      kind: 'host',
      via: 'scheduler',
    })
    const children = createdTasks(facts)
    expect(children).toHaveLength(2)
    expect(children[0]).toMatchObject({
      parentTaskId: 'tk-1',
      threadId: 'th-1',
      origin: 'spawn',
      spawnedByRunId: 'run-1',
      spawnKey: 'a',
      workflowId: 'wf-1',
      currentStageId: 'st-1',
    })
    // 子任务进入 agent 阶段 → 各自有 queued run
    expect(facts.filter((fact) => fact.type === 'run.queued')).toHaveLength(2)
    // 线程挂载：两个 task_attached
    expect(facts.filter((fact) => fact.type === 'thread.task_attached')).toHaveLength(2)
  })

  it('同批重复 key / 既有子任务同 key：不重复建', () => {
    const existing = task({
      id: 'tk-child',
      parentTaskId: 'tk-1',
      spawnKey: 'done',
      origin: 'spawn',
    })
    const view = makeView({
      tasks: new Map([
        ['tk-1', task()],
        ['tk-child', existing],
      ]),
    })
    const facts = spawnFacts(
      view,
      run,
      [spawn({ key: 'done' }), spawn({ key: 'x' }), spawn({ key: 'x' })],
      AT,
      env(),
      { kind: 'host', via: 'scheduler' },
    )
    expect(createdTasks(facts).map((child) => child.spawnKey)).toEqual(['x'])
  })

  it('父任务非 active / 阶段 spawnPolicy=off / 深度超限：零事实', () => {
    const inactive = makeView({ tasks: new Map([['tk-1', task({ status: 'completed' })]]) })
    expect(
      spawnFacts(inactive, run, [spawn()], AT, env(), { kind: 'host', via: 'scheduler' }),
    ).toEqual([])

    const off = makeView({ stages: new Map([['st-1', stage({ spawnPolicy: 'off' })]]) })
    expect(spawnFacts(off, run, [spawn()], AT, env(), { kind: 'host', via: 'scheduler' })).toEqual(
      [],
    )

    // 构造 8 层链：最深的父任务不允许再派生
    const chain = new Map<string, Task>()
    let parentId: string | null = null
    for (let i = 0; i < 9; i += 1) {
      const id = `deep-${i}`
      chain.set(id, task({ id, parentTaskId: parentId, status: 'active' }))
      parentId = id
    }
    const deepest = [...chain.values()].at(-1) as Task
    const deep = makeView({ tasks: mapOf([...chain.values()]) })
    expect(spawnDepth(deep, deepest)).toBe(8)
    expect(
      spawnFacts(deep, { id: 'run-1', taskId: deepest.id }, [spawn()], AT, env(), {
        kind: 'host',
        via: 'scheduler',
      }),
    ).toEqual([])
  })

  it('落点阶段三级优先级：item.stageId ＞ 父阶段 subtaskStageId ＞ 父当前阶段', () => {
    const other = stage({ id: 'st-2', name: '待办', position: 0, entryMode: 'none', agentId: null })
    const configured = stage({ id: 'st-3', name: '子任务', position: 2, subtaskStageId: 'st-2' })
    const view = makeView({
      stages: new Map([
        ['st-1', configured],
        ['st-2', other],
      ]),
    })
    const parent = task()
    expect(resolveSubtaskStage(view, parent, 'st-2')).toBe('st-2')
    expect(resolveSubtaskStage(view, parent, 'unknown')).toBe('st-2')
    expect(resolveSubtaskStage(view, task({ currentStageId: 'st-1' }), undefined)).toBe('st-2')
  })
})

describe('kernel/spawn：childrenSettledFacts', () => {
  const doneChild = task({
    id: 'tk-child',
    parentTaskId: 'tk-1',
    status: 'completed',
    origin: 'spawn',
  })

  it('全部子任务完成 → 审计事实 + 唤醒父 Agent（agent 阶段默认 wake）', () => {
    const view = makeView({
      tasks: new Map([
        ['tk-1', task()],
        ['tk-child', doneChild],
      ]),
    })
    const facts = childrenSettledFacts(view, 'tk-1', AT, env(), { kind: 'host', via: 'scheduler' })
    expect(facts[0]).toMatchObject({
      type: 'task.children_settled',
      payload: { parentTaskId: 'tk-1', action: 'wake', childIds: ['tk-child'] },
    })
    expect(facts.filter((fact) => fact.type === 'run.queued')).toHaveLength(1)
  })

  it('还有子任务未终态 / 父已有活跃 run：不触发', () => {
    const view = makeView({
      tasks: new Map([
        ['tk-1', task()],
        ['tk-child', doneChild],
        ['tk-open', task({ id: 'tk-open', parentTaskId: 'tk-1' })],
      ]),
    })
    expect(
      childrenSettledFacts(view, 'tk-1', AT, env(), { kind: 'host', via: 'scheduler' }),
    ).toEqual([])

    const busy = makeView({
      tasks: new Map([
        ['tk-1', task()],
        ['tk-child', doneChild],
      ]),
      activeTaskIds: new Set(['tk-1']),
    })
    expect(
      childrenSettledFacts(busy, 'tk-1', AT, env(), { kind: 'host', via: 'scheduler' }),
    ).toEqual([])
  })

  it('父阶段配置 complete / notify：分别产 task.completed / 任务评论', () => {
    const cases = [
      {
        action: 'complete' as const,
        assert: (facts: ReturnType<typeof childrenSettledFacts>) =>
          expect(facts.some((fact) => fact.type === 'task.completed')).toBe(true),
      },
      {
        action: 'notify' as const,
        assert: (facts: ReturnType<typeof childrenSettledFacts>) =>
          expect(facts.some((fact) => fact.type === 'task.comment_added')).toBe(true),
      },
    ]
    for (const item of cases) {
      const view = makeView({
        stages: new Map([['st-1', stage({ onChildrenSettled: item.action })]]),
        tasks: new Map([
          ['tk-1', task()],
          ['tk-child', doneChild],
        ]),
      })
      const facts = childrenSettledFacts(view, 'tk-1', AT, env(), {
        kind: 'host',
        via: 'scheduler',
      })
      expect(facts[0].type).toBe('task.children_settled')
      item.assert(facts)
    }
  })

  it('非 agent 阶段且未配置：降级 notify', () => {
    const view = makeView({
      stages: new Map([['st-1', stage({ entryMode: 'user', agentId: null })]]),
      tasks: new Map([
        ['tk-1', task()],
        ['tk-child', doneChild],
      ]),
    })
    const facts = childrenSettledFacts(view, 'tk-1', AT, env(), { kind: 'host', via: 'scheduler' })
    expect((facts[0].payload as { action: string }).action).toBe('notify')
    expect(facts.some((fact) => fact.type === 'task.comment_added')).toBe(true)
  })
})

function mapOf(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((item) => [item.id, item]))
}

describe('kernel/spawn：边界分支', () => {
  const actor = { kind: 'host', via: 'scheduler' } as const

  it('无 task / 无线程 / 单批超上限 / 无子任务：零事实或截断', () => {
    const view = makeView()
    expect(spawnFacts(view, { id: 'run-1', taskId: null }, [spawn()], AT, env(), actor)).toEqual([])

    const noThread = makeView({
      threads: new Map(),
      tasks: new Map([['tk-1', task({ threadId: null })]]),
    })
    const facts = spawnFacts(noThread, run, [spawn()], AT, env(), actor)
    expect(createdTasks(facts)).toHaveLength(1)
    expect(facts.some((fact) => fact.type === 'thread.task_attached')).toBe(false)

    const many = Array.from({ length: 40 }, (_, i) => spawn({ key: `k${i}` }))
    expect(createdTasks(spawnFacts(view, run, many, AT, env(), actor))).toHaveLength(32)

    expect(childrenSettledFacts(view, 'ghost', AT, env(), actor)).toEqual([])
    expect(childrenSettledFacts(view, 'tk-1', AT, env(), actor)).toEqual([])
  })

  it('父阶段不存在：rollup 降级 notify（不产 run）', () => {
    const child = task({ id: 'tk-child', parentTaskId: 'tk-1', status: 'completed' })
    const view = makeView({
      tasks: new Map([
        ['tk-1', task({ currentStageId: 'st-missing' })],
        ['tk-child', child],
      ]),
    })
    const facts = childrenSettledFacts(view, 'tk-1', AT, env(), actor)
    expect((facts[0].payload as { action: string }).action).toBe('notify')
    expect(facts.some((fact) => fact.type === 'task.comment_added')).toBe(true)
    expect(facts.some((fact) => fact.type === 'run.queued')).toBe(false)
  })

  it('spawnDepth 对环安全（提前退出）', () => {
    const a = task({ id: 'a', parentTaskId: 'b' })
    const b = task({ id: 'b', parentTaskId: 'a' })
    const view = makeView({
      tasks: new Map([
        ['a', a],
        ['b', b],
      ]),
    })
    expect(spawnDepth(view, a)).toBeGreaterThan(0)
    expect(spawnDepth(view, a)).toBeLessThanOrEqual(65)
  })

  it('父任务无当前阶段：落点回退首阶段；open children-settled 卡阻止 rollup', () => {
    const view = makeView({ tasks: new Map([['tk-1', task({ currentStageId: null })]]) })
    expect(resolveSubtaskStage(view, task({ currentStageId: null }), undefined)).toBe('st-1')

    const child = task({ id: 'tk-child', parentTaskId: 'tk-1', status: 'completed' })
    const withCard = makeView({
      tasks: new Map([
        ['tk-1', task()],
        ['tk-child', child],
      ]),
    })
    withCard.cards.set('c1', {
      taskId: 'tk-1',
      status: 'open',
      key: 'children-settled',
    } as never)
    expect(childrenSettledFacts(withCard, 'tk-1', AT, env(), actor)).toEqual([])
  })

  it('父任务无当前阶段 / 无可用阶段 / 不匹配的卡：回退或跳过', () => {
    const noStageParent = makeView({
      tasks: new Map([['tk-1', task({ currentStageId: null })]]),
    })
    expect(createdTasks(spawnFacts(noStageParent, run, [spawn()], AT, env(), actor))).toHaveLength(
      1,
    )

    const noStages = makeView({
      stages: new Map(),
      tasks: new Map([['tk-1', task({ currentStageId: null })]]),
    })
    expect(spawnFacts(noStages, run, [spawn()], AT, env(), actor)).toEqual([])

    const child = task({ id: 'tk-child', parentTaskId: 'tk-1', status: 'completed' })
    const nullStage = makeView({
      tasks: new Map([
        ['tk-1', task({ currentStageId: null })],
        ['tk-child', child],
      ]),
    })
    const rollup = childrenSettledFacts(nullStage, 'tk-1', AT, env(), actor)
    expect((rollup[0].payload as { action: string }).action).toBe('notify')
    // 不匹配的卡走循环 false 分支，不影响 rollup
    nullStage.cards.set('c0', { taskId: 'other', status: 'open', key: 'x' } as never)
    expect(childrenSettledFacts(nullStage, 'tk-1', AT, env(), actor).length).toBeGreaterThan(0)
  })

  it('超长标题 / 描述按上限截断', () => {
    const long = spawn({ subject: 'x'.repeat(300), summary: 'y'.repeat(3_000) })
    const [created] = createdTasks(spawnFacts(makeView(), run, [long], AT, env(), actor))
    expect(created.title).toHaveLength(200)
    expect(created.description).toHaveLength(2_000)
  })
})
