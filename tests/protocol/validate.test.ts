import { describe, expect, it } from 'vitest'
import type { Command } from '../../src/protocol/commands'
import type {
  AgentInput,
  RuntimeInput,
  RuntimeProbe,
  TaskInput,
  WorkflowInput,
} from '../../src/protocol/entities'
import {
  ACCEPTANCE_LIMITS,
  AGENT_ENV_LIMITS,
  DELIVERABLE_LIMITS,
  STAGE_ROUND_LIMITS,
  STAGE_TIMEOUT_LIMITS,
} from '../../src/protocol/entities'
import {
  COMMAND_LIMITS,
  validateCommand,
  validateInput,
  validateQuery,
  type ValidateResult,
} from '../../src/protocol/validate'
import { REVIEW_LIMITS } from '../../src/protocol/review'

const workflowInput: WorkflowInput = {
  name: '流程',
  description: '',
  stages: [
    { name: '待办', entryMode: 'none' },
    {
      name: '实现',
      entryMode: 'agent',
      agentId: 'ag1',
      exits: [{ on: 'done', do: 'goto', stageIndex: 0 }],
    },
  ],
}

const agentInput: AgentInput = {
  name: '实现者',
  description: '',
  runtimeId: 'rt1',
  systemPrompt: '',
  // 执行配置是智能体的：模型 / 思考强度 / 并发 / 访问权限 / 工作目录 / 环境变量
  model: 'deepseek/deepseek-v4',
  reasoningEffort: 'high',
  maxConcurrent: 2,
  permissionMode: 'workspace-write',
  workdir: 'D:/repo',
  env: { HTTP_PROXY: 'http://127.0.0.1:7890' },
}

const runtimeInput: RuntimeInput = {
  name: '本机 dsh',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  enabled: true,
}

const taskInput: TaskInput = {
  title: '写计划',
  description: '',
  workflowId: 'wf1',
  projectId: 'pj1',
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
  { commandId: 'c08', type: 'runtime.update', id: 'rt1', patch: { profile: 'dev' } },
  { commandId: 'c09', type: 'runtime.remove', id: 'rt1' },
  { commandId: 'c10', type: 'runtime.probed', id: 'rt1', probe: runtimeProbe },
  { commandId: 'c11', type: 'task.create', input: taskInput },
  { commandId: 'c12', type: 'task.move', id: 't1', stageId: 'st1' },
  { commandId: 'c13', type: 'task.complete', id: 't1' },
  { commandId: 'c13b', type: 'task.stop', id: 't1' },
  { commandId: 'c14', type: 'task.remove', id: 't1' },
  { commandId: 'c14b', type: 'task.rerun', id: 't1' },
  { commandId: 'c15', type: 'card.answer', cardId: 'card-1', optionIndex: 0 },
  { commandId: 'c16', type: 'card.answer', cardId: 'card-1', optionIndex: 2, via: 'channel' },
  { commandId: 'c17', type: 'card.resolve', cardId: 'card-1' },
  {
    commandId: 'c18',
    type: 'rules.replace',
    rules: [
      {
        id: 'rule-1',
        name: '每日早报',
        when: { cron: '0 9 * * *' },
        to: {
          workflowId: 'wf1',
          task: { titleFrom: 'subject', labels: ['日报'] },
          thread: { keyFrom: 'subject', onExisting: 'reuse-task' },
        },
        prompt: '汇总昨日进展',
        parallel: 2,
        merge: 'subject',
        enabled: true,
      },
    ],
  },
  { commandId: 'c19', type: 'rule.trigger', ruleId: 'rule-1' },
  { commandId: 'c20', type: 'thread.note', threadId: 'th-1', text: '备注' },
  { commandId: 'c21', type: 'thread.close', threadId: 'th-1' },
  {
    commandId: 'c22',
    type: 'thread.bind',
    threadId: 'th-1',
    source: 'github',
    externalRef: 'issue-1',
  },
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
      input: { title: '任务', workflowId: 'wf1', projectId: 'pj1' },
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
    // M9：阶段要干什么只收字符串，超长整条拒收（不截断）
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: [{ name: 's', entryMode: 'none', instructions: 7 }],
          },
        }),
      ),
    ).toBe('input.stages[0].instructions必须是字符串')
    expect(
      rejectedMessage(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: [{ name: 's', entryMode: 'none', instructions: 'x'.repeat(20_001) }],
          },
        }),
      ),
    ).toBe('input.stages[0].instructions最长 20000 个字符')
    // 缺省 / null / 空串都合法（空串 = 清空）
    expect(
      validateCommand(
        cmd('workflow.create', {
          input: {
            name: 'p',
            stages: [
              { name: 's', entryMode: 'none', instructions: '' },
              { name: 't', entryMode: 'none', instructions: null },
              { name: 'u', entryMode: 'none' },
            ],
          },
        }),
      ).ok,
    ).toBe(true)
  })

  it('workflow.create：闸门形状（M11）', () => {
    const create = (gate: unknown): unknown =>
      cmd('workflow.create', {
        input: {
          name: 'p',
          stages: [{ name: 's', entryMode: 'agent', agentId: 'ag1', gate }],
        },
      })
    expect(validateCommand(create({ maxFails: 3, onPassIndex: 0, onFailIndex: 0 })).ok).toBe(true)
    expect(validateCommand(create({ maxFails: 3 })).ok).toBe(true)
    // 缺省 / null 都合法（不是闸门）
    expect(validateCommand(create(null)).ok).toBe(true)
    expect(validateCommand(create(undefined)).ok).toBe(true)
    // maxFails 必填且 1..100 的整数
    expect(validateCommand(create({})).ok).toBe(false)
    expect(validateCommand(create({ maxFails: 0 })).ok).toBe(false)
    expect(validateCommand(create({ maxFails: 1.5 })).ok).toBe(false)
    expect(validateCommand(create({ maxFails: COMMAND_LIMITS.gateMaxFails + 1 })).ok).toBe(false)
    // 不是对象 / 去向下标越界
    expect(validateCommand(create('gate')).ok).toBe(false)
    expect(validateCommand(create({ maxFails: 3, onPassIndex: 99 })).ok).toBe(false)
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

  it('agent.create / update：执行配置的取值、上限与模型 id 形态', () => {
    const withInput = (fields: Record<string, unknown>): Record<string, unknown> =>
      cmd('agent.create', { input: { name: 'a', runtimeId: 'rt1', ...fields } })

    // 访问权限白名单（越界即拒，不静默回落到可写）
    expect(rejectedMessage(withInput({ permissionMode: 'root' }))).toBe(
      'input.permissionMode取值必须是 read-only / workspace-write / danger-full-access',
    )
    // 模型：给了就必须是 provider/model（宿主据此拆成 Turn.model，写错不再静默回退）
    expect(rejectedMessage(withInput({ model: 7 }))).toBe('input.model必须是字符串')
    expect(rejectedMessage(withInput({ model: longText(201) }))).toBe('input.model最长 200 个字符')
    expect(rejectedMessage(withInput({ model: 'nomodel' }))).toBe(
      'input.model必须是 provider/model 形式',
    )
    expect(rejectedMessage(withInput({ model: '/model' }))).toBe(
      'input.model必须是 provider/model 形式',
    )
    expect(rejectedMessage(withInput({ model: 'provider/' }))).toBe(
      'input.model必须是 provider/model 形式',
    )
    // null / 空串都表示「用 CLI 默认模型」
    expect(validateCommand(withInput({ model: null }))).toMatchObject({ ok: true })
    expect(validateCommand(withInput({ model: '' }))).toMatchObject({ ok: true })

    expect(rejectedMessage(withInput({ reasoningEffort: longText(201) }))).toBe(
      'input.reasoningEffort最长 200 个字符',
    )
    expect(rejectedMessage(withInput({ workdir: longText(1001) }))).toBe(
      'input.workdir最长 1000 个字符',
    )
    // 并发上限：1..8 的整数
    expect(rejectedMessage(withInput({ maxConcurrent: 0 }))).toBe(
      'input.maxConcurrent必须在 1 到 8 之间',
    )
    expect(rejectedMessage(withInput({ maxConcurrent: 1.5 }))).toBe('input.maxConcurrent必须是整数')

    // patch 走同一套校验（修改执行配置的入口在 agent.update）
    expect(
      rejectedMessage(cmd('agent.update', { id: 'ag1', patch: { permissionMode: 'root' } })),
    ).toBe('input.permissionMode取值必须是 read-only / workspace-write / danger-full-access')
    expect(rejectedMessage(cmd('agent.update', { id: 'ag1', patch: { model: 'nomodel' } }))).toBe(
      'input.model必须是 provider/model 形式',
    )
  })

  it('agent.create / update：环境变量是合法键名的键值对象，条数与长度受上限约束', () => {
    const withEnv = (env: unknown): Record<string, unknown> =>
      cmd('agent.create', { input: { name: 'a', runtimeId: 'rt1', env } })
    const manyKeys = (n: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: n }, (_, index) => [`K${index}`, 'v']))

    // 形状：必须是对象（数组 / 字符串都不算键值对）
    expect(rejectedMessage(withEnv([]))).toBe('input.env 必须是键值对象')
    expect(rejectedMessage(withEnv('A=1'))).toBe('input.env 必须是键值对象')
    // 键名：POSIX 环境变量名，且不超过 64 字符
    expect(rejectedMessage(withEnv({ '1BAD': 'x' }))).toBe('input.env 的键非法: 1BAD')
    expect(rejectedMessage(withEnv({ 'A-B': 'x' }))).toBe('input.env 的键非法: A-B')
    expect(rejectedMessage(withEnv({ 'A B': 'x' }))).toBe('input.env 的键非法: A B')
    expect(rejectedMessage(withEnv({ ['K'.repeat(65)]: 'x' }))).toBe(
      `input.env 的键非法: ${'K'.repeat(65)}`,
    )
    // 值：字符串，且不超过 1000 字符
    expect(rejectedMessage(withEnv({ OK: 7 }))).toBe('input.env.OK 必须是字符串')
    expect(rejectedMessage(withEnv({ OK: longText(1001) }))).toBe('input.env.OK 最长 1000 个字符')
    // 条数：最多 32 项
    expect(validateCommand(withEnv(manyKeys(AGENT_ENV_LIMITS.maxVars)))).toMatchObject({ ok: true })
    expect(rejectedMessage(withEnv(manyKeys(AGENT_ENV_LIMITS.maxVars + 1)))).toBe(
      `input.env 最多 ${AGENT_ENV_LIMITS.maxVars} 项`,
    )
    // 空对象 / null / 缺省都合法（= 不追加环境变量）
    expect(validateCommand(withEnv({}))).toMatchObject({ ok: true })
    expect(validateCommand(withEnv(null))).toMatchObject({ ok: true })
    expect(
      validateCommand(cmd('agent.create', { input: { name: 'a', runtimeId: 'rt1' } })),
    ).toMatchObject({ ok: true })
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

  it('runtime.create：执行器键、参数模板、长度上限与数值范围', () => {
    expect(rejectedMessage(cmd('runtime.create'))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('runtime.create', { input: {} }))).toBe('input.name必填')
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', executorKey: 'Dsh' } })),
    ).toBe('input.executorKey 必须是小写 slug（字母开头，可含数字与连字符）')
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', argsTemplate: 'not-json' } })),
    ).toBe('input.argsTemplate 必须是 JSON 数组文本')
    expect(
      rejectedMessage(
        cmd('runtime.create', { input: { name: 'r', argsTemplate: '["--print","{nope}"]' } }),
      ),
    ).toBe('input.argsTemplate[1] 含未知占位符 {nope}')
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
    expect(rejectedMessage(cmd('runtime.create', { input: { name: 'r', enabled: 'yes' } }))).toBe(
      'input.enabled必须是布尔值',
    )
  })

  it('runtime.create / update：执行配置不再属于连接（校验不过问，字段原样透传）', () => {
    // 运行时只描述连接：模型 / 思考强度 / 并发 / 访问权限 / 工作目录写成什么样都不拦
    // —— 这几项的责任已经迁到 agent.create / agent.update（见上面的执行配置用例）
    const createWithExecutionConfig = cmd('runtime.create', {
      input: {
        name: 'r',
        model: 'nomodel',
        reasoningEffort: 7,
        maxConcurrent: 0,
        permissionMode: 'root',
        workdir: 7,
      },
    })
    expect(validateCommand(createWithExecutionConfig)).toEqual({
      ok: true,
      command: createWithExecutionConfig,
    })

    const updateWithExecutionConfig = cmd('runtime.update', {
      id: 'rt1',
      patch: { model: 'nomodel', maxConcurrent: 0, permissionMode: 'root', workdir: 7 },
    })
    expect(validateCommand(updateWithExecutionConfig)).toEqual({
      ok: true,
      command: updateWithExecutionConfig,
    })
  })

  it('runtime.create：argsTemplate 的结构、项数与单项长度上限', () => {
    expect(rejectedMessage(cmd('runtime.create', { input: { name: 'r', executorKey: 7 } }))).toBe(
      'input.executorKey必须是字符串',
    )
    expect(rejectedMessage(cmd('runtime.create', { input: { name: 'r', argsTemplate: 7 } }))).toBe(
      'input.argsTemplate必须是字符串',
    )
    // 是合法 JSON 但不是数组
    expect(
      rejectedMessage(cmd('runtime.create', { input: { name: 'r', argsTemplate: '{"args":[]}' } })),
    ).toBe('input.argsTemplate 必须是 JSON 数组文本')
    expect(
      rejectedMessage(
        cmd('runtime.create', { input: { name: 'r', argsTemplate: JSON.stringify(['a', 7]) } }),
      ),
    ).toBe('input.argsTemplate[1] 必须是字符串')
    expect(
      rejectedMessage(
        cmd('runtime.create', {
          input: { name: 'r', argsTemplate: JSON.stringify([longText(501)]) },
        }),
      ),
    ).toBe('input.argsTemplate[0] 最长 500 个字符')
    expect(
      rejectedMessage(
        cmd('runtime.create', {
          input: { name: 'r', argsTemplate: JSON.stringify(Array.from({ length: 21 }, () => '')) },
        }),
      ),
    ).toBe('input.argsTemplate 最多 20 项')
    // 占位符白名单（{model}/{effort}/{cwd}/{context}/{prompt}）内的模板通过
    expect(
      validateCommand(
        cmd('runtime.create', {
          input: { name: 'r', argsTemplate: '["--model","{model}","--prompt","{prompt}"]' },
        }),
      ),
    ).toMatchObject({ ok: true })
  })

  it('runtime.update / remove：id 与 patch 形状', () => {
    expect(rejectedMessage(cmd('runtime.update', { patch: {} }))).toBe('id必填')
    expect(rejectedMessage(cmd('runtime.update', { id: 'rt1' }))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('runtime.update', { id: 'rt1', patch: { name: '' } }))).toBe(
      'input.name必填',
    )
    expect(
      rejectedMessage(cmd('runtime.update', { id: 'rt1', patch: { executorKey: 'Dsh' } })),
    ).toBe('input.executorKey 必须是小写 slug（字母开头，可含数字与连字符）')
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

  it('task.create：title / workflowId / projectId / stageId 形状', () => {
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
    // M11：projectId 可选（省 = 默认目录），给了才校验形状
    expect(
      validateCommand(cmd('task.create', { input: { title: 't', workflowId: 'wf1' } })).ok,
    ).toBe(true)
    expect(
      validateCommand(
        cmd('task.create', { input: { title: 't', workflowId: 'wf1', projectId: null } }),
      ).ok,
    ).toBe(true)
    expect(
      rejectedMessage(
        cmd('task.create', { input: { title: 't', workflowId: 'wf1', projectId: 7 } }),
      ),
    ).toBe('input.projectId必须是字符串')
    expect(
      rejectedMessage(
        cmd('task.create', {
          input: { title: 't', workflowId: 'wf1', projectId: 'pj1', stageId: 7 },
        }),
      ),
    ).toBe('input.stageId必须是字符串')
  })

  it('task.move / complete / stop / remove / rerun：id 与目标阶段', () => {
    expect(rejectedMessage(cmd('task.move', { stageId: 'st1' }))).toBe('id必填')
    expect(rejectedMessage(cmd('task.move', { id: 't1' }))).toBe('stageId必填')
    expect(rejectedMessage(cmd('task.move', { id: 't1', stageId: '  ' }))).toBe('stageId必填')
    expect(rejectedMessage(cmd('task.complete'))).toBe('id必填')
    expect(rejectedMessage(cmd('task.stop'))).toBe('id必填')
    expect(rejectedMessage(cmd('task.remove'))).toBe('id必填')
    expect(rejectedMessage(cmd('task.rerun'))).toBe('id必填')
    expect(validateCommand(cmd('task.rerun', { id: 't1' }))).toEqual({
      ok: true,
      command: { commandId: 'cmd-1', type: 'task.rerun', id: 't1' },
    })
  })

  it('card.answer：cardId 必填、下标在范围内、via 只接受 ui / channel', () => {
    expect(rejectedMessage(cmd('card.answer', { optionIndex: 0 }))).toBe('cardId必填')
    expect(rejectedMessage(cmd('card.answer', { cardId: '  ', optionIndex: 0 }))).toBe('cardId必填')
    expect(rejectedMessage(cmd('card.answer', { cardId: 'card-1' }))).toBe('optionIndex必须是整数')
    expect(rejectedMessage(cmd('card.answer', { cardId: 'card-1', optionIndex: 1.5 }))).toBe(
      'optionIndex必须是整数',
    )
    expect(rejectedMessage(cmd('card.answer', { cardId: 'card-1', optionIndex: -1 }))).toBe(
      'optionIndex必须在 0 到 19 之间',
    )
    expect(rejectedMessage(cmd('card.answer', { cardId: 'card-1', optionIndex: 20 }))).toBe(
      'optionIndex必须在 0 到 19 之间',
    )
    expect(
      rejectedMessage(cmd('card.answer', { cardId: 'card-1', optionIndex: 0, via: 'sms' })),
    ).toBe('via取值必须是 ui / channel')
  })

  it('card.answer：note 可选、必须是字符串且不超过 2000 字（M13 补充说明）', () => {
    expect(rejectedMessage(cmd('card.answer', { cardId: 'card-1', optionIndex: 0, note: 5 }))).toBe(
      'note必须是字符串',
    )
    expect(
      rejectedMessage(
        cmd('card.answer', { cardId: 'card-1', optionIndex: 0, note: longText(2001) }),
      ),
    ).toBe('note最长 2000 个字符')
    expect(
      validateCommand(
        cmd('card.answer', { cardId: 'card-1', optionIndex: 1, note: '第 2 条我不同意' }),
      ),
    ).toEqual({
      ok: true,
      command: {
        commandId: 'cmd-1',
        type: 'card.answer',
        cardId: 'card-1',
        optionIndex: 1,
        note: '第 2 条我不同意',
      },
    })
  })

  it('card.resolve：cardId 必填', () => {
    expect(rejectedMessage(cmd('card.resolve'))).toBe('cardId必填')
    expect(rejectedMessage(cmd('card.resolve', { cardId: '  ' }))).toBe('cardId必填')
    expect(validateCommand({ commandId: 'x', type: 'card.resolve', cardId: 'card-1' })).toEqual({
      ok: true,
      command: { commandId: 'x', type: 'card.resolve', cardId: 'card-1' },
    })
  })
})

describe('validateQuery（M5：query 动词入口）', () => {
  it('无参数视图：undefined / null 放行，带任意参数拒绝', () => {
    expect(validateQuery('agents.all', undefined)).toEqual({
      ok: true,
      view: 'agents.all',
      params: undefined,
    })
    expect(validateQuery('agents.all', null)).toEqual({
      ok: true,
      view: 'agents.all',
      params: undefined,
    })
    expect(validateQuery('agents.all', {})).toEqual({
      ok: true,
      view: 'agents.all',
      params: undefined,
    })
    expect(validateQuery('agents.all', { workflowId: 'wf-1' })).toEqual({
      ok: false,
      message: '该视图不接受参数',
    })
    expect(validateQuery('agents.all', 42)).toEqual({ ok: false, message: '该视图不接受参数' })
  })

  it('带参数视图：缺参数 / 空串 / 非字符串 / 超长一律拒绝', () => {
    expect(validateQuery('tasks.byWorkflow', undefined)).toEqual({
      ok: false,
      message: '视图 tasks.byWorkflow 需要参数 workflowId',
    })
    expect(validateQuery('tasks.byWorkflow', { workflowId: '' })).toEqual({
      ok: false,
      message: 'workflowId必填',
    })
    expect(validateQuery('tasks.byWorkflow', { workflowId: 7 })).toEqual({
      ok: false,
      message: 'workflowId必须是字符串',
    })
    expect(validateQuery('tasks.byWorkflow', { workflowId: 'x'.repeat(201) })).toEqual({
      ok: false,
      message: 'workflowId最长 200 个字符',
    })
    expect(validateQuery('tasks.byWorkflow', { workflowId: 'wf-1' })).toEqual({
      ok: true,
      view: 'tasks.byWorkflow',
      params: { workflowId: 'wf-1' },
    })
    expect(validateQuery('runtimes.models', { runtimeId: 'rt-1' })).toEqual({
      ok: true,
      view: 'runtimes.models',
      params: { runtimeId: 'rt-1' },
    })
  })

  it('未知视图 / 非字符串视图 id 拒绝', () => {
    expect(validateQuery('unknown.view')).toEqual({ ok: false, message: '未知视图: unknown.view' })
    expect(validateQuery(undefined)).toEqual({ ok: false, message: '未知视图: undefined' })
  })

  it('app.event 的 eventType 上限 100 字符', () => {
    expect(
      rejectedMessage(
        cmd('app.event', {
          appId: 'pomodoro',
          eventType: 'pomodoro.' + 'a'.repeat(100),
          subject: 'x',
        }),
      ),
    ).toBe('eventType最长 100 个字符')
  })

  describe('M6 规则命令', () => {
    const rule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: 'rule-1',
      name: '每日早报',
      when: { cron: '0 9 * * *' },
      to: { workflowId: 'wf1' },
      enabled: true,
      ...over,
    })
    const replace = (rules: unknown): string => rejectedMessage(cmd('rules.replace', { rules }))

    it('空批次与合法批次通过', () => {
      expect(validateCommand(cmd('rules.replace', { rules: [] })).ok).toBe(true)
      expect(validateCommand(cmd('rules.replace', { rules: [rule()] })).ok).toBe(true)
    })

    it('rules 必须是数组、最多 100 条', () => {
      expect(replace(undefined)).toBe('rules 必须是数组')
      expect(replace(Array.from({ length: 101 }, () => rule()))).toBe('rules 最多 100 项')
    })

    it('单条规则形状：id / name / when / enabled', () => {
      expect(replace([rule({ id: '' })])).toBe('rules[0].id必填')
      expect(replace([rule({ name: '' })])).toBe('rules[0].name必填')
      expect(replace([rule({ enabled: 'yes' })])).toBe('rules[0].enabled 必须是布尔值')
      expect(replace(['nope'])).toBe('rules[0] 必须是对象')
      expect(replace([rule({ name: longText(81) })])).toBe('rules[0].name最长 80 个字符')
    })

    it('when 只能二选一：cron 或 source+types', () => {
      expect(replace([rule({ when: {} })])).toBe('rules[0].when 必须提供 cron 或 source+types')
      expect(replace([rule({ when: { cron: '0 9 * * *', source: 'github', types: ['*'] } })])).toBe(
        'rules[0].when 只能二选一：cron 或 source+types',
      )
      expect(replace([rule({ when: { cron: 9 } })])).toBe('rules[0].when.cron必须是字符串')
      expect(replace([rule({ when: { source: 'GitHub', types: ['*'] } })])).toBe(
        'rules[0].when.source 必须是小写标识或 *（如 github / app:pomodoro）',
      )
      expect(replace([rule({ when: { source: 'github', types: [] } })])).toBe(
        'rules[0].when.types 至少 1 项',
      )
      expect(replace([rule({ when: { source: 'github', types: ['issues/opened'] } })])).toBe(
        'rules[0].when.types[0] 必须是精确类型、* 或前缀 x.*',
      )
      expect(
        validateCommand(
          cmd('rules.replace', {
            rules: [rule({ when: { source: 'github', types: ['issues.*'] } })],
          }),
        ).ok,
      ).toBe(true)
    })

    it('to：workflowId 必填、stageId 与 task / thread 形状', () => {
      expect(replace([rule({ to: {} })])).toBe('rules[0].to.workflowId必填')
      expect(replace([rule({ to: { workflowId: 'wf1', task: { titleFrom: 'x' } } })])).toBe(
        'rules[0].to.task.titleFrom取值必须是 subject / summary',
      )
      expect(replace([rule({ to: { workflowId: 'wf1', task: { labels: [longText(33)] } } })])).toBe(
        'rules[0].to.task.labels[0]最长 32 个字符',
      )
      expect(replace([rule({ to: { workflowId: 'wf1', thread: {} } })])).toBe(
        'rules[0].to.thread.keyFrom必填',
      )
      expect(
        validateCommand(
          cmd('rules.replace', {
            rules: [rule({ to: { workflowId: 'wf1', thread: { keyFrom: 'subject' } } })],
          }),
        ).ok,
      ).toBe(true)
    })

    it('when / to 的其余形状分支逐项拒绝', () => {
      expect(replace([rule({ when: null })])).toBe('rules[0].when 必须是对象')
      expect(replace([rule({ when: { source: 42, types: ['*'] } })])).toBe(
        'rules[0].when.source 必须是字符串',
      )
      expect(replace([rule({ when: { source: longText(65), types: ['*'] } })])).toBe(
        'rules[0].when.source 最长 64 个字符',
      )
      expect(replace([rule({ when: { source: 'github', types: 'issues.opened' } })])).toBe(
        'rules[0].when.types 必须是数组',
      )
      expect(
        replace([
          rule({ when: { source: 'github', types: Array.from({ length: 21 }, () => 'issues.*') } }),
        ]),
      ).toBe('rules[0].when.types 最多 20 项')
      expect(replace([rule({ when: { source: 'github', types: [42] } })])).toBe(
        'rules[0].when.types[0] 必须是字符串',
      )
      expect(replace([rule({ when: { source: 'github', types: [longText(101)] } })])).toBe(
        'rules[0].when.types[0] 最长 100 个字符',
      )
      expect(replace([rule({ to: 'wf1' })])).toBe('rules[0].to 必须是对象')
      expect(replace([rule({ to: { workflowId: 'wf1', stageId: 42 } })])).toBe(
        'rules[0].to.stageId必须是字符串',
      )
      expect(replace([rule({ to: { workflowId: 'wf1', task: 'x' } })])).toBe(
        'rules[0].to.task 必须是对象',
      )
      expect(replace([rule({ to: { workflowId: 'wf1', thread: 'x' } })])).toBe(
        'rules[0].to.thread 必须是对象',
      )
      expect(
        replace([
          rule({ to: { workflowId: 'wf1', thread: { keyFrom: 'subject', onExisting: 'x' } } }),
        ]),
      ).toBe('rules[0].to.thread.onExisting取值必须是 reuse-task / new-task')
    })
  })

  it('rule.trigger：ruleId 必填', () => {
    expect(rejectedMessage(cmd('rule.trigger', {}))).toBe('ruleId必填')
    expect(validateCommand(cmd('rule.trigger', { ruleId: 'rule-1' })).ok).toBe(true)
  })

  it('thread.note / thread.close / thread.bind：字段必填与长度上限（M6.5）', () => {
    expect(rejectedMessage(cmd('thread.note', {}))).toBe('threadId必填')
    expect(rejectedMessage(cmd('thread.note', { threadId: 'th-1', text: '   ' }))).toBe('text必填')
    expect(rejectedMessage(cmd('thread.note', { threadId: 'th-1', text: longText(2001) }))).toBe(
      'text最长 2000 个字符',
    )
    expect(validateCommand(cmd('thread.note', { threadId: 'th-1', text: '备注' })).ok).toBe(true)

    expect(rejectedMessage(cmd('thread.close', {}))).toBe('threadId必填')

    expect(rejectedMessage(cmd('thread.bind', { threadId: 'th-1' }))).toBe('source必须是字符串')
    expect(
      rejectedMessage(
        cmd('thread.bind', { threadId: 'th-1', source: longText(65), externalRef: 'x' }),
      ),
    ).toBe('source最长 64 个字符')
    expect(
      rejectedMessage(cmd('thread.bind', { threadId: 'th-1', source: 'GitHub', externalRef: 'x' })),
    ).toBe('source 必须是小写标识（如 github / mail / app:pomodoro）')
    expect(rejectedMessage(cmd('thread.bind', { threadId: 'th-1', source: 'github' }))).toBe(
      'externalRef必填',
    )
    expect(
      rejectedMessage(
        cmd('thread.bind', { threadId: 'th-1', source: 'github', externalRef: longText(201) }),
      ),
    ).toBe('externalRef最长 200 个字符')
  })

  it('receipt.notes：逐条 ≤2000 字、≤100 条（M6.5）', () => {
    const receipt = (notes: unknown): unknown => ({
      type: 'run.receipt',
      runId: 'run-1',
      receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1, notes },
    })
    const valid = validateInput(receipt(['先跑测试']))
    expect(valid.ok).toBe(true)
    expect(validateInput(receipt([42])).ok).toBe(false)
    expect(validateInput(receipt([longText(2001)])).ok).toBe(false)
    expect(validateInput(receipt(Array.from({ length: 101 }, () => 'x'))).ok).toBe(false)
  })

  it('receipt.spawn：subject 必填、batch 1..999、≤32 条（M8）；越权字段被忽略', () => {
    const receipt = (spawn: unknown): unknown => ({
      type: 'run.receipt',
      runId: 'run-1',
      receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1, spawn },
    })
    expect(
      validateInput(
        receipt([
          {
            subject: '实现登录页',
            summary: '含表单与校验',
            stageId: 'st-1',
            batch: 1,
            key: 'login',
            parentTaskId: '伪造父任务',
            agentId: '伪造智能体',
          },
        ]),
      ).ok,
    ).toBe(true)
    expect(validateInput(receipt([{ subject: '   ' }])).ok).toBe(false)
    expect(validateInput(receipt([42])).ok).toBe(false)
    expect(validateInput(receipt([{ subject: 'x', batch: 0 }])).ok).toBe(false)
    expect(
      validateInput(receipt([{ subject: 'x', batch: COMMAND_LIMITS.spawnBatchMax + 1 }])).ok,
    ).toBe(false)
    expect(
      validateInput(
        receipt(
          Array.from({ length: COMMAND_LIMITS.spawnItems + 1 }, (_, i) => ({
            subject: `子任务${i}`,
          })),
        ),
      ).ok,
    ).toBe(false)
  })

  it('receipt.verdict / checks：判定枚举与证据形状（M11）', () => {
    const receipt = (extra: Record<string, unknown>): unknown => ({
      type: 'run.receipt',
      runId: 'run-1',
      receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1, ...extra },
    })
    expect(
      validateInput(receipt({ verdict: 'pass', checks: [{ cmd: 'pnpm check', exitCode: 0 }] })).ok,
    ).toBe(true)
    expect(validateInput(receipt({ verdict: 'fail' })).ok).toBe(true)
    expect(validateInput(receipt({ verdict: 'ok' })).ok).toBe(false)
    expect(validateInput(receipt({ checks: [{ cmd: 'x', exitCode: 0 }] })).ok).toBe(true)
    expect(validateInput(receipt({ checks: [42] })).ok).toBe(false)
    expect(validateInput(receipt({ checks: [{ cmd: '   ', exitCode: 0 }] })).ok).toBe(false)
    expect(validateInput(receipt({ checks: [{ cmd: 'x', exitCode: 1.5 }] })).ok).toBe(false)
    expect(
      validateInput(
        receipt({
          checks: Array.from({ length: COMMAND_LIMITS.gateChecks + 1 }, () => ({
            cmd: 'x',
            exitCode: 0,
          })),
        }),
      ).ok,
    ).toBe(false)
  })

  it('阶段 acceptance / maxRounds：条数、条长、轮次范围（M20/M21）', () => {
    const check = (stages: unknown): boolean =>
      validateCommand({
        commandId: 'c-acceptance',
        type: 'workflow.create',
        input: { name: '流程', stages },
      }).ok
    const stage = (extra: Record<string, unknown>): unknown => ({
      name: '实现',
      entryMode: 'agent',
      agentId: 'ag1',
      ...extra,
    })
    expect(check([stage({ acceptance: ['pnpm check 退出码 0'] })])).toBe(true)
    expect(check([stage({ acceptance: 'x' })])).toBe(false)
    expect(check([stage({ acceptance: [42] })])).toBe(false)
    expect(check([stage({ acceptance: ['x'.repeat(ACCEPTANCE_LIMITS.maxChars + 1)] })])).toBe(false)
    expect(
      check([
        stage({ acceptance: Array.from({ length: ACCEPTANCE_LIMITS.maxItems + 1 }, () => 'x') }),
      ]),
    ).toBe(false)

    expect(check([stage({ maxRounds: STAGE_ROUND_LIMITS.min })])).toBe(true)
    expect(check([stage({ maxRounds: STAGE_ROUND_LIMITS.max })])).toBe(true)
    expect(check([stage({ maxRounds: 0 })])).toBe(false)
    expect(check([stage({ maxRounds: STAGE_ROUND_LIMITS.max + 1 })])).toBe(false)
    expect(check([stage({ maxRounds: 2.5 })])).toBe(false)
  })

  it('阶段 runTimeoutMs：5 min–4 h 的毫秒区间，可空（M26）', () => {
    const check = (stages: unknown): boolean =>
      validateCommand({
        commandId: 'c-timeout',
        type: 'workflow.create',
        input: { name: '流程', stages },
      }).ok
    const stage = (extra: Record<string, unknown>): unknown => ({
      name: '澄清',
      entryMode: 'agent',
      agentId: 'ag1',
      ...extra,
    })

    expect(check([stage({ runTimeoutMs: null })])).toBe(true)
    expect(check([stage({})])).toBe(true)
    expect(check([stage({ runTimeoutMs: STAGE_TIMEOUT_LIMITS.minMs })])).toBe(true)
    expect(check([stage({ runTimeoutMs: STAGE_TIMEOUT_LIMITS.maxMs })])).toBe(true)
    expect(check([stage({ runTimeoutMs: STAGE_TIMEOUT_LIMITS.minMs - 1 })])).toBe(false)
    expect(check([stage({ runTimeoutMs: STAGE_TIMEOUT_LIMITS.maxMs + 1 })])).toBe(false)
    expect(check([stage({ runTimeoutMs: 60_000.5 })])).toBe(false)
  })

  it('receipt.acceptance：序号范围、met 布尔、evidence 长度、条数上限（M21）', () => {
    const receipt = (acceptance: unknown): unknown => ({
      type: 'run.receipt',
      runId: 'run-1',
      receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1, acceptance },
    })
    expect(validateInput(receipt([{ no: 1, met: true, evidence: 'pnpm check 退出码 0' }])).ok).toBe(
      true,
    )
    expect(validateInput(receipt([{ no: 1, met: false }])).ok).toBe(true)
    expect(validateInput(receipt([{ no: 0, met: true }])).ok).toBe(false)
    expect(validateInput(receipt([{ no: ACCEPTANCE_LIMITS.maxItems + 1, met: true }])).ok).toBe(
      false,
    )
    expect(validateInput(receipt([{ no: 1, met: 'yes' }])).ok).toBe(false)
    expect(validateInput(receipt([42])).ok).toBe(false)
    expect(
      validateInput(
        receipt([{ no: 1, met: true, evidence: longText(COMMAND_LIMITS.description + 1) }]),
      ).ok,
    ).toBe(false)
    expect(
      validateInput(
        receipt(
          Array.from({ length: ACCEPTANCE_LIMITS.maxItems + 1 }, (_, index) => ({
            no: 1,
            met: true,
            evidence: `第 ${index} 条`,
          })),
        ),
      ).ok,
    ).toBe(false)
  })

  it('receipt.findings / addresses：清单形状、小标不重复、处置必填项（M14）', () => {
    const receipt = (extra: Record<string, unknown>): unknown => ({
      type: 'run.receipt',
      runId: 'run-1',
      receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1, ...extra },
    })
    const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      key: 'R1',
      severity: 'high',
      location: 'src/a.ts:64',
      claim: 'BOM 文件被判非法 JSON',
      evidence: 'python verify.py',
      requiredAction: '改成 utf-8-sig 后复跑',
      ...over,
    })
    expect(validateInput(receipt({ findings: [item()] })).ok).toBe(true)
    expect(validateInput(receipt({ findings: [item({ evidence: undefined })] })).ok).toBe(true)
    expect(validateInput(receipt({ findings: [item({ severity: 'fatal' })] })).ok).toBe(false)
    expect(validateInput(receipt({ findings: [item({ key: '  ' })] })).ok).toBe(false)
    expect(validateInput(receipt({ findings: [item({ claim: 'x'.repeat(501) })] })).ok).toBe(false)
    expect(validateInput(receipt({ findings: [item({ requiredAction: undefined })] })).ok).toBe(
      false,
    )
    expect(validateInput(receipt({ findings: [42] })).ok).toBe(false)
    // 小标重复：finding id 会撞车，逐条闭环就失效
    expect(validateInput(receipt({ findings: [item(), item()] })).ok).toBe(false)
    expect(
      validateInput(
        receipt({ findings: Array.from({ length: REVIEW_LIMITS.maxFindings + 1 }, () => item()) }),
      ).ok,
    ).toBe(false)

    expect(
      validateInput(
        receipt({
          addresses: [{ findingId: 'r#R1', disposition: 'fixed', checkRef: 'pnpm check' }],
        }),
      ).ok,
    ).toBe(true)
    expect(
      validateInput(
        receipt({ addresses: [{ findingId: 'r#R1', disposition: 'rejected', note: '不改' }] }),
      ).ok,
    ).toBe(true)
    // fixed 必须给复核命令；rejected / deferred 必须写理由
    expect(
      validateInput(receipt({ addresses: [{ findingId: 'r#R1', disposition: 'fixed' }] })).ok,
    ).toBe(false)
    expect(
      validateInput(receipt({ addresses: [{ findingId: 'r#R1', disposition: 'rejected' }] })).ok,
    ).toBe(false)
    expect(
      validateInput(
        receipt({ addresses: [{ findingId: '  ', disposition: 'deferred', note: 'x' }] }),
      ).ok,
    ).toBe(false)
    expect(validateInput(receipt({ addresses: [{ disposition: 'fixed' }] })).ok).toBe(false)
    expect(validateInput(receipt({ addresses: [42] })).ok).toBe(false)
    // 处置动作不在枚举里：直接按处置字段的文案拒收（后面的必填项检查不再跑）
    const badDisposition = validateInput(
      receipt({ addresses: [{ findingId: 'r#R1', disposition: 'done' }] }),
    )
    expect(badDisposition.ok).toBe(false)
    expect((badDisposition as Extract<ValidateResult, { ok: false }>).message).toBe(
      'receipt.addresses[0].disposition取值必须是 fixed / rejected / deferred',
    )
    expect(
      validateInput(
        receipt({
          addresses: Array.from({ length: REVIEW_LIMITS.maxAddresses + 1 }, () => ({
            findingId: 'r#R1',
            disposition: 'deferred',
            note: 'x',
          })),
        }),
      ).ok,
    ).toBe(false)
  })

  it('task.create：parentTaskId 可选，只有形状校验（M8）', () => {
    expect(
      validateCommand({
        commandId: 'c-1',
        type: 'task.create',
        input: { title: '子任务', workflowId: 'wf-1', projectId: 'pj-1', parentTaskId: 'tk-1' },
      }).ok,
    ).toBe(true)
    expect(
      validateCommand({
        commandId: 'c-2',
        type: 'task.create',
        input: { title: '子任务', workflowId: 'wf-1', projectId: 'pj-1', parentTaskId: '   ' },
      }).ok,
    ).toBe(false)
  })

  it('task.comment：taskId / 正文必填、≤2000 字，rerun 只接受布尔（M7.5）', () => {
    expect(rejectedMessage(cmd('task.comment', {}))).toBe('taskId必填')
    expect(rejectedMessage(cmd('task.comment', { taskId: 't-1' }))).toBe('text必须是字符串')
    expect(rejectedMessage(cmd('task.comment', { taskId: 't-1', text: '   ' }))).toBe('text必填')
    expect(rejectedMessage(cmd('task.comment', { taskId: 't-1', text: longText(2001) }))).toBe(
      'text最长 2000 个字符',
    )
    expect(
      rejectedMessage(cmd('task.comment', { taskId: 't-1', text: '改一下', rerun: 'yes' })),
    ).toBe('rerun必须是布尔值')

    const ok = validateCommand(cmd('task.comment', { taskId: 't-1', text: '改一下', rerun: true }))
    expect(ok.ok).toBe(true)
    expect(ok.ok && ok.command).toEqual(
      expect.objectContaining({ type: 'task.comment', taskId: 't-1', text: '改一下', rerun: true }),
    )
    // rerun 缺省：只校验形状，缺省由内核按 false 处理
    expect(validateCommand(cmd('task.comment', { taskId: 't-1', text: '只记录' })).ok).toBe(true)
  })
})

describe('validateCommand：项目（M10）', () => {
  it('project.create：input 必须是对象，名称与文件夹必填、超长拒收', () => {
    expect(rejectedMessage(cmd('project.create'))).toBe('input 必须是对象')
    expect(rejectedMessage(cmd('project.create', { input: {} }))).toBe('input.name必填')
    expect(
      rejectedMessage(cmd('project.create', { input: { name: 'x'.repeat(101), path: 'D:/w' } })),
    ).toBe('input.name最长 100 个字符')
    expect(rejectedMessage(cmd('project.create', { input: { name: '工作台' } }))).toBe(
      'input.path必填',
    )
    expect(
      rejectedMessage(cmd('project.create', { input: { name: '工作台', path: 'x'.repeat(1001) } })),
    ).toBe('input.path最长 1000 个字符')
    expect(
      rejectedMessage(
        cmd('project.create', { input: { name: '工作台', path: 'D:/w', description: 7 } }),
      ),
    ).toBe('input.description必须是字符串')
    expect(
      validateCommand(
        cmd('project.create', { input: { name: '工作台', path: 'D:/w', description: '说明' } }),
      ).ok,
    ).toBe(true)
  })

  it('project.update：id 必填，patch 只校验给出的字段；project.remove：id 必填', () => {
    expect(rejectedMessage(cmd('project.update', { patch: {} }))).toBe('id必填')
    expect(rejectedMessage(cmd('project.update', { id: 'pj-1', patch: { name: '  ' } }))).toBe(
      'input.name必填',
    )
    expect(rejectedMessage(cmd('project.update', { id: 'pj-1', patch: { path: 7 } }))).toBe(
      'input.path必须是字符串',
    )
    expect(validateCommand(cmd('project.update', { id: 'pj-1', patch: { name: '改名' } })).ok).toBe(
      true,
    )
    expect(rejectedMessage(cmd('project.remove'))).toBe('id必填')
    expect(validateCommand(cmd('project.remove', { id: 'pj-1' })).ok).toBe(true)
  })
})

describe('validateCommand：规则目标项目（M10）', () => {
  const rule = (to: Record<string, unknown>): Record<string, unknown> => ({
    id: 'r-1',
    name: '早报',
    when: { cron: '0 9 * * *' },
    to,
    enabled: true,
  })

  it('to.projectId 可选；给了就必须是合法 id 字符串', () => {
    expect(
      validateCommand(cmd('rules.replace', { rules: [rule({ workflowId: 'wf-1' })] })).ok,
    ).toBe(true)
    expect(
      validateCommand(
        cmd('rules.replace', { rules: [rule({ workflowId: 'wf-1', projectId: 'pj-1' })] }),
      ).ok,
    ).toBe(true)
    expect(
      rejectedMessage(
        cmd('rules.replace', { rules: [rule({ workflowId: 'wf-1', projectId: 7 })] }),
      ),
    ).toBe('rules[0].to.projectId必须是字符串')
    expect(
      rejectedMessage(
        cmd('rules.replace', { rules: [rule({ workflowId: 'wf-1', projectId: '' })] }),
      ),
    ).toBe('rules[0].to.projectId必填')
  })
})

describe('receipt.deliverables（M28：阶段交付物形状）', () => {
  const receipt = (extra: Record<string, unknown>): unknown => ({
    type: 'run.receipt',
    runId: 'run-1',
    receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1, ...extra },
  })

  it('全可选：只给 branch / 只给 commits 都合法；整体缺省也合法', () => {
    expect(validateInput(receipt({})).ok).toBe(true)
    expect(validateInput(receipt({ deliverables: { branch: 'feat/x' } })).ok).toBe(true)
    expect(validateInput(receipt({ deliverables: { base: 'develop' } })).ok).toBe(true)
    expect(validateInput(receipt({ deliverables: { commits: ['57be895'] } })).ok).toBe(true)
    expect(validateInput(receipt({ deliverables: { files: ['src/a.ts'] } })).ok).toBe(true)
    expect(
      validateInput(receipt({ deliverables: { gates: [{ cmd: 'pnpm check', exitCode: 0 }] } })).ok,
    ).toBe(true)
  })

  it('形状不对整块拒：非对象 / 超长 / 超条数 / 门禁条目畸形', () => {
    expect(validateInput(receipt({ deliverables: 'feat/x' })).ok).toBe(false)
    expect(validateInput(receipt({ deliverables: [] })).ok).toBe(false)
    expect(
      validateInput(
        receipt({ deliverables: { branch: 'x'.repeat(DELIVERABLE_LIMITS.maxChars + 1) } }),
      ).ok,
    ).toBe(false)
    expect(
      validateInput(
        receipt({
          deliverables: {
            commits: Array.from({ length: DELIVERABLE_LIMITS.maxCommits + 1 }, () => 'c'),
          },
        }),
      ).ok,
    ).toBe(false)
    expect(validateInput(receipt({ deliverables: { files: [42] } })).ok).toBe(false)
    expect(
      validateInput(receipt({ deliverables: { gates: [{ cmd: 'x', exitCode: 1.5 }] } })).ok,
    ).toBe(false)
  })
})

describe('protocol/validate 派单形状（M29）', () => {
  const withStage = (stage: Record<string, unknown>): WorkflowInput =>
    ({ name: '流程', stages: [{ name: '实现', entryMode: 'none', ...stage }] }) as WorkflowInput
  const message = (input: WorkflowInput): string | undefined =>
    rejectedMessage(cmd('workflow.create', { input }))

  it('handoffs 必须是数组；条目必须是对象', () => {
    expect(message(withStage({ handoffs: 'x' }))).toBe('input.stages[0].handoffs 必须是数组')
    expect(message(withStage({ handoffs: ['x'] }))).toBe('input.stages[0].handoffs[0] 必须是对象')
  })

  it('条数上限按 COMMAND_LIMITS.stageHandoffs', () => {
    const many = Array.from({ length: COMMAND_LIMITS.stageHandoffs + 1 }, () => ({
      on: 'done',
      workflowId: 'wf2',
      stageId: null,
    }))

    expect(message(withStage({ handoffs: many }))).toBe(
      `input.stages[0].handoffs 最多 ${COMMAND_LIMITS.stageHandoffs} 条`,
    )
  })

  it('on 只认五个触发条件；workflowId 必填；stageId 可空；forwardOnly 只认布尔', () => {
    expect(message(withStage({ handoffs: [{ on: 'ok', workflowId: 'wf2' }] }))).toBe(
      'input.stages[0].handoffs[0].on取值必须是 done / errored / passed / failed / manual',
    )
    expect(message(withStage({ handoffs: [{ on: 'done' }] }))).toBe(
      'input.stages[0].handoffs[0].workflowId必填',
    )
    expect(message(withStage({ handoffs: [{ on: 'done', workflowId: 'wf2', stageId: 7 }] }))).toBe(
      'input.stages[0].handoffs[0].stageId必须是字符串',
    )
    expect(
      message(withStage({ handoffs: [{ on: 'manual', workflowId: 'wf2', forwardOnly: 'yes' }] })),
    ).toBe('input.stages[0].handoffs[0].forwardOnly必须是布尔值')
  })

  it('合法清单通过', () => {
    const result = validateCommand(
      cmd('workflow.create', {
        input: withStage({
          handoffs: [
            { on: 'done', workflowId: 'wf2', stageId: 'st2' },
            { on: 'errored', workflowId: 'wf2', stageId: null, forwardOnly: false },
          ],
        }),
      }),
    )

    expect(result.ok).toBe(true)
  })
})
