// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { COMMAND_NAMES, type Command } from '../../../src/protocol/commands'
import type {
  AgentInput,
  ProjectInput,
  RuntimeInput,
  TaskInput,
  WorkflowInput,
} from '../../../src/protocol/entities'
import { ENTITY_TABLES } from '../../../src/protocol/entities'
import { HOST_INPUT_NAMES, type Input } from '../../../src/protocol/inputs'
import { PROJECTION_TABLES, type ProjectionTable } from '../../../src/kernel/core/types'
import { viewSpec } from '../../../src/kernel/scopes/view-spec'

const workflowInput: WorkflowInput = {
  name: '研发',
  stages: [
    { name: '待办', entryMode: 'none' },
    { name: '实现', entryMode: 'agent', agentId: 'ag-1' },
  ],
}

const agentInput: AgentInput = { name: '实现者', runtimeId: 'rt-1' }

const runtimeInput: RuntimeInput = { name: '本机 dsh' }

const projectInput: ProjectInput = { name: '工作台', path: 'D:/work' }

const taskInput: TaskInput = { title: '任务', workflowId: 'wf-1', projectId: 'pj-1' }

const commandSamples: Command[] = [
  { commandId: 'c1', type: 'workflow.create', input: workflowInput },
  { commandId: 'c2', type: 'workflow.update', id: 'wf-1', input: workflowInput },
  { commandId: 'c3', type: 'workflow.remove', id: 'wf-1' },
  { commandId: 'c4', type: 'agent.create', input: agentInput },
  { commandId: 'c5', type: 'agent.update', id: 'ag-1', patch: { name: '新名字' } },
  { commandId: 'c6', type: 'agent.remove', id: 'ag-1' },
  { commandId: 'c7', type: 'runtime.create', input: runtimeInput },
  { commandId: 'c8', type: 'runtime.update', id: 'rt-1', patch: { enabled: false } },
  { commandId: 'c9', type: 'runtime.remove', id: 'rt-1' },
  {
    commandId: 'c10',
    type: 'runtime.probed',
    id: 'rt-1',
    probe: {
      state: 'ready',
      path: null,
      cliVersion: null,
      protocolVersion: 1,
      pluginVersion: null,
      error: null,
      output: '',
      elapsedMs: 1,
      checkedAt: '2026-11-04T12:00:00.000Z',
    },
  },
  { commandId: 'c11', type: 'task.create', input: taskInput },
  { commandId: 'c12', type: 'task.move', id: 't-1', stageId: 'st-2' },
  { commandId: 'c13', type: 'task.complete', id: 't-1' },
  { commandId: 'c13b', type: 'task.stop', id: 't-1' },
  { commandId: 'c14', type: 'task.remove', id: 't-1' },
  { commandId: 'c15', type: 'card.answer', cardId: 'card-1', optionIndex: 0, via: 'channel' },
  { commandId: 'c16', type: 'card.resolve', cardId: 'card-1' },
  { commandId: 'c17', type: 'chat.create', agentId: 'ag-1' },
  { commandId: 'c18', type: 'chat.send', conversationId: 'cv-1', content: '你好' },
  { commandId: 'c19', type: 'chat.remove', conversationId: 'cv-1' },
  { commandId: 'c20', type: 'chat.cancel', conversationId: 'cv-1' },
  { commandId: 'c21', type: 'chat.archive', conversationId: 'cv-1', archived: true },
  {
    commandId: 'c21',
    type: 'app.event',
    appId: 'pomodoro',
    eventType: 'pomodoro.completed',
    subject: '番茄结束',
  },
  { commandId: 'c22', type: 'runtime.probe', id: 'rt-1' },
  {
    commandId: 'c23',
    type: 'rules.replace',
    rules: [
      {
        id: 'rule-1',
        name: '每日早报',
        when: { cron: '0 9 * * *' },
        to: { workflowId: 'wf-1' },
        enabled: true,
      },
    ],
  },
  { commandId: 'c24', type: 'rule.trigger', ruleId: 'rule-1' },
  { commandId: 'c25', type: 'rule.replay', ruleId: 'rule-1' },
  { commandId: 'c25', type: 'thread.note', threadId: 'th-1', text: '备注' },
  { commandId: 'c26', type: 'thread.close', threadId: 'th-1' },
  {
    commandId: 'c27',
    type: 'thread.bind',
    threadId: 'th-1',
    source: 'github',
    externalRef: 'issue-1',
  },
  { commandId: 'c28', type: 'plugins.replace', settings: [] },
  { commandId: 'c29', type: 'plugin.set', pluginId: 'webhook', enabled: true },
  { commandId: 'c37', type: 'review.export', taskId: 't-1' },
  { commandId: 'c30', type: 'task.comment', taskId: 't-1', text: '按钮改成粉色', rerun: true },
  { commandId: 'c30b', type: 'task.rerun', id: 't-1' },
  { commandId: 'c31', type: 'project.create', input: projectInput },
  { commandId: 'c34', type: 'thread.remove', threadId: 'th-1' },
  { commandId: 'c32', type: 'project.update', id: 'pj-1', patch: { name: '新名字' } },
  { commandId: 'c33', type: 'project.remove', id: 'pj-1' },
]

const hostSamples: Input[] = [
  { type: 'run.claim', runtimeId: 'rt-1', capacity: 2 },
  { type: 'run.heartbeat', runId: 'run-1', leaseId: 'run-1:1' },
  {
    type: 'run.receipt',
    runId: 'run-1',
    receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1 },
  },
  {
    type: 'run.frames',
    runId: 'run-1',
    turn: 1,
    frames: [{ runId: 'run-1', seq: 1, type: 'text', text: 'hi' }],
  },
  { type: 'run.host_settled', runId: 'run-1', status: 'cancelled', errorCode: 'cancelled' },
  { type: 'run.cancel', runId: 'run-1' },
  { type: 'clock.tick' },
  { type: 'card.delivered', cardId: 'card-1', version: 1, ref: 'in-app' },
  { type: 'card.delivery_failed', cardId: 'card-1', version: 1, error: '通道不可用' },
  {
    type: 'event.received',
    event: { source: 'github', type: 'issues.opened', subject: 'issue-1' },
  },
]

const samples: Input[] = [...commandSamples, ...hostSamples]

const expected: Record<Input['type'], ProjectionTable[]> = {
  'workflow.create': ['agents', 'runtimes', 'workflows', 'workflow_stages'],
  'workflow.update': ['workflows', 'workflow_stages', 'agents', 'runtimes', 'tasks'],
  'workflow.remove': ['workflows', 'workflow_stages', 'tasks', 'runs'],
  'agent.create': ['runtimes'],
  'agent.update': ['agents', 'runtimes'],
  'agent.remove': ['agents', 'workflow_stages', 'conversations'],
  'runtime.create': ['runtimes'],
  'runtime.update': ['runtimes'],
  'runtime.remove': ['runtimes', 'agents'],
  'runtime.probe': ['runtimes'],
  'runtime.probed': ['runtimes'],
  'project.create': ['projects'],
  'project.update': ['projects'],
  'project.remove': ['projects', 'tasks', 'conversations'],
  'task.create': [
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'task_comments',
    'tasks',
    'threads',
    'review_reports',
  ],
  'task.move': [
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'threads',
    'review_reports',
    'runs',
    'cards',
    'task_comments',
  ],
  'task.complete': [
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'threads',
    'review_reports',
    'task_comments',
    'runs',
    'cards',
  ],
  'task.stop': ['tasks', 'runs'],
  'task.remove': ['tasks', 'runs', 'threads', 'cards', 'projects'],
  'task.comment': [
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'threads',
    'review_reports',
    'runs',
    'cards',
    'task_comments',
  ],
  'task.rerun': [
    'tasks',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'threads',
    'review_reports',
    'runs',
    'task_comments',
  ],
  'card.answer': ['runs', 'cards'],
  'card.resolve': ['cards'],
  // 并发窗口按智能体（`maxConcurrent`）算，领取必须装 agents
  'run.claim': ['runs', 'runtimes', 'agents', 'threads'],
  'run.heartbeat': ['runs'],
  'run.receipt': [
    'runs',
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'conversations',
    'cards',
    'rule_sets',
    'threads',
    'review_reports',
    'task_comments',
  ],
  'run.frames': ['runs'],
  'run.host_settled': ['runs', 'conversations', 'cards'],
  'run.cancel': ['runs'],
  'clock.tick': [
    'runs',
    'rule_sets',
    'rule_fires',
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'threads',
    'review_reports',
    'task_comments',
    'cards',
  ],
  'chat.create': ['agents', 'projects'],
  'chat.send': ['conversations', 'messages', 'runs', 'agents', 'runtimes', 'projects'],
  'chat.remove': ['conversations', 'messages'],
  'chat.cancel': ['conversations', 'runs'],
  'chat.archive': ['conversations'],
  'app.event': [
    'rule_sets',
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'threads',
    'review_reports',
    'runs',
    'cards',
    'task_comments',
  ],
  'event.received': [
    'rule_sets',
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'threads',
    'review_reports',
    'runs',
    'cards',
    'task_comments',
  ],
  'rule.replay': [
    'rule_sets',
    'rule_fires',
    'events',
    'event_skips',
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'threads',
    'review_reports',
    'runs',
    'cards',
    'task_comments',
  ],
  'rules.replace': ['rule_sets', 'workflows', 'workflow_stages', 'projects'],
  'rule.trigger': [
    'rule_sets',
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'task_comments',
  ],
  'plugins.replace': ['plugin_settings'],
  'plugin.set': ['plugin_settings'],
  'thread.note': ['threads'],
  'thread.close': ['threads'],
  'thread.bind': ['threads'],
  'thread.remove': ['threads', 'tasks', 'runs'],
  'review.export': ['tasks', 'projects', 'review_reports'],
  'card.delivered': ['cards'],
  'card.delivery_failed': ['cards'],
}

const byType = new Map(samples.map((input) => [input.type, input]))

describe('kernel/view-spec', () => {
  it('覆盖 39 条命令 + 10 条宿主内部输入，并返回各自的投影切片', () => {
    expect(COMMAND_NAMES.length).toBe(39)
    expect(HOST_INPUT_NAMES.length).toBe(10)
    expect(commandSamples.length).toBe(COMMAND_NAMES.length)
    expect(hostSamples.length).toBe(HOST_INPUT_NAMES.length)
    expect(new Set(samples.map((input) => input.type)).size).toBe(
      COMMAND_NAMES.length + HOST_INPUT_NAMES.length,
    )

    for (const type of [...COMMAND_NAMES, ...HOST_INPUT_NAMES]) {
      const input = byType.get(type)
      expect(input, type).toBeDefined()
      expect(viewSpec(input as Input), type).toEqual(expected[type])
    }
  })

  it('不整库装载：每条输入的切片都小于投影全集', () => {
    for (const input of samples) {
      expect(viewSpec(input).length, input.type).toBeLessThan(PROJECTION_TABLES.length)
    }
  })

  it('切片只含投影表白名单内的表且不重复', () => {
    const allowed = new Set<string>(PROJECTION_TABLES)
    for (const input of samples) {
      const spec = viewSpec(input)
      expect(new Set(spec).size, input.type).toBe(spec.length)
      for (const table of spec) expect(allowed.has(table), `${input.type} → ${table}`).toBe(true)
    }
  })

  it('实体表（ENTITY_TABLES）是投影全集的子集', () => {
    const projection = new Set<string>(PROJECTION_TABLES)
    for (const table of ENTITY_TABLES) expect(projection.has(table), table).toBe(true)
  })

  it('删除命令要装载 runs（run.removed 事实替代 SQL 级联，D13）', () => {
    expect(viewSpec(byType.get('task.move') as Input)).toContain('tasks')
    expect(viewSpec(byType.get('task.complete') as Input)).toContain('tasks')
    expect(viewSpec(byType.get('task.remove') as Input)).toEqual([
      'tasks',
      'runs',
      'threads',
      'cards',
      'projects',
    ])
    expect(viewSpec(byType.get('workflow.remove') as Input)).toContain('runs')
  })

  it('运行/对话输入只声明自己需要的切片（领取要运行时配置、回执要阶段流转）', () => {
    expect(viewSpec(byType.get('run.claim') as Input)).toContain('runtimes')
    expect(viewSpec(byType.get('run.receipt') as Input)).toContain('workflow_stages')
    expect(viewSpec(byType.get('chat.send') as Input)).toContain('conversations')
    expect(viewSpec(byType.get('clock.tick') as Input)).toContain('runs')
    expect(viewSpec(byType.get('clock.tick') as Input)).toContain('rule_sets')
  })

  it('M11 项目顶层化：聊天要装 projects（工作目录），删项目要装 conversations（归默认目录）', () => {
    expect(viewSpec(byType.get('chat.create') as Input)).toEqual(['agents', 'projects'])
    expect(viewSpec(byType.get('chat.send') as Input)).toContain('projects')
    expect(viewSpec(byType.get('project.remove') as Input)).toEqual([
      'projects',
      'tasks',
      'conversations',
    ])
  })
})
