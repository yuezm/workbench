import { describe, expect, it } from 'vitest'
import type { Command } from '../../src/protocol/commands'
import type {
  AgentInput,
  RuntimeInput,
  RuntimeProbe,
  TaskInput,
  WorkflowInput,
} from '../../src/protocol/entities'
import { validateCommand, type ValidateResult } from '../../src/protocol/validate'

const workflowInput: WorkflowInput = {
  name: '流程',
  description: '',
  stages: [
    { name: '待办', entryMode: 'none' },
    { name: '实现', entryMode: 'agent', agentId: 'ag1', onCompleteIndex: 0, onRejectIndex: null },
  ],
}

const agentInput: AgentInput = {
  name: '实现者',
  description: '',
  runtimeId: 'rt1',
  systemPrompt: '',
}

const runtimeInput: RuntimeInput = {
  name: '本机 dsh',
  protocolFamily: 'dsh',
  command: 'dsh',
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 2,
  enabled: true,
}

const taskInput: TaskInput = {
  title: '写计划',
  description: '',
  workflowId: 'wf1',
  stageId: 'st1',
}

const runtimeProbe: RuntimeProbe = {
  state: 'ready',
  path: '/usr/local/bin/dsh',
  cliVersion: '1.3.0',
  protocolVersion: 2,
  pluginVersion: null,
  error: null,
  output: 'ok',
  elapsedMs: 42,
  checkedAt: '2026-01-01T00:00:00.000Z',
}

const validCommands: Command[] = [
  { commandId: 'c01', type: 'workflow.create', input: workflowInput },
  { commandId: 'c02', type: 'workflow.update', id: 'wf1', input: workflowInput },
  { commandId: 'c03', type: 'workflow.remove', id: 'wf1' },
  { commandId: 'c04', type: 'agent.create', input: agentInput },
  { commandId: 'c05', type: 'agent.update', id: 'ag1', patch: { name: '新名字' } },
  { commandId: 'c06', type: 'agent.remove', id: 'ag1' },
  { commandId: 'c07', type: 'runtime.create', input: runtimeInput },
  { commandId: 'c08', type: 'runtime.update', id: 'rt1', patch: { maxConcurrent: 8 } },
  { commandId: 'c09', type: 'runtime.remove', id: 'rt1' },
  { commandId: 'c10', type: 'runtime.probed', id: 'rt1', probe: runtimeProbe },
  { commandId: 'c11', type: 'task.create', input: taskInput },
  { commandId: 'c12', type: 'task.move', id: 't1', stageId: 'st1' },
  { commandId: 'c13', type: 'task.complete', id: 't1' },
  { commandId: 'c14', type: 'task.remove', id: 't1' },
]

/** 只取失败文案；先用断言固定 `ok=false`，避免分支未覆盖。 */
const rejectedMessage = (input: unknown): string => {
  const result = validateCommand(input)
  expect(result.ok).toBe(false)
  return (result as Extract<ValidateResult, { ok: false }>).message
}

const cmd = (type: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  commandId: 'cmd-1',
  type,
  ...fields,
})

const longText = (n: number): string => 'x'.repeat(n)

describe('protocol/validate', () => {
  it('合法命令全部通过，并原样返回（不裁剪、不补默认值）', () => {
    for (const command of validCommands) {
      expect(validateCommand(command)).toEqual({ ok: true, command })
    }
  })

  it('只含必填字段的命令也通过（可选字段缺省）', () => {
    const minimalRuntime: Command = {
      commandId: 'c20',
      type: 'runtime.create',
      input: { name: '本机' },
    }
    const minimalTask: Command = {
      commandId: 'c21',
      type: 'task.create',
      input: { title: '任务', workflowId: 'wf1' },
    }
    const minimalAgentPatch: Command = {
      commandId: 'c22',
      type: 'agent.update',
      id: 'ag1',
      patch: { description: '只改描述' },
    }
    const minimalRuntimePatch: Command = {
      commandId: 'c23',
      type: 'runtime.update',
      id: 'rt1',
      patch: { enabled: false },
    }

    for (const command of [minimalRuntime, minimalTask, minimalAgentPatch, minimalRuntimePatch]) {
      expect(validateCommand(command)).toEqual({ ok: true, command })
    }
  })

  it('拒绝非对象与未知命令名', () => {
    expect(rejectedMessage(null)).toBe('命令必须是对象')
    expect(rejectedMessage(42)).toBe('命令必须是对象')
    expect(rejectedMessage('task.remove')).toBe('命令必须是对象')
    expect(rejectedMessage([])).toBe('命令必须是对象')
    expect(rejectedMessage({})).toBe('未知命令: undefined')
    expect(rejectedMessage({ type: 42 })).toBe('未知命令: 42')
    expect(rejectedMessage({ type: 'nope.create' })).toBe('未知命令: nope.create')
  })

  it('校验 commandId：必填、非空、类型与长度上限', () => {
    expect(rejectedMessage({ type: 'task.remove' })).toBe('commandId必填')
    expect(rejectedMessage({ type: 'task.remove', commandId: null })).toBe('commandId必填')
    expect(rejectedMessage({ type: 'task.remove', commandId: 7 })).toBe('commandId必须是字符串')
    expect(rejectedMessage({ type: 'task.remove', commandId: '  ' })).toBe('commandId必填')
    expect(rejectedMessage(cmd('task.remove', { commandId: longText(201) }))).toBe(
      'commandId最长 200 个字符',
    )
  })

  it('workflow.create：name / description / stages 形状', () => {
    expect(rejectedMessage(cmd('workflow.create'))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('workflow.create', { input: 'x' }))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('workflow.create', { input: {} }))).toBe('input.name必填')
    expect(rejectedMessage(cmd('workflow.create', { input: { name: 1 } }))).toBe(
      'input.name必须是字符串',
    )
    expect(rejectedMessage(cmd('workflow.create', { input: { name: longText(101) } }))).toBe(
      'input.name最长 100 个字符',
    )
    expect(rejectedMessage(cmd('workflow.create', { input: { name: 'p', description: 1 } }))).toBe(
      'input.description必须是字符串',
    )
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: { name: 'p', description: longText(2001) },
        }),
      ),
    ).toBe('input.description最长 2000 个字符')
    expect(rejectedMessage(cmd('workflow.create', { input: { name: 'p' } }))).toBe(
      'input.stages 必须是数组',
    )
    expect(rejectedMessage(cmd('workflow.create', { input: { name: 'p', stages: [] } }))).toBe(
      'input.stages 至少一个阶段',
    )
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: Array.from({ length: 51 }, (_, i) => ({ name: `s${i}`, entryMode: 'none' })),
          },
        }),
      ),
    ).toBe('input.stages 最多 50 个阶段')
    expect(rejectedMessage(cmd('workflow.create', { input: { name: 'p', stages: ['x'] } }))).toBe(
      'input.stages[0] 必须是对象',
    )
    expect(rejectedMessage(cmd('workflow.create', { input: { name: 'p', stages: [{}] } }))).toBe(
      'input.stages[0].name必填',
    )
    expect(
      rejectedMessage(cmd('workflow.create', { input: { name: 'p', stages: [{ name: 's' }] } })),
    ).toBe('input.stages[0].entryMode必填')
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: { name: 'p', stages: [{ name: 's', entryMode: 'kind' }] },
        }),
      ),
    ).toBe('input.stages[0].entryMode取值必须是 none / agent / user')
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: [{ name: 's', entryMode: 'agent', agentId: 7 }],
          },
        }),
      ),
    ).toBe('input.stages[0].agentId必须是字符串')
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: [{ name: 's', entryMode: 'agent', agentId: '' }],
          },
        }),
      ),
    ).toBe('input.stages[0].agentId必填')
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: [{ name: 's', entryMode: 'none', onCompleteIndex: '0' }],
          },
        }),
      ),
    ).toBe('input.stages[0].onCompleteIndex必须是整数')
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: [{ name: 's', entryMode: 'none', onCompleteIndex: 50 }],
          },
        }),
      ),
    ).toBe('input.stages[0].onCompleteIndex必须在 0 到 49 之间')
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: [{ name: 's', entryMode: 'none', onRejectIndex: -1 }],
          },
        }),
      ),
    ).toBe('input.stages[0].onRejectIndex必须在 0 到 49 之间')
  })

  it('workflow.update / remove：id 必填', () => {
    expect(rejectedMessage(cmd('workflow.update', { input: workflowInput }))).toBe('id必填')
    expect(
      rejectedMessage(cmd('workflow.update', { id: 'wf1', input: { name: 'p', stages: [] } })),
    ).toBe('input.stages 至少一个阶段')
    expect(rejectedMessage(cmd('workflow.remove'))).toBe('id必填')
  })

  it('agent.create：runtimeId 必填且必须属于本机运行时', () => {
    expect(rejectedMessage(cmd('agent.create'))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('agent.create', { input: {} }))).toBe('input.name必填')
    expect(rejectedMessage(cmd('agent.create', { input: { name: 'a' } }))).toBe(
      'input.runtimeId必填',
    )
    expect(rejectedMessage(cmd('agent.create', { input: { name: 'a', runtimeId: 7 } }))).toBe(
      'input.runtimeId必须是字符串',
    )
    expect(
      rejectedMessage(
        cmd('agent.create', { input: { name: 'a', runtimeId: 'rt1', description: 7 } }),
      ),
    ).toBe('input.description必须是字符串')
    expect(
      rejectedMessage(
        cmd('agent.create', {
          input: { name: 'a', runtimeId: 'rt1', systemPrompt: 7 },
        }),
      ),
    ).toBe('input.systemPrompt必须是字符串')
  })

  it('agent.update / remove：id 与 patch 形状', () => {
    expect(rejectedMessage(cmd('agent.update', { patch: {} }))).toBe('id必填')
    expect(rejectedMessage(cmd('agent.update', { id: 'ag1' }))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('agent.update', { id: 'ag1', patch: { name: '' } }))).toBe(
      'input.name必填',
    )
    expect(rejectedMessage(cmd('agent.update', { id: 'ag1', patch: { name: 7 } }))).toBe(
      'input.name必须是字符串',
    )
    expect(rejectedMessage(cmd('agent.update', { id: 'ag1', patch: { runtimeId: '' } }))).toBe(
      'input.runtimeId必填',
    )
    expect(rejectedMessage(cmd('agent.update', { id: 'ag1', patch: { systemPrompt: 7 } }))).toBe(
      'input.systemPrompt必须是字符串',
    )
    expect(rejectedMessage(cmd('agent.remove'))).toBe('id必填')
  })

  it('runtime.create：枚举、长度上限与数值范围', () => {
    expect(rejectedMessage(cmd('runtime.create'))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('runtime.create', { input: {} }))).toBe('input.name必填')
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', protocolFamily: 'claude' } })),
    ).toBe('input.protocolFamily取值必须是 dsh')
    expect(rejectedMessage(cmd('runtime.create', { input: { name: 'r', command: 7 } }))).toBe(
      'input.command必须是字符串',
    )
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', command: longText(501) } })),
    ).toBe('input.command最长 500 个字符')
    expect(rejectedMessage(cmd('runtime.create', { input: { name: 'r', profile: 7 } }))).toBe(
      'input.profile必须是字符串',
    )
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', profile: longText(101) } })),
    ).toBe('input.profile最长 100 个字符')
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', permissionMode: 'root' } })),
    ).toBe('input.permissionMode取值必须是 read-only / workspace-write / danger-full-access')
    expect(rejectedMessage(cmd('runtime.create', { input: { name: 'r', model: 7 } }))).toBe(
      'input.model必须是字符串',
    )
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', model: longText(201) } })),
    ).toBe('input.model最长 200 个字符')
    expect(
      rejectedMessage(
        cmd('runtime.create', { input: { name: 'r', reasoningEffort: longText(201) } }),
      ),
    ).toBe('input.reasoningEffort最长 200 个字符')
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', workdir: longText(1001) } })),
    ).toBe('input.workdir最长 1000 个字符')
    expect(rejectedMessage(cmd('runtime.create', { input: { name: 'r', maxConcurrent: 0 } }))).toBe(
      'input.maxConcurrent必须在 1 到 8 之间',
    )
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', maxConcurrent: 1.5 } })),
    ).toBe('input.maxConcurrent必须是整数')
    expect(rejectedMessage(cmd('runtime.create', { input: { name: 'r', enabled: 'yes' } }))).toBe(
      'input.enabled必须是布尔值',
    )
  })

  it('runtime.update / remove：id 与 patch 形状', () => {
    expect(rejectedMessage(cmd('runtime.update', { patch: {} }))).toBe('id必填')
    expect(rejectedMessage(cmd('runtime.update', { id: 'rt1' }))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('runtime.update', { id: 'rt1', patch: { name: '' } }))).toBe(
      'input.name必填',
    )
    expect(
      rejectedMessage(cmd('runtime.update', { id: 'rt1', patch: { permissionMode: 'root' } })),
    ).toBe('input.permissionMode取值必须是 read-only / workspace-write / danger-full-access')
    expect(rejectedMessage(cmd('runtime.remove'))).toBe('id必填')
  })

  it('runtime.probed：probe 字段逐项校验', () => {
    expect(rejectedMessage(cmd('runtime.probed', { probe: runtimeProbe }))).toBe('id必填')
    expect(rejectedMessage(cmd('runtime.probed', { id: 'rt1' }))).toBe('probe 必须是对象')
    expect(rejectedMessage(cmd('runtime.probed', { id: 'rt1', probe: {} }))).toBe('probe.state必填')
    expect(rejectedMessage(cmd('runtime.probed', { id: 'rt1', probe: { state: 'ok' } }))).toBe(
      'probe.state取值必须是 ready / unavailable',
    )
    expect(
      rejectedMessage(cmd('runtime.probed', { id: 'rt1', probe: { state: 'ready', path: 7 } })),
    ).toBe('probe.path必须是字符串')
    expect(
      rejectedMessage(
        cmd('runtime.probed', {
          id: 'rt1',
          probe: { state: 'ready', cliVersion: longText(201) },
        }),
      ),
    ).toBe('probe.cliVersion最长 200 个字符')
    expect(
      rejectedMessage(
        cmd('runtime.probed', { id: 'rt1', probe: { state: 'ready', protocolVersion: '2' } }),
      ),
    ).toBe('probe.protocolVersion必须是整数')
    expect(
      rejectedMessage(
        cmd('runtime.probed', { id: 'rt1', probe: { state: 'ready', protocolVersion: -1 } }),
      ),
    ).toBe('probe.protocolVersion必须在 0 到 1000000 之间')
    expect(
      rejectedMessage(
        cmd('runtime.probed', {
          id: 'rt1',
          probe: { state: 'ready', pluginVersion: longText(201) },
        }),
      ),
    ).toBe('probe.pluginVersion最长 200 个字符')
    expect(
      rejectedMessage(
        cmd('runtime.probed', { id: 'rt1', probe: { state: 'ready', error: longText(2001) } }),
      ),
    ).toBe('probe.error最长 2000 个字符')
    expect(
      rejectedMessage(
        cmd('runtime.probed', {
          id: 'rt1',
          probe: { state: 'ready', output: longText(40_001) },
        }),
      ),
    ).toBe('probe.output最长 40000 个字符')
    expect(
      rejectedMessage(
        cmd('runtime.probed', { id: 'rt1', probe: { state: 'ready', elapsedMs: 1.5 } }),
      ),
    ).toBe('probe.elapsedMs必须是整数')
    expect(
      rejectedMessage(
        cmd('runtime.probed', { id: 'rt1', probe: { state: 'ready', elapsedMs: -1 } }),
      ),
    ).toBe('probe.elapsedMs必须在 0 到 86400000 之间')
    expect(
      rejectedMessage(
        cmd('runtime.probed', {
          id: 'rt1',
          probe: { state: 'ready', elapsedMs: 1 },
        }),
      ),
    ).toBe('probe.checkedAt必填')
  })

  it('task.create：title / workflowId / stageId 形状', () => {
    expect(rejectedMessage(cmd('task.create'))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('task.create', { input: {} }))).toBe('input.title必填')
    expect(rejectedMessage(cmd('task.create', { input: { title: longText(201) } }))).toBe(
      'input.title最长 200 个字符',
    )
    expect(
      rejectedMessage(cmd('task.create', { input: { title: 't', description: longText(2001) } })),
    ).toBe('input.description最长 2000 个字符')
    expect(rejectedMessage(cmd('task.create', { input: { title: 't' } }))).toBe(
      'input.workflowId必填',
    )
    expect(
      rejectedMessage(cmd('task.create', { input: { title: 't', workflowId: 'wf1', stageId: 7 } })),
    ).toBe('input.stageId必须是字符串')
  })

  it('task.move / complete / remove：id 与目标阶段', () => {
    expect(rejectedMessage(cmd('task.move', { stageId: 'st1' }))).toBe('id必填')
    expect(rejectedMessage(cmd('task.move', { id: 't1' }))).toBe('stageId必填')
    expect(rejectedMessage(cmd('task.move', { id: 't1', stageId: '  ' }))).toBe('stageId必填')
    expect(rejectedMessage(cmd('task.complete'))).toBe('id必填')
    expect(rejectedMessage(cmd('task.remove'))).toBe('id必填')
  })
})
