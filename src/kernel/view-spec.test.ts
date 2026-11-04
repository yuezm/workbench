import { describe, expect, it } from 'vitest'
import { COMMAND_NAMES, type Command } from '../protocol/commands'
import type { AgentInput, RuntimeInput, TaskInput, WorkflowInput } from '../protocol/entities'
import { ENTITY_TABLES } from '../protocol/entities'
import type { ProjectionTable } from './types'
import { viewSpec } from './view-spec'

const workflowInput: WorkflowInput = {
  name: '研发',
  stages: [
    { name: '待办', entryMode: 'none' },
    { name: '实现', entryMode: 'agent', agentId: 'ag-1' },
  ],
}

const agentInput: AgentInput = { name: '实现者', runtimeId: 'rt-1' }

const runtimeInput: RuntimeInput = { name: '本机 dsh' }

const taskInput: TaskInput = { title: '任务', workflowId: 'wf-1' }

const samples: Command[] = [
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
  { commandId: 'c14', type: 'task.remove', id: 't-1' },
]

const expected: Record<Command['type'], ProjectionTable[]> = {
  'workflow.create': ['agents'],
  'workflow.update': ['workflows', 'workflow_stages', 'agents', 'tasks'],
  'workflow.remove': ['workflows', 'workflow_stages', 'tasks'],
  'agent.create': ['runtimes'],
  'agent.update': ['agents', 'runtimes'],
  'agent.remove': ['agents', 'workflow_stages'],
  'runtime.create': ['runtimes'],
  'runtime.update': ['runtimes'],
  'runtime.remove': ['runtimes', 'agents'],
  'runtime.probed': ['runtimes'],
  'task.create': ['workflows', 'workflow_stages'],
  'task.move': ['tasks', 'workflows', 'workflow_stages'],
  'task.complete': ['tasks', 'workflows', 'workflow_stages'],
  'task.remove': ['tasks'],
}

const byType = new Map(samples.map((command) => [command.type, command]))

describe('kernel/view-spec', () => {
  it('覆盖全部 14 条 M1 命令，并返回各自的投影切片', () => {
    expect(COMMAND_NAMES.length).toBe(14)
    expect(samples.length).toBe(COMMAND_NAMES.length)

    for (const name of COMMAND_NAMES) {
      const command = byType.get(name)
      expect(command, name).toBeDefined()
      expect(viewSpec(command as Command), name).toEqual(expected[name])
    }
  })

  it('不整库装载：每条命令的切片都小于五张表', () => {
    for (const command of samples) {
      expect(viewSpec(command).length, command.type).toBeLessThan(ENTITY_TABLES.length)
    }
  })

  it('切片只含投影表白名单内的表且不重复', () => {
    const allowed = new Set<string>(ENTITY_TABLES)
    for (const command of samples) {
      const spec = viewSpec(command)
      expect(new Set(spec).size, command.type).toBe(spec.length)
      for (const table of spec) expect(allowed.has(table), `${command.type} → ${table}`).toBe(true)
    }
  })

  it('任务拖拽/完成要判断「执行中」，必须装载 tasks（宿主同时装 activeTaskIds）', () => {
    expect(viewSpec(byType.get('task.move') as Command)).toContain('tasks')
    expect(viewSpec(byType.get('task.complete') as Command)).toContain('tasks')
    expect(viewSpec(byType.get('task.remove') as Command)).toEqual(['tasks'])
  })
})
