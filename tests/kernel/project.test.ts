import { describe, expect, it } from 'vitest'
import type {
  Agent,
  Runtime,
  RuntimeProbe,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { FactPayload, FactType } from '../../src/protocol/facts'
import { project } from '../../src/kernel/project'
import type { Change, Fact, Id, ProjectionRow, ProjectionTable } from '../../src/kernel/types'

const ACTOR = { kind: 'owner', via: 'ui' } as const
const AT = '2026-11-04T12:00:00.000Z'

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: 'd',
  createdAt: AT,
  ...over,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '待办',
  position: 0,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  createdAt: AT,
  ...over,
})

const probe: RuntimeProbe = {
  state: 'ready',
  path: 'C:/bin/dsh.cmd',
  cliVersion: '1.0.0',
  protocolVersion: 1,
  pluginVersion: null,
  error: null,
  output: '',
  elapsedMs: 5,
  checkedAt: AT,
}

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  protocolFamily: 'dsh',
  command: 'dsh',
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: AT,
  lastProbe: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  status: 'active',
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const fact = <T extends FactType>(
  seq: number,
  type: T,
  payload: FactPayload<T>,
  cause?: number,
): Fact<T> => ({ seq, type, actor: ACTOR, at: AT, payload, cause })

const put = (table: ProjectionTable, row: ProjectionRow): Change => ({
  table,
  key: row.id,
  row,
})

const unset = (table: ProjectionTable, key: Id): Change => ({ table, key, row: null })

type Tables = Record<ProjectionTable, Map<Id, ProjectionRow>>

const emptyTables = (): Tables => ({
  tasks: new Map(),
  workflows: new Map(),
  workflow_stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
})

/** 按 seq 顺序 fold 事实：投影应用器的最小等价实现（重建与实时写入共用路径）。 */
const fold = (facts: Fact[]): Tables => {
  const tables = emptyTables()
  for (const item of facts) {
    for (const change of project(item)) {
      const rows = tables[change.table]
      if (change.row === null) rows.delete(change.key)
      else rows.set(change.key, change.row)
    }
  }
  return tables
}

describe('kernel/project', () => {
  it('实体事实 upsert 对应行（五表）', () => {
    expect(project(fact(1, 'workflow.created', { workflow: workflow() }))).toEqual([
      put('workflows', workflow()),
    ])
    expect(
      project(fact(2, 'workflow.updated', { workflow: workflow({ name: '研发v2' }) })),
    ).toEqual([put('workflows', workflow({ name: '研发v2' }))])
    expect(project(fact(3, 'stage.created', { stage: stage() }))).toEqual([
      put('workflow_stages', stage()),
    ])
    expect(
      project(fact(4, 'stage.updated', { stage: stage({ position: 2, entryMode: 'agent' }) })),
    ).toEqual([put('workflow_stages', stage({ position: 2, entryMode: 'agent' }))])
    expect(project(fact(5, 'agent.created', { agent: agent() }))).toEqual([put('agents', agent())])
    expect(project(fact(6, 'agent.updated', { agent: agent({ name: '新名字' }) }))).toEqual([
      put('agents', agent({ name: '新名字' })),
    ])
    expect(project(fact(7, 'runtime.created', { runtime: runtime() }))).toEqual([
      put('runtimes', runtime()),
    ])
    expect(project(fact(8, 'runtime.updated', { runtime: runtime({ enabled: false }) }))).toEqual([
      put('runtimes', runtime({ enabled: false })),
    ])
    expect(project(fact(9, 'runtime.probed', { runtime: runtime({ lastProbe: probe }) }))).toEqual([
      put('runtimes', runtime({ lastProbe: probe })),
    ])
    expect(project(fact(10, 'task.created', { task: task() }))).toEqual([put('tasks', task())])
    expect(
      project(
        fact(11, 'task.moved', {
          task: task({ currentStageId: 'st-2' }),
          from: 'st-1',
          to: 'st-2',
        }),
      ),
    ).toEqual([put('tasks', task({ currentStageId: 'st-2' }))])
    expect(project(fact(12, 'task.completed', { task: task({ status: 'completed' }) }))).toEqual([
      put('tasks', task({ status: 'completed' })),
    ])
  })

  it('删除类事实的 payload 行就是 tombstone，投影写 row:null', () => {
    const removedWorkflow = workflow()
    const deletedStage = stage()
    const removedAgent = agent()
    const removedRuntime = runtime({ lastProbe: probe })
    const removedTask = task()

    expect(project(fact(13, 'workflow.removed', { workflow: removedWorkflow }))).toEqual([
      unset('workflows', removedWorkflow.id),
    ])
    expect(project(fact(14, 'stage.deleted', { stage: deletedStage }))).toEqual([
      unset('workflow_stages', deletedStage.id),
    ])
    expect(project(fact(15, 'agent.removed', { agent: removedAgent }))).toEqual([
      unset('agents', removedAgent.id),
    ])
    expect(project(fact(16, 'runtime.removed', { runtime: removedRuntime }))).toEqual([
      unset('runtimes', removedRuntime.id),
    ])
    expect(project(fact(17, 'task.removed', { task: removedTask }))).toEqual([
      unset('tasks', removedTask.id),
    ])
  })

  it('snapshot.imported 按 payload.table 批量 upsert', () => {
    expect(
      project(
        fact(18, 'snapshot.imported', {
          table: 'workflows',
          rows: [workflow(), workflow({ id: 'wf-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('workflows', workflow()), put('workflows', workflow({ id: 'wf-2' }))])
    expect(
      project(
        fact(19, 'snapshot.imported', {
          table: 'workflow_stages',
          rows: [stage(), stage({ id: 'st-2', position: 1 })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([
      put('workflow_stages', stage()),
      put('workflow_stages', stage({ id: 'st-2', position: 1 })),
    ])
    expect(
      project(
        fact(20, 'snapshot.imported', {
          table: 'tasks',
          rows: [task(), task({ id: 't-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('tasks', task()), put('tasks', task({ id: 't-2' }))])
    expect(
      project(
        fact(21, 'snapshot.imported', {
          table: 'agents',
          rows: [agent(), agent({ id: 'ag-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('agents', agent()), put('agents', agent({ id: 'ag-2' }))])
    expect(
      project(
        fact(22, 'snapshot.imported', {
          table: 'runtimes',
          rows: [runtime(), runtime({ id: 'rt-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('runtimes', runtime()), put('runtimes', runtime({ id: 'rt-2' }))])
  })

  it('重建可重放：同一事实序列 fold 两次结果全等', () => {
    const facts: Fact[] = [
      fact(1, 'snapshot.imported', {
        table: 'workflows',
        rows: [workflow()],
        importedFrom: 'v2',
      }),
      fact(2, 'snapshot.imported', {
        table: 'workflow_stages',
        rows: [stage()],
        importedFrom: 'v2',
      }),
      fact(3, 'snapshot.imported', { table: 'runtimes', rows: [runtime()], importedFrom: 'v2' }),
      fact(4, 'snapshot.imported', { table: 'agents', rows: [agent()], importedFrom: 'v2' }),
      fact(5, 'snapshot.imported', { table: 'tasks', rows: [task()], importedFrom: 'v2' }),
      fact(6, 'stage.created', {
        stage: stage({ id: 'st-2', position: 1, name: '进行中' }),
      }),
      fact(7, 'task.moved', {
        task: task({ currentStageId: 'st-2' }),
        from: 'st-1',
        to: 'st-2',
      }),
      fact(8, 'task.completed', { task: task({ currentStageId: 'st-2', status: 'completed' }) }),
      fact(9, 'stage.deleted', { stage: stage() }),
    ]

    const first = fold(facts)
    const second = fold(facts)

    expect(second).toEqual(first)
    expect(first.workflows.get('wf-1')).toEqual(workflow())
    expect(first.workflow_stages.get('st-1')).toBeUndefined()
    expect(first.workflow_stages.get('st-2')).toEqual(
      stage({ id: 'st-2', position: 1, name: '进行中' }),
    )
    expect(first.tasks.get('t-1')).toEqual(task({ currentStageId: 'st-2', status: 'completed' }))
    expect(first.agents.get('ag-1')).toEqual(agent())
    expect(first.runtimes.get('rt-1')).toEqual(runtime())
  })

  it('删除后再次 upsert 与顺序无关地覆盖同一行（破坏性顺序）', () => {
    const facts: Fact[] = [
      fact(1, 'task.created', { task: task() }),
      fact(2, 'task.removed', { task: task() }),
      fact(3, 'task.created', { task: task({ title: '重建' }) }),
    ]

    const tables = fold(facts)

    expect(tables.tasks.size).toBe(1)
    expect(tables.tasks.get('t-1')).toEqual(task({ title: '重建' }))
  })
})
