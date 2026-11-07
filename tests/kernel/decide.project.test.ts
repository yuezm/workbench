import { describe, expect, it } from 'vitest'
import type { Command } from '../../src/protocol/commands'
import type {
  Agent,
  Project,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import { decide } from '../../src/kernel/decide'
import type { Environment, IdKind, Limits, View } from '../../src/kernel/types'
import type { AutomationRule } from '../../src/protocol/rules'

const CREATED = '2026-01-01T00:00:00.000Z'
const NOW = '2026-11-04T12:00:00.000Z'

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
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
  handoffWorkflowId: null,
  handoffStageId: null,
  subtaskStageId: null,
  onChildrenSettled: null,
  spawnPolicy: null,
  instructions: '',
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  createdAt: CREATED,
  ...over,
})

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: 'C:/runtime',
  maxConcurrent: 1,
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
  ...over,
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'pj-1',
  name: '工作台',
  path: 'D:/work',
  description: '',
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  projectId: 'pj-1',
  currentStageId: 'st-1',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

interface Seed {
  workflows?: Workflow[]
  stages?: WorkflowStage[]
  agents?: Agent[]
  runtimes?: Runtime[]
  projects?: Project[]
  tasks?: Task[]
  rules?: AutomationRule[]
  rulesVersion?: number
}

const view = (seed: Seed = {}): View => ({
  seq: 7,
  workflows: new Map((seed.workflows ?? [workflow()]).map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? [stage()]).map((row) => [row.id, row])),
  agents: new Map((seed.agents ?? []).map((row) => [row.id, row])),
  runtimes: new Map((seed.runtimes ?? []).map((row) => [row.id, row])),
  projects: new Map((seed.projects ?? [project()]).map((row) => [row.id, row])),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  rules: seed.rules ?? [],
  rulesVersion: seed.rulesVersion ?? 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

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
}

const env = (): Environment => {
  const counters = new Map<IdKind, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-new-${next}`
    },
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

const command = (input: DistributiveOmit<Command, 'commandId'>): Command =>
  ({ commandId: 'c-1', ...input }) as Command

const createdTaskOf = (decision: ReturnType<typeof decide>): Task => {
  const fact = decision.facts.find((item) => item.type === 'task.created')
  if (fact === undefined) throw new Error('应产 task.created')
  return (fact.payload as { task: Task }).task
}

describe('kernel/decide 项目（M10）', () => {
  it('project.create：名称与文件夹必填、名称与路径都唯一，成功落整行', () => {
    expect(
      decide(
        view(),
        command({ type: 'project.create', input: { name: '  ', path: 'D:/work' } }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'invalid_input', message: '项目名称必填' })

    expect(
      decide(
        view(),
        command({ type: 'project.create', input: { name: '工作台', path: '   ' } }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'invalid_input', message: '项目文件夹必填' })

    expect(
      decide(
        view(),
        command({ type: 'project.create', input: { name: '工作台', path: 'D:/other' } }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'conflict', message: '项目名称已存在: 工作台' })

    expect(
      decide(
        view(),
        command({ type: 'project.create', input: { name: '另一个', path: 'D:/work' } }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'conflict', message: '该文件夹已作为项目添加: D:/work' })

    const ok = decide(
      view(),
      command({
        type: 'project.create',
        input: { name: ' 新项目 ', path: ' D:/new ', description: '说明' },
      }),
      NOW,
      env(),
    )
    expect(ok.reject).toBeUndefined()
    expect(ok.facts.map((fact) => fact.type)).toEqual(['project.created'])
    expect((ok.facts[0]?.payload as { project: Project }).project).toEqual({
      id: 'project-new-1',
      name: '新项目',
      path: 'D:/new',
      description: '说明',
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  it('project.update：不存在拒绝、改名与换目录查重、空路径拒绝、成功更新 updatedAt', () => {
    expect(
      decide(
        view(),
        command({ type: 'project.update', id: 'pj-missing', patch: { name: 'x' } }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'not_found', message: '项目不存在: pj-missing' })

    const other = project({ id: 'pj-2', name: '另一个', path: 'D:/other' })
    expect(
      decide(
        view({ projects: [project(), other] }),
        command({ type: 'project.update', id: 'pj-1', patch: { name: '另一个' } }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'conflict', message: '项目名称已存在: 另一个' })

    expect(
      decide(
        view({ projects: [project(), other] }),
        command({ type: 'project.update', id: 'pj-1', patch: { path: 'D:/other' } }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'conflict', message: '该文件夹已作为项目添加: D:/other' })

    expect(
      decide(
        view(),
        command({ type: 'project.update', id: 'pj-1', patch: { path: '   ' } }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'invalid_input', message: '项目文件夹必填' })

    const ok = decide(
      view(),
      command({
        type: 'project.update',
        id: 'pj-1',
        patch: { name: '改名', path: 'D:/moved', description: '新说明' },
      }),
      NOW,
      env(),
    )
    expect(ok.facts.map((fact) => fact.type)).toEqual(['project.updated'])
    expect((ok.facts[0]?.payload as { project: Project }).project).toEqual({
      ...project(),
      name: '改名',
      path: 'D:/moved',
      description: '新说明',
      updatedAt: NOW,
    })
  })

  it('project.remove：不存在幂等、项目下有任务拒绝、空项目删除产 tombstone', () => {
    expect(
      decide(view(), command({ type: 'project.remove', id: 'pj-missing' }), NOW, env()).facts,
    ).toEqual([])

    expect(
      decide(view({ tasks: [task()] }), command({ type: 'project.remove', id: 'pj-1' }), NOW, env())
        .reject,
    ).toEqual({ code: 'conflict', message: '项目下还有任务，无法删除: 工作台' })

    const ok = decide(view(), command({ type: 'project.remove', id: 'pj-1' }), NOW, env())
    expect(ok.facts.map((fact) => fact.type)).toEqual(['project.removed'])
    expect((ok.facts[0]?.payload as { project: Project }).project.id).toBe('pj-1')
  })

  it('task.create：缺项目 / 项目不存在被拒；行上落 projectId，运行目录取项目文件夹', () => {
    const base = view({
      stages: [stage({ entryMode: 'agent', agentId: 'ag-1' })],
      agents: [agent()],
      runtimes: [runtime()],
    })
    const missing = decide(
      base,
      command({ type: 'task.create', input: { title: 't', workflowId: 'wf-1' } as never }),
      NOW,
      env(),
    )
    expect(missing.reject).toEqual({ code: 'invalid_input', message: '任务必须属于一个项目' })

    expect(
      decide(
        view({ projects: [], stages: [stage()] }),
        command({
          type: 'task.create',
          input: { title: 't', workflowId: 'wf-1', projectId: 'pj-9' },
        }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'not_found', message: '项目不存在: pj-9' })

    const ok = decide(
      base,
      command({
        type: 'task.create',
        input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    expect(createdTaskOf(ok).projectId).toBe('pj-1')
    const queued = ok.facts.find((fact) => fact.type === 'run.queued')
    expect((queued?.payload as { run: { cwd: string } }).run.cwd).toBe('D:/work')
  })

  it('task.create：子任务继承父任务项目；挂到别的项目被拒', () => {
    const seeded = view({
      projects: [project(), project({ id: 'pj-2', name: '另一个', path: 'D:/other' })],
      tasks: [task({ threadId: 'th-1' })],
    })
    expect(
      decide(
        seeded,
        command({
          type: 'task.create',
          input: {
            title: '子任务',
            workflowId: 'wf-1',
            projectId: 'pj-2',
            parentTaskId: 't-1',
          },
        }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'invalid_input', message: '子任务必须属于父任务的项目: pj-1' })

    const ok = decide(
      seeded,
      command({
        type: 'task.create',
        input: { title: '子任务', workflowId: 'wf-1', projectId: 'pj-1', parentTaskId: 't-1' },
      }),
      NOW,
      env(),
    )
    expect(createdTaskOf(ok).projectId).toBe('pj-1')
  })

  it('rules.replace：规则目标项目必须存在（老规则不带 projectId 仍可保存）', () => {
    const rule = (projectId?: string): AutomationRule => ({
      id: 'r-1',
      name: '早报',
      when: { cron: '0 9 * * *' },
      to: projectId === undefined ? { workflowId: 'wf-1' } : { workflowId: 'wf-1', projectId },
      enabled: true,
    })

    expect(
      decide(
        view({ projects: [] }),
        command({ type: 'rules.replace', rules: [rule('pj-9')] }),
        NOW,
        env(),
      ).reject,
    ).toEqual({ code: 'invalid_input', message: '规则「早报」: 项目不存在: pj-9' })

    const ok = decide(view(), command({ type: 'rules.replace', rules: [rule('pj-1')] }), NOW, env())
    expect(ok.reject).toBeUndefined()
    expect(ok.facts.map((fact) => fact.type)).toEqual(['rules.replaced'])
  })

  it('project.update：patch 未带 description 时沿用原说明', () => {
    const ok = decide(
      view({ projects: [project({ description: '原说明' })] }),
      command({ type: 'project.update', id: 'pj-1', patch: { name: '改名' } }),
      NOW,
      env(),
    )
    expect(ok.reject).toBeUndefined()
    expect((ok.facts[0]?.payload as { project: Project }).project).toEqual({
      ...project({ description: '原说明' }),
      name: '改名',
      updatedAt: NOW,
    })
  })

  it('project.remove：任务属于别的项目时不算「项目下有任务」，可删除', () => {
    const ok = decide(
      view({ projects: [project()], tasks: [task({ projectId: 'pj-2' })] }),
      command({ type: 'project.remove', id: 'pj-1' }),
      NOW,
      env(),
    )
    expect(ok.reject).toBeUndefined()
    expect(ok.facts.map((fact) => fact.type)).toEqual(['project.removed'])
  })
})
