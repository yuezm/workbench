// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Environment } from '../../../src/kernel/types'
import { KERNEL_VERSION } from '../../../src/kernel/types'
import type { Command } from '../../../src/protocol/commands'
import { projectionFormat } from '../../../src/host/schema'
import { DEFAULT_LIMITS, StoreError, createStore } from '../../../src/host/store/index'
import { createFakeKernel, defaultDecide, defaultProject } from './fake-kernel'
import {
  SAMPLE_AT,
  captureError,
  countRows,
  createMemoryDb,
  dumpProjection,
  sample,
  sampleProbe,
  sequenceIds,
} from './test-support'

let openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

function memory(): DatabaseSync {
  const db = createMemoryDb()
  openDbs.push(db)
  return db
}

const workflowCreate = (name: string, stages = 2, commandId = `create-${name}`): Command => ({
  type: 'workflow.create',
  commandId,
  input: {
    name,
    stages: Array.from({ length: stages }, (_, index) => ({
      name: `阶段 ${index + 1}`,
      entryMode: index === 0 ? ('none' as const) : ('user' as const),
    })),
  },
})

const taskCreate = (title: string, workflowId: string, stageId?: string): Command => ({
  type: 'task.create',
  commandId: `task-${title}`,
  // M10：假内核不校验项目存在性；这里只保证命令形状合法
  input: { title, workflowId, projectId: 'pj-1', ...(stageId === undefined ? {} : { stageId }) },
})

describe('dispatch：事实 + 投影 + 元信息原子提交', () => {
  it('workflow.create：事实按 seq 递增追加，投影与元信息同一次提交写齐', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2'),
    })

    const result = store.dispatch(workflowCreate('流程'))

    expect(result.facts.map((fact) => [fact.seq, fact.type])).toEqual([
      [1, 'workflow.created'],
      [2, 'stage.created'],
      [3, 'stage.created'],
    ])
    expect(result.facts[0]?.at).toBe(SAMPLE_AT)
    expect(result.facts[0]?.actor).toEqual({ kind: 'owner', via: 'ui' })
    expect(store.factsCount()).toBe(3)
    expect(store.factsSince(1).map((fact) => fact.seq)).toEqual([2, 3])
    expect(store.query('workflows.all')).toEqual([
      {
        id: 'wf-1',
        name: '流程',
        description: '',
        createdAt: SAMPLE_AT,
        stages: [
          {
            id: 'st-1',
            workflowId: 'wf-1',
            name: '阶段 1',
            position: 0,
            entryMode: 'none',
            // M18：自己添加的阶段 builtin 为 null
            builtin: null,
            agentId: null,
            onCompleteStageId: null,
            onRejectStageId: null,
            handoffs: [],
            subtaskStageId: null,
            onChildrenSettled: null,
            spawnPolicy: null,
            instructions: '',
            acceptance: [],
            maxRounds: null,
            runTimeoutMs: null,
            gate: null,
          },
          {
            id: 'st-2',
            workflowId: 'wf-1',
            name: '阶段 2',
            position: 1,
            entryMode: 'user',
            builtin: null,
            agentId: null,
            onCompleteStageId: null,
            onRejectStageId: null,
            handoffs: [],
            subtaskStageId: null,
            onChildrenSettled: null,
            spawnPolicy: null,
            instructions: '',
            acceptance: [],
            maxRounds: null,
            runTimeoutMs: null,
            gate: null,
          },
        ],
      },
    ])
    expect(db.prepare('SELECT format, seq FROM projection_meta WHERE id = 1').get()).toEqual({
      format: projectionFormat(KERNEL_VERSION),
      seq: 3,
    })
  })

  it('runtime.probed：完整 Runtime 行入事实，last_probe_json 随行更新（rebuild 后一致）', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('rt-1'),
    })

    store.dispatch({
      type: 'runtime.create',
      commandId: 'rt',
      input: { name: '本机 dsh', executorKey: 'dsh', command: 'dsh' },
    })
    store.dispatch({ type: 'runtime.probed', commandId: 'probe', id: 'rt-1', probe: sampleProbe })

    expect(store.query('runtimes.all')).toEqual([sample.runtime({ lastProbe: sampleProbe })])
    expect(
      (
        db.prepare('SELECT last_probe_json FROM runtimes WHERE id = ?').get('rt-1') as unknown as {
          last_probe_json: string
        }
      ).last_probe_json,
    ).toBe(JSON.stringify(sampleProbe))

    store.rebuild()
    expect(store.query('runtimes.all')).toEqual([sample.runtime({ lastProbe: sampleProbe })])
  })

  it('同批新阶段互相前向引用：延迟外键校验，dispatch 成功', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2', 'st-3'),
    })

    const result = store.dispatch({
      type: 'workflow.create',
      commandId: 'c-forward-ref',
      input: {
        name: '流程',
        stages: [
          { name: '阶段 1', entryMode: 'none', onCompleteIndex: 2 },
          { name: '阶段 2', entryMode: 'none' },
          { name: '阶段 3', entryMode: 'none' },
        ],
      },
    })

    expect(result.facts.map((fact) => fact.type)).toEqual([
      'workflow.created',
      'stage.created',
      'stage.created',
      'stage.created',
    ])
    expect(
      store
        .query('workflows.all')[0]
        ?.stages.map((stage) => [stage.id, stage.position, stage.onCompleteStageId]),
    ).toEqual([
      ['st-1', 0, 'st-3'],
      ['st-2', 1, null],
      ['st-3', 2, null],
    ])
  })

  it('阶段换序：同批两条 stage.updated 交换 position，唯一约束不冲突且 rebuild 等价', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2'),
    })
    store.dispatch(workflowCreate('流程'))

    const reorderKernel = createFakeKernel({
      decide: (view, _input, at) => {
        const first = view.stages.get('st-1')
        const second = view.stages.get('st-2')
        if (!first || !second) {
          return { facts: [], reject: { code: 'not_found', message: '阶段不存在' } }
        }
        return {
          facts: [
            {
              type: 'stage.updated',
              actor: { kind: 'owner', via: 'ui' },
              at,
              payload: { stage: { ...first, position: 1 } },
            },
            {
              type: 'stage.updated',
              actor: { kind: 'owner', via: 'ui' },
              at,
              payload: { stage: { ...second, position: 0 } },
            },
          ],
        }
      },
    })
    const reorderStore = createStore({ db, kernel: reorderKernel, now: () => SAMPLE_AT })

    reorderStore.dispatch({
      type: 'workflow.update',
      commandId: 'reorder',
      id: 'wf-1',
      input: {
        name: '流程',
        stages: [
          { name: '阶段 1', entryMode: 'none' },
          { name: '阶段 2', entryMode: 'none' },
        ],
      },
    })

    expect(
      reorderStore.query('workflows.all')[0]?.stages.map((stage) => [stage.id, stage.position]),
    ).toEqual([
      ['st-2', 0],
      ['st-1', 1],
    ])
    const incremental = dumpProjection(db)
    reorderStore.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
    expect(reorderStore.factsCount()).toBe(5)
  })

  it('投影应用抛错：facts、投影、元信息全部回滚', () => {
    const db = memory()
    const kernel = createFakeKernel({
      project: (fact) => {
        if (fact.type === 'stage.created') throw new Error('project 失败')
        return defaultProject(fact)
      },
    })
    const store = createStore({
      db,
      kernel,
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2'),
    })

    const error = captureError(() => store.dispatch(workflowCreate('流程')))

    expect(error.message).toBe('project 失败')
    expect(store.factsCount()).toBe(0)
    expect(store.factsSince(0)).toEqual([])
    expect(countRows(db, 'workflows')).toBe(0)
    expect(countRows(db, 'workflow_stages')).toBe(0)
    expect(countRows(db, 'projection_meta')).toBe(0)
  })

  it('decide 抛错原样透出，不写任何东西', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel({
        decide: () => {
          throw new Error('decide 失败')
        },
      }),
    })

    expect(captureError(() => store.dispatch(workflowCreate('流程'))).message).toBe('decide 失败')
    expect(store.factsCount()).toBe(0)
    expect(countRows(db, 'projection_meta')).toBe(0)
  })

  it('决策返回空事实：不写库、不写元信息', () => {
    const db = memory()
    const store = createStore({ db, kernel: createFakeKernel({ decide: () => ({ facts: [] }) }) })

    expect(store.dispatch({ type: 'task.remove', commandId: 'c-1', id: 'tk-1' })).toEqual({
      facts: [],
    })
    expect(store.factsCount()).toBe(0)
    expect(countRows(db, 'projection_meta')).toBe(0)
  })
})

describe('dispatch：拒绝与非法输入不落库', () => {
  it('内核 reject 透出 code，不写库', () => {
    const store = createStore({ db: memory(), kernel: createFakeKernel() })

    const error = captureError(() =>
      store.dispatch({ type: 'agent.remove', commandId: 'c-1', id: 'ag-1' }),
    )

    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).code).toBe('unsupported')
    expect(store.factsCount()).toBe(0)
  })

  it('内核 reject 的 invalid_input / forbidden 原样透出', () => {
    const db = memory()
    const kernel = createFakeKernel({
      decide: () => ({ facts: [], reject: { code: 'forbidden', message: '任务执行中' } }),
    })
    const store = createStore({ db, kernel })

    const error = captureError(() => store.dispatch(taskCreate('任务', 'wf-1')))

    expect((error as StoreError).code).toBe('forbidden')
    expect((error as StoreError).message).toBe('任务执行中')
    expect(store.factsCount()).toBe(0)
  })

  it('形状非法：校验层拒绝（invalid_input），不调用内核', () => {
    const db = memory()
    const kernel = createFakeKernel()
    const store = createStore({ db, kernel })

    for (const input of [null, 42, { type: 'nope', commandId: 'c' }, { type: 'workflow.create' }]) {
      const error = captureError(() => store.dispatch(input))
      expect(error).toBeInstanceOf(StoreError)
      expect((error as StoreError).code).toBe('invalid_input')
    }
    expect(kernel.views).toHaveLength(0)
    expect(store.factsCount()).toBe(0)
  })
})

describe('dispatch：序号冲突', () => {
  it('视图装载后另一个写者提交：重读视图重试一次后成功', () => {
    const db = memory()
    const other = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-other', 'st-other'),
    })
    let foreignWritten = false
    const kernel = createFakeKernel({
      decide: (view, input, at, env) => {
        if (!foreignWritten) {
          foreignWritten = true
          other.dispatch(workflowCreate('并发流程', 1))
        }
        return defaultDecide(view, input, at, env)
      },
    })
    let ownId = 0
    const store = createStore({
      db,
      kernel,
      now: () => SAMPLE_AT,
      newId: () => {
        ownId += 1
        return `own-${ownId}`
      },
    })

    const result = store.dispatch(workflowCreate('我的流程', 1))

    expect(result.facts.map((fact) => fact.seq)).toEqual([3, 4])
    expect(kernel.views).toHaveLength(2)
    expect(store.factsCount()).toBe(4)
    expect(store.query('workflows.all').map((workflow) => workflow.name)).toEqual([
      '并发流程',
      '我的流程',
    ])
    expect(db.prepare('SELECT seq FROM projection_meta WHERE id = 1').get()).toEqual({ seq: 4 })
  })

  it('重试仍冲突：报 conflict，只保留另一个写者的事实', () => {
    const db = memory()
    let otherId = 0
    const other = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: () => {
        otherId += 1
        return `other-${otherId}`
      },
    })
    let attempt = 0
    const kernel = createFakeKernel({
      decide: (view, input, at, env) => {
        // 每次重试都用新的 commandId：同一 commandId 现在会幂等回放，写者不再产新事实
        attempt += 1
        other.dispatch(workflowCreate('并发流程', 1, `foreign-${attempt}`))
        return defaultDecide(view, input, at, env)
      },
    })
    const store = createStore({
      db,
      kernel,
      now: () => SAMPLE_AT,
      newId: () => 'own-id',
    })

    const error = captureError(() => store.dispatch(workflowCreate('我的流程', 1)))

    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).code).toBe('conflict')
    expect(kernel.views).toHaveLength(2)
    expect(store.factsCount()).toBe(4)
    expect(store.query('workflows.all').map((workflow) => workflow.name)).toEqual([
      '并发流程',
      '并发流程',
    ])
  })

  it('重试时抛非冲突错误：原样透出，不包装成 conflict', () => {
    const db = memory()
    const other = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-other', 'st-other'),
    })
    let calls = 0
    const kernel = createFakeKernel({
      decide: (view, input, at, env) => {
        calls += 1
        if (calls === 1) {
          other.dispatch(workflowCreate('并发流程', 1))
          return defaultDecide(view, input, at, env)
        }
        throw new Error('重试失败')
      },
    })
    const store = createStore({
      db,
      kernel,
      now: () => SAMPLE_AT,
      newId: () => 'own-id',
    })

    const error = captureError(() => store.dispatch(workflowCreate('我的流程', 1)))

    expect(error.message).toBe('重试失败')
    expect(kernel.views).toHaveLength(2)
    expect(store.factsCount()).toBe(2)
    expect(store.query('workflows.all').map((workflow) => workflow.name)).toEqual(['并发流程'])
  })
})

describe('dispatch：视图装载切片', () => {
  it('只装载 viewSpec 声明的表，活跃 run 的任务集合总是装载', () => {
    const db = memory()
    db.prepare('INSERT INTO runtimes (id, name, executor_key, created_at) VALUES (?, ?, ?, ?)').run(
      'rt-1',
      '运行时',
      'dsh',
      SAMPLE_AT,
    )
    db.prepare('INSERT INTO workflows (id, name, created_at) VALUES (?, ?, ?)').run(
      'wf-1',
      '流程',
      SAMPLE_AT,
    )
    db.prepare(
      'INSERT INTO tasks (id, title, workflow_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('tk-1', '任务', 'wf-1', 'active', SAMPLE_AT, SAMPLE_AT)
    db.prepare('INSERT INTO runs (id, task_id, status, created_at) VALUES (?, ?, ?, ?)').run(
      'run-1',
      'tk-1',
      'running',
      SAMPLE_AT,
    )
    const kernel = createFakeKernel({ viewSpec: () => ['runtimes'], decide: () => ({ facts: [] }) })
    const store = createStore({ db, kernel })

    store.dispatch({ type: 'runtime.remove', commandId: 'c-1', id: 'rt-1' })

    const view = kernel.views[0]
    expect(kernel.viewSpecInputs[0]?.type).toBe('runtime.remove')
    expect([...view.runtimes.keys()]).toEqual(['rt-1'])
    expect(view.workflows.size).toBe(0)
    expect(view.stages.size).toBe(0)
    expect(view.agents.size).toBe(0)
    expect(view.tasks.size).toBe(0)
    expect([...view.activeTaskIds]).toEqual(['tk-1'])
    expect(view.seq).toBe(0)
  })
})

describe('createStore：依赖注入', () => {
  it('注入的 now / newId / timezone / limits 传给内核环境', () => {
    const db = memory()
    let seenAt = ''
    let seenEnv: Environment | undefined
    const kernel = createFakeKernel({
      decide: (_view, _input, at, env) => {
        seenAt = at
        seenEnv = env
        return { facts: [] }
      },
    })
    const store = createStore({
      db,
      kernel,
      now: () => SAMPLE_AT,
      newId: sequenceIds('id-1'),
      timezone: 'Asia/Shanghai',
      limits: { ...DEFAULT_LIMITS, maxStagesPerWorkflow: 3, maxArrayLength: 7 },
    })

    store.dispatch({ type: 'task.remove', commandId: 'c-1', id: 'tk-1' })

    expect(seenAt).toBe(SAMPLE_AT)
    expect(seenEnv?.timezone).toBe('Asia/Shanghai')
    expect(seenEnv?.limits).toEqual({
      ...DEFAULT_LIMITS,
      maxStagesPerWorkflow: 3,
      maxArrayLength: 7,
    })
    expect(seenEnv?.nextId('task')).toBe('id-1')
  })

  it('默认限制与系统时区', () => {
    const db = memory()
    let seenEnv: Environment | undefined
    const kernel = createFakeKernel({
      decide: (_view, _input, _at, env) => {
        seenEnv = env
        return { facts: [] }
      },
    })
    const store = createStore({ db, kernel })

    store.dispatch({ type: 'task.remove', commandId: 'c-1', id: 'tk-1' })

    expect(seenEnv?.limits).toEqual(DEFAULT_LIMITS)
    expect(seenEnv?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(seenEnv?.nextId('task')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('示例行类型与假内核的时间戳一致（夹具自检）', () => {
    expect(sample.runtime().createdAt).toBe(SAMPLE_AT)
    expect(sample.workflow().createdAt).toBe(SAMPLE_AT)
    expect(sample.stage().workflowId).toBe('wf-1')
    expect(sample.task().currentStageId).toBe('st-1')
    expect(sample.agent().runtimeId).toBe('rt-1')
  })

  it('captureError 夹具：没抛错时自身报错，非 Error 抛出归一化', () => {
    expect(() => captureError(() => undefined)).toThrow('预期抛错，但调用没有抛错')

    const thrown = captureError(() => {
      throw 'plain text'
    })
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown.message).toBe('plain text')
  })
})
