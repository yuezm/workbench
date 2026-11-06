// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card, RunRow, Runtime, RuntimeProbe, Task } from '../../src/protocol/entities'
import type { AutomationRule } from '../../src/protocol/rules'
import type { Command } from '../../src/protocol/commands'
import type { ExecutorPort } from '../../src/protocol/executor'
import { decide } from '../../src/kernel/decide'
import { nextWakeAt } from '../../src/kernel/next-wake'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import type { KernelPort } from '../../src/kernel/types'
import { createCommandRouter, type CommandRouter } from '../../src/host/commands'
import { createProjectionWriter } from '../../src/host/store/projection-apply'
import { createStore, StoreError } from '../../src/host/store/index'
import { createMemoryDb, sample } from './store/test-support'

const NOW = '2026-01-01T00:00:00.000Z'

let openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

const readyProbe: RuntimeProbe = {
  state: 'ready',
  path: 'C:/tools/dsh.exe',
  cliVersion: '1.0.0',
  protocolVersion: 1,
  pluginVersion: null,
  error: null,
  output: 'ok',
  elapsedMs: 3,
  checkedAt: NOW,
}

const unavailableProbe: RuntimeProbe = {
  ...readyProbe,
  state: 'unavailable',
  error: '命令不存在',
}

interface Harness {
  db: DatabaseSync
  store: ReturnType<typeof createStore>
  router: CommandRouter
  dispatched: Array<Record<string, unknown>>
  probe: ReturnType<typeof vi.fn>
  port: ExecutorPort
}

function setup(options: { probeResult?: RuntimeProbe } = {}): Harness {
  const db = createMemoryDb()
  openDbs.push(db)
  const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }
  let counter = 0
  const store = createStore({
    db,
    kernel,
    now: () => NOW,
    newId: () => {
      counter += 1
      return `id-${counter}`
    },
  })
  const probe = vi.fn(async (): Promise<RuntimeProbe> => options.probeResult ?? readyProbe)
  const port: ExecutorPort = {
    probe,
    models: async () => [],
    run: async () => ({ status: 'succeeded', leaseId: 'lease', turn: 1 }),
  }
  const dispatched: Array<Record<string, unknown>> = []
  const router = createCommandRouter({
    store,
    dispatch: (input) => {
      dispatched.push(input as Record<string, unknown>)
      return store.dispatch(input)
    },
    executors: { forRuntime: () => port },
    executorDefaults: (key) => ({
      executorKey: key ?? 'dsh',
      command: 'dsh',
      profile: 'multica',
    }),
    hostView: (view, params) => {
      if (view === 'runtimes.executors')
        return [{ key: 'dsh', label: 'dsh', command: 'dsh', profile: 'm' }]
      if (view === 'runtimes.detected') return []
      return { runtimeId: params?.runtimeId ?? '' }
    },
  })
  return { db, store, router, dispatched, probe, port }
}

const workflowCommand = (commandId = 'c-workflow'): Command => ({
  commandId,
  type: 'workflow.create',
  input: {
    name: '研发',
    stages: [
      { name: '待办', entryMode: 'none' },
      { name: '完成', entryMode: 'user' },
    ],
  },
})

const taskCommand = (workflowId: string, commandId = 'c-task'): Command => ({
  commandId,
  type: 'task.create',
  input: { title: '任务', workflowId },
})

const runtimeInput = { name: '本机 dsh', executorKey: 'dsh' }

describe('host/commands：命令路由（M5）', () => {
  it('普通命令：提交事实并返回实体值；同一 commandId 重复提交返回原事实、不重复落库', async () => {
    const { store, router } = setup()
    const first = await router.dispatch(workflowCommand())
    expect(first.facts.map((fact) => fact.type)).toEqual([
      'workflow.created',
      'stage.created',
      'stage.created',
    ])
    expect((first.value as { name: string; stages: unknown[] }).name).toBe('研发')
    expect((first.value as { stages: unknown[] }).stages).toHaveLength(2)

    const factsBefore = store.factsCount()
    const second = await router.dispatch(workflowCommand())
    expect(second.facts).toEqual(first.facts)
    expect(second.value).toMatchObject({ id: (first.value as { id: string }).id })
    expect(store.factsCount()).toBe(factsBefore)
  })

  it('reject 不记录幂等：同一 commandId 再提交会重新决策并照样拒绝', async () => {
    const { store, router } = setup()
    await expect(router.dispatch(taskCommand('missing'))).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.factsCount()).toBe(0)
    await expect(router.dispatch(taskCommand('missing'))).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('runtime.create：先探测通过才落库，探测结论同批入账；重复提交不再探测', async () => {
    const { store, router, probe } = setup()
    const command: Command = {
      commandId: 'c-runtime',
      type: 'runtime.create',
      input: runtimeInput,
    }
    const result = await router.dispatch(command)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(result.facts.map((fact) => fact.type)).toEqual(['runtime.created', 'runtime.probed'])
    expect((result.value as Runtime).lastProbe?.state).toBe('ready')

    const factsBefore = store.factsCount()
    const replay = await router.dispatch(command)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(store.factsCount()).toBe(factsBefore)
    // 编排命令回放的是「首次落库的内核事实」：探测事实不重复回放，实体值仍取当前行
    expect(replay.facts).toEqual([result.facts[0]])
    expect((replay.value as Runtime).id).toBe((result.value as Runtime).id)
  })

  it('runtime.create：探测失败不落库、不产事实', async () => {
    const { store, router } = setup({ probeResult: unavailableProbe })
    await expect(
      router.dispatch({ commandId: 'c-runtime', type: 'runtime.create', input: runtimeInput }),
    ).rejects.toMatchObject({ code: 'conflict', message: '探测失败：命令不存在' })
    expect(store.factsCount()).toBe(0)
    expect(store.query('runtimes.all')).toEqual([])
  })

  it('runtime.update：保存后重探，探测结论入账', async () => {
    const { router, probe } = setup()
    const created = await router.dispatch({
      commandId: 'c-runtime',
      type: 'runtime.create',
      input: runtimeInput,
    })
    const runtimeId = (created.value as Runtime).id
    const updated = await router.dispatch({
      commandId: 'c-update',
      type: 'runtime.update',
      id: runtimeId,
      patch: { enabled: false },
    })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(updated.facts.map((fact) => fact.type)).toEqual(['runtime.updated', 'runtime.probed'])
    expect((updated.value as Runtime).enabled).toBe(false)
  })

  it('runtime.probe：只传 id，宿主探测并返回结论；重复提交不再探测', async () => {
    const { router, probe } = setup()
    const created = await router.dispatch({
      commandId: 'c-runtime',
      type: 'runtime.create',
      input: runtimeInput,
    })
    const runtimeId = (created.value as Runtime).id
    const probeCommand: Command = { commandId: 'c-probe', type: 'runtime.probe', id: runtimeId }
    const result = await router.dispatch(probeCommand)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(result.facts.map((fact) => fact.type)).toEqual(['runtime.probed'])
    expect((result.value as RuntimeProbe).state).toBe('ready')

    const replay = await router.dispatch(probeCommand)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(replay.facts).toEqual(result.facts)
  })

  it('app.event：白名单内的事件落 event.received；未声明的事件类型拒绝', async () => {
    const { router } = setup()
    const accepted = await router.dispatch({
      commandId: 'c-event',
      type: 'app.event',
      appId: 'pomodoro',
      eventType: 'pomodoro.completed',
      subject: '番茄完成',
    })
    expect(accepted.facts.map((fact) => fact.type)).toEqual(['event.received'])

    await expect(
      router.dispatch({
        commandId: 'c-event-2',
        type: 'app.event',
        appId: 'pomodoro',
        eventType: 'pomodoro.started',
        subject: '开始',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: '未声明的事件类型: pomodoro/pomodoro.started',
    })
    await expect(
      router.dispatch({
        commandId: 'c-event-3',
        type: 'app.event',
        appId: 'unknown',
        eventType: 'pomodoro.completed',
        subject: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rules.replace：整批保存返回新版本与规则清单；重复 commandId 不重复产事实', async () => {
    const { store, router } = setup()
    const workflow = (await router.dispatch(workflowCommand())).value as { id: string }
    const rule: AutomationRule = {
      id: 'rule-1',
      name: 'Issue 进研发',
      when: { source: 'github', types: ['issues.opened'] },
      to: { workflowId: workflow.id },
      enabled: true,
    }
    const command: Command = { commandId: 'c-rules', type: 'rules.replace', rules: [rule] }

    const saved = await router.dispatch(command)
    expect(saved.facts.map((fact) => fact.type)).toEqual(['rules.replaced'])
    expect(saved.value).toEqual({ version: 1, rules: [rule] })
    expect(store.query('rules.all')).toEqual({ version: 1, rules: [rule] })

    // 幂等回放：不重复产事实，返回值与首次一致（读的是当前投影）
    const replay = await router.dispatch(command)
    expect(replay.facts).toEqual(saved.facts)
    expect(replay.value).toEqual(saved.value)
    expect(store.factsCount()).toBe(4) // workflow.created + 2 stage.created + rules.replaced
  })

  it('rules.replace：非法整批 reject，旧规则继续生效', async () => {
    const { store, router } = setup()
    const workflow = (await router.dispatch(workflowCommand())).value as { id: string }
    const rule: AutomationRule = {
      id: 'rule-1',
      name: 'Issue 进研发',
      when: { source: 'github', types: ['issues.opened'] },
      to: { workflowId: workflow.id },
      enabled: true,
    }
    await router.dispatch({ commandId: 'c-rules', type: 'rules.replace', rules: [rule] })

    // 空名在 validateCommand 就拒收：零事实、旧版继续生效
    await expect(
      router.dispatch({
        commandId: 'c-rules-bad',
        type: 'rules.replace',
        rules: [{ ...rule, name: '' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(store.query('rules.all')).toEqual({ version: 1, rules: [rule] })
    expect(store.factsCount()).toBe(4) // 非法整批零事实：仍是 workflow(3) + rules.replaced
  })

  it('rule.trigger：手动运行建一条规则任务并返回任务值；重复 commandId 幂等', async () => {
    const { store, router } = setup()
    const workflow = (await router.dispatch(workflowCommand())).value as { id: string }
    const rule: AutomationRule = {
      id: 'rule-1',
      name: 'Issue 进研发',
      when: { source: 'github', types: ['issues.opened'] },
      to: { workflowId: workflow.id },
      enabled: true,
    }
    await router.dispatch({ commandId: 'c-rules', type: 'rules.replace', rules: [rule] })
    const command: Command = { commandId: 'c-trigger', type: 'rule.trigger', ruleId: 'rule-1' }

    const fired = await router.dispatch(command)
    expect(fired.facts.map((fact) => fact.type)).toEqual([
      // M6.5：手动触发同样建隐式线程并挂任务（D11）
      'thread.opened',
      'thread.task_attached',
      'task.created',
    ])
    const task = fired.value as Task
    expect(task).toMatchObject({
      title: 'Issue 进研发',
      workflowId: workflow.id,
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: null,
    })
    expect(task.threadId).not.toBeNull()
    expect(task.parentTaskId).toBeNull()
    expect(store.query('task.byId', { taskId: task.id })).toEqual(task)

    const replay = await router.dispatch(command)
    expect(replay.facts).toEqual(fired.facts)
    expect(replay.value).toEqual(fired.value)
    expect(store.factsCount()).toBe(7) // workflow(3) + rules.replaced + thread 两行 + task.created
  })

  it('event.received 是宿主输入：不能经命令路由（renderer）提交', async () => {
    const { router } = setup()
    await expect(
      router.dispatch({
        type: 'event.received',
        event: { source: 'github', type: 'issues.opened', subject: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('task.remove：先取消该任务活跃 run，再删任务（进程不成孤儿）', async () => {
    const { db, store, router, dispatched } = setup()
    const workflow = await router.dispatch(workflowCommand())
    const workflowRow = workflow.value as { id: string; stages: Array<{ id: string }> }
    const task = await router.dispatch(taskCommand(workflowRow.id))
    const taskRow = task.value as { id: string; currentStageId: string }
    createProjectionWriter(db).apply(
      {
        table: 'runs',
        key: 'run-active',
        row: sample.run({
          id: 'run-active',
          taskId: taskRow.id,
          stageId: taskRow.currentStageId,
          agentId: null,
          runtimeId: null,
          status: 'queued',
        }),
      },
      NOW,
    )

    dispatched.length = 0
    const result = await router.dispatch({
      commandId: 'c-remove',
      type: 'task.remove',
      id: taskRow.id,
    })
    const types = dispatched.map((input) => input['type'])
    expect(types[0]).toBe('run.cancel')
    expect(types[types.length - 1]).toBe('task.remove')
    expect(result.facts.map((fact) => fact.type)).toContain('task.removed')
    expect(store.query('task.byId', { taskId: taskRow.id })).toBeNull()
  })

  it('chat.remove：先取消该对话活跃聊天 run，再删对话', async () => {
    const { db, store, router, dispatched } = setup()
    const created = router.dispatch({
      commandId: 'c-chat',
      type: 'chat.create',
      agentId: 'ag-missing',
    })
    // 缺智能体会被拒绝；先建运行时/智能体再建对话（覆盖 create 的实体值）
    await expect(created).rejects.toMatchObject({ code: 'not_found' })

    await router.dispatch({
      commandId: 'c-runtime',
      type: 'runtime.create',
      input: runtimeInput,
    })
    const runtime = store.query('runtimes.all')[0]
    if (runtime === undefined) throw new Error('缺少运行时')
    const agent = await router.dispatch({
      commandId: 'c-agent',
      type: 'agent.create',
      input: { name: '助手', runtimeId: runtime.id },
    })
    const conversation = await router.dispatch({
      commandId: 'c-chat-2',
      type: 'chat.create',
      agentId: (agent.value as { id: string }).id,
    })
    const conversationId = (conversation.value as { id: string }).id
    createProjectionWriter(db).apply(
      {
        table: 'runs',
        key: 'run-chat',
        row: sample.run({
          id: 'run-chat',
          purpose: 'chat',
          taskId: null,
          stageId: null,
          agentId: null,
          runtimeId: null,
          conversationId,
          status: 'running',
        }),
      },
      NOW,
    )
    dispatched.length = 0
    await router.dispatch({
      commandId: 'c-chat-remove',
      type: 'chat.remove',
      conversationId,
    })
    const types = dispatched.map((input) => input['type'])
    expect(types[0]).toBe('run.cancel')
    expect(types[types.length - 1]).toBe('chat.remove')
    expect(store.query('conversations.all')).toEqual([])
  })

  it('card.answer：返回回答后的卡片，事实入账', async () => {
    const { db, store, router } = setup()
    const run: RunRow = sample.run({
      id: 'run-waiting',
      taskId: null,
      stageId: null,
      agentId: null,
      runtimeId: null,
      status: 'waiting',
      turn: 2,
      queueSeq: 1,
    })
    const card: Card = sample.card({
      id: 'card-1',
      runId: run.id,
      taskId: null,
      options: ['甲', '乙'],
      status: 'open',
    })
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'runs', key: run.id, row: run }, NOW)
    writer.apply({ table: 'cards', key: card.id, row: card }, NOW)

    const result = await router.dispatch({
      commandId: 'c-answer',
      type: 'card.answer',
      cardId: card.id,
      optionIndex: 1,
      via: 'ui',
    })
    const answered = result.value as Card
    expect(answered.status).toBe('answered')
    expect(answered.optionIndex).toBe(1)
    expect(result.facts.map((fact) => fact.type)).toEqual(['card.answered', 'run.queued'])
    expect(store.query('run.byId', { runId: run.id })?.status).toBe('queued')
  })

  it('query：DB 视图走 store，宿主视图走注入；未知视图/缺参数拒绝', async () => {
    const { router } = setup()
    const workflow = await router.dispatch(workflowCommand())
    const workflowId = (workflow.value as { id: string }).id
    await expect(router.query('tasks.byWorkflow', { workflowId })).resolves.toEqual([])
    await expect(router.query('runtimes.executors')).resolves.toEqual([
      { key: 'dsh', label: 'dsh', command: 'dsh', profile: 'm' },
    ])
    await expect(router.query('runtimes.detected')).resolves.toEqual([])
    await expect(router.query('runtimes.models', { runtimeId: 'rt-1' })).resolves.toEqual({
      runtimeId: 'rt-1',
    })
    await expect(router.query('unknown.view')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(router.query('tasks.byWorkflow')).rejects.toMatchObject({
      code: 'invalid_input',
      message: '视图 tasks.byWorkflow 需要参数 workflowId',
    })
    await expect(router.query('kernel.seq')).resolves.toBeGreaterThan(0)
  })

  it('未知 executorKey：给可读错误（不静默降级）', async () => {
    const harness = setup()
    const router = createCommandRouter({
      store: harness.store,
      dispatch: (input) => harness.store.dispatch(input),
      executors: { forRuntime: () => null },
      executorDefaults: (key) => ({
        executorKey: key ?? 'dsh',
        command: 'dsh',
        profile: 'm',
      }),
      hostView: () => null,
    })
    await expect(
      router.dispatch({ commandId: 'c-runtime', type: 'runtime.create', input: runtimeInput }),
    ).rejects.toMatchObject({ code: 'not_found', message: '执行器插件未注册: dsh' })
  })

  it('非法命令形状由 validateCommand 拒绝', async () => {
    const { router } = setup()
    await expect(router.dispatch({ type: 'task.create' })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    const error = await router
      .dispatch({ commandId: 'c', type: 'task.move', id: 't-1' })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(StoreError)
  })

  it('workflow.remove：先取消该工作流下所有任务的活跃 run，再删工作流', async () => {
    const { db, store, router, dispatched } = setup()
    const workflow = await router.dispatch(workflowCommand())
    const workflowRow = workflow.value as { id: string; stages: Array<{ id: string }> }
    const task = await router.dispatch(taskCommand(workflowRow.id))
    const taskRow = task.value as { id: string; currentStageId: string }
    createProjectionWriter(db).apply(
      {
        table: 'runs',
        key: 'run-active',
        row: sample.run({
          id: 'run-active',
          taskId: taskRow.id,
          stageId: taskRow.currentStageId,
          agentId: null,
          runtimeId: null,
          status: 'running',
        }),
      },
      NOW,
    )
    dispatched.length = 0
    const result = await router.dispatch({
      commandId: 'c-workflow-remove',
      type: 'workflow.remove',
      id: workflowRow.id,
    })
    const types = dispatched.map((input) => input['type'])
    expect(types[0]).toBe('run.cancel')
    expect(types[types.length - 1]).toBe('workflow.remove')
    expect(result.facts.map((fact) => fact.type)).toContain('workflow.removed')
    expect(store.query('workflows.all')).toEqual([])
  })

  it('执行器不支持探测：runtime.create 给 unsupported 且不落库', async () => {
    const harness = setup()
    const router = createCommandRouter({
      store: harness.store,
      dispatch: (input) => harness.store.dispatch(input),
      executors: {
        forRuntime: () => ({
          run: async () => ({ status: 'succeeded', leaseId: 'l', turn: 1 }),
        }),
      },
      executorDefaults: (key) => ({ executorKey: key ?? 'dsh', command: 'dsh', profile: 'm' }),
      hostView: () => null,
    })
    await expect(
      router.dispatch({ commandId: 'c-runtime', type: 'runtime.create', input: runtimeInput }),
    ).rejects.toMatchObject({ code: 'unsupported', message: '执行器不支持探测: dsh' })
    expect(harness.store.factsCount()).toBe(0)
  })

  it('探测失败但无错误文案：按「未知错误」给出可读冲突', async () => {
    const { router } = setup({ probeResult: { ...readyProbe, state: 'unavailable', error: null } })
    await expect(
      router.dispatch({ commandId: 'c-runtime', type: 'runtime.create', input: runtimeInput }),
    ).rejects.toMatchObject({ code: 'conflict', message: '探测失败：未知错误' })
  })

  it('runtime.update / runtime.probe：未知运行时给 not_found', async () => {
    const { router } = setup()
    await expect(
      router.dispatch({
        commandId: 'c-update',
        type: 'runtime.update',
        id: 'rt-missing',
        patch: { enabled: false },
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: '运行时不存在: rt-missing' })
    await expect(
      router.dispatch({ commandId: 'c-probe', type: 'runtime.probe', id: 'rt-missing' }),
    ).rejects.toMatchObject({ code: 'not_found', message: '运行时不存在: rt-missing' })
  })

  it('回放实体值：update / move / resolve / chat.create 各走 valueOf 分支', async () => {
    const { db, store, router } = setup()
    const workflow = await router.dispatch(workflowCommand())
    const workflowRow = workflow.value as { id: string; stages: Array<{ id: string }> }
    const task = await router.dispatch(taskCommand(workflowRow.id))
    const taskRow = task.value as { id: string; currentStageId: string }
    const moveCommand: Command = {
      commandId: 'c-move',
      type: 'task.move',
      id: taskRow.id,
      stageId: workflowRow.stages[1]!.id,
    }
    const moved = await router.dispatch(moveCommand)
    expect((moved.value as { currentStageId: string }).currentStageId).toBe(
      workflowRow.stages[1]!.id,
    )
    const movedReplay = await router.dispatch(moveCommand)
    expect((movedReplay.value as { id: string }).id).toBe(taskRow.id)

    const workflowUpdate: Command = {
      commandId: 'c-workflow-update',
      type: 'workflow.update',
      id: workflowRow.id,
      input: { name: '研发二', stages: [{ name: '待办', entryMode: 'none' }] },
    }
    const updated = await router.dispatch(workflowUpdate)
    expect((updated.value as { name: string }).name).toBe('研发二')
    expect(((await router.dispatch(workflowUpdate)).value as { name: string }).name).toBe('研发二')

    await router.dispatch({ commandId: 'c-runtime', type: 'runtime.create', input: runtimeInput })
    const runtime = store.query('runtimes.all')[0]
    if (runtime === undefined) throw new Error('缺少运行时')
    const agent = await router.dispatch({
      commandId: 'c-agent',
      type: 'agent.create',
      input: { name: '助手', runtimeId: runtime.id },
    })
    const agentId = (agent.value as { id: string }).id
    const agentUpdate: Command = {
      commandId: 'c-agent-update',
      type: 'agent.update',
      id: agentId,
      patch: { name: '新助手' },
    }
    expect(((await router.dispatch(agentUpdate)).value as { name: string }).name).toBe('新助手')
    expect(((await router.dispatch(agentUpdate)).value as { name: string }).name).toBe('新助手')

    const run = sample.run({
      id: 'run-waiting-2',
      taskId: null,
      stageId: null,
      agentId: null,
      runtimeId: null,
      status: 'waiting',
      turn: 2,
    })
    const card = sample.card({
      id: 'card-2',
      runId: run.id,
      taskId: null,
      status: 'open',
    })
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'runs', key: run.id, row: run }, NOW)
    writer.apply({ table: 'cards', key: card.id, row: card }, NOW)
    const resolveCommand: Command = {
      commandId: 'c-resolve',
      type: 'card.resolve',
      cardId: card.id,
    }
    expect(((await router.dispatch(resolveCommand)).value as Card).status).toBe('resolved')
    expect(((await router.dispatch(resolveCommand)).value as Card).status).toBe('resolved')

    const chatCreate: Command = {
      commandId: 'c-chat-create',
      type: 'chat.create',
      agentId,
    }
    expect(((await router.dispatch(chatCreate)).value as { id: string }).id).toBeTruthy()
    expect(((await router.dispatch(chatCreate)).value as { id: string }).id).toBeTruthy()
  })

  it('回放零事实命令：事实为空、实体值为 null（不重新决策）', async () => {
    const { store, router } = setup()
    store.rememberCommand('c-empty', [])
    const result = await router.dispatch(workflowCommand('c-empty'))
    expect(result.facts).toEqual([])
    expect(result.value).toBeNull()
  })

  it('chat.remove：对话不存在时静默（preflight 无活跃 run，内核零事实）', async () => {
    const { router } = setup()
    const result = await router.dispatch({
      commandId: 'c-chat-remove',
      type: 'chat.remove',
      conversationId: 'cv-missing',
    })
    expect(result.facts).toEqual([])
    expect(result.value).toBeNull()
  })

  it('回放 chat.create：对话已被删除时实体值为 null（不伪造行）', async () => {
    const { db, store, router } = setup()
    db.prepare(
      `INSERT INTO facts (type, actor_json, at, cause, hops, payload) VALUES
       ('conversation.created', '{"kind":"owner","via":"ui"}', ?, NULL, NULL,
        '{"conversation":{"id":"cv-gone"}}')`,
    ).run(NOW)
    const seq = (db.prepare('SELECT MAX(seq) AS n FROM facts').get() as unknown as { n: number }).n
    store.rememberCommand('c-chat-gone', [
      {
        seq,
        type: 'conversation.created',
        actor: { kind: 'owner', via: 'ui' },
        at: NOW,
        payload: { conversation: { id: 'cv-gone' } },
      } as never,
    ])

    const result = await router.dispatch({
      commandId: 'c-chat-gone',
      type: 'chat.create',
      agentId: 'ag-1',
    })

    expect(result.facts).toHaveLength(1)
    expect(result.facts[0]?.type).toBe('conversation.created')
    expect(result.value).toBeNull()
  })
})

describe('host/commands：防御分支与默认值', () => {
  it('runtime.create 未指定 executorKey：按注册表首项补默认值', async () => {
    const { router } = setup()
    const result = await router.dispatch({
      commandId: 'c-default',
      type: 'runtime.create',
      input: { name: '无键运行时' },
    })
    expect((result.value as Runtime).executorKey).toBe('dsh')
    expect((result.value as Runtime).command).toBe('dsh')
    expect((result.value as Runtime).profile).toBe('multica')
  })

  it('编排命令的事实被丢弃时给 unsupported（防御分支）', async () => {
    const harness = setup()
    const router = createCommandRouter({
      store: harness.store,
      dispatch: (input) => {
        const record = input as { type?: string }
        if (record.type === 'runtime.create') return { facts: [] }
        return harness.store.dispatch(input)
      },
      executors: { forRuntime: () => harness.port },
      executorDefaults: (key) => ({ executorKey: key ?? 'dsh', command: 'dsh', profile: 'm' }),
      hostView: () => null,
    })
    await expect(
      router.dispatch({ commandId: 'c-runtime', type: 'runtime.create', input: runtimeInput }),
    ).rejects.toMatchObject({ code: 'unsupported', message: '缺少事实: runtime.created' })
  })

  it('runtime.update 的实体行缺失时给 not_found（防御分支）', async () => {
    const harness = setup()
    const router = createCommandRouter({
      store: harness.store,
      dispatch: (input) => {
        const record = input as { type?: string }
        if (record.type === 'runtime.update') return { facts: [] }
        return harness.store.dispatch(input)
      },
      executors: { forRuntime: () => harness.port },
      executorDefaults: (key) => ({ executorKey: key ?? 'dsh', command: 'dsh', profile: 'm' }),
      hostView: () => null,
    })
    await expect(
      router.dispatch({
        commandId: 'c-update',
        type: 'runtime.update',
        id: 'rt-x',
        patch: { enabled: false },
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: '运行时不存在: rt-x' })
  })

  it('回放空事实：所有 valueOf 分支返回 null', async () => {
    const { store, router } = setup()
    const cases: Command[] = [
      {
        commandId: 'e1',
        type: 'workflow.create',
        input: { name: 'x', stages: [{ name: '待办', entryMode: 'none' }] },
      },
      { commandId: 'e2', type: 'agent.create', input: { name: 'a', runtimeId: 'rt-1' } },
      { commandId: 'e3', type: 'runtime.create', input: runtimeInput },
      { commandId: 'e4', type: 'runtime.update', id: 'rt-1', patch: { enabled: false } },
      { commandId: 'e5', type: 'runtime.probe', id: 'rt-1' },
      { commandId: 'e6', type: 'task.create', input: { title: 't', workflowId: 'wf-1' } },
      { commandId: 'e7', type: 'task.move', id: 't-1', stageId: 's-1' },
      { commandId: 'e8', type: 'card.answer', cardId: 'card-1', optionIndex: 0 },
      { commandId: 'e9', type: 'card.resolve', cardId: 'card-1' },
      { commandId: 'e10', type: 'chat.create', agentId: 'ag-1' },
      {
        commandId: 'e11',
        type: 'workflow.update',
        id: 'wf-missing',
        input: { name: 'x', stages: [{ name: '待办', entryMode: 'none' }] },
      },
      { commandId: 'e12', type: 'agent.update', id: 'ag-missing', patch: { name: 'x' } },
      { commandId: 'e13', type: 'rule.trigger', ruleId: 'rule-missing' },
    ]
    for (const command of cases) store.rememberCommand(command.commandId, [])
    for (const command of cases) {
      const result = await router.dispatch(command)
      expect(result.facts, command.type).toEqual([])
      expect(result.value, command.type).toBeNull()
    }
  })

  it('回放坏载荷：实体缺少 id / id 非字符串时 value 为 null（不抛）', async () => {
    const { db, store, router } = setup()
    db.prepare(
      `INSERT INTO facts (type, actor_json, at, cause, hops, payload) VALUES
       ('workflow.created', '{"kind":"owner","via":"ui"}', ?, NULL, NULL, '{"workflow":{"name":"x"}}')`,
    ).run(NOW)
    db.prepare(
      `INSERT INTO facts (type, actor_json, at, cause, hops, payload) VALUES
       ('workflow.created', '{"kind":"owner","via":"ui"}', ?, NULL, NULL, '{"workflow":{"id":7}}')`,
    ).run(NOW)
    const factAt = {
      seq: 1,
      type: 'workflow.created' as const,
      actor: { kind: 'owner' as const, via: 'ui' as const },
      at: NOW,
      payload: { workflow: { id: 'wf-1' } },
    }
    store.rememberCommand('c-bad-payload', [factAt] as never)
    expect(
      (
        await router.dispatch({
          commandId: 'c-bad-payload',
          type: 'workflow.create',
          input: { name: 'x', stages: [{ name: '待办', entryMode: 'none' }] },
        })
      ).value,
    ).toBeNull()

    store.rememberCommand('c-bad-payload-2', [{ ...factAt, seq: 2 }] as never)
    expect(
      (
        await router.dispatch({
          commandId: 'c-bad-payload-2',
          type: 'workflow.create',
          input: { name: 'x', stages: [{ name: '待办', entryMode: 'none' }] },
        })
      ).value,
    ).toBeNull()
  })
})

describe('host/commands：跨类型事实区间回放', () => {
  it('区间内先出现无关事实：跳过它再取实体 id（entityIdOf continue 分支）', async () => {
    const { db, store, router } = setup()
    db.prepare(
      `INSERT INTO facts (type, actor_json, at, cause, hops, payload) VALUES
       ('event.received', '{"kind":"host","via":"channel"}', ?, NULL, NULL, '{"source":"app"}')`,
    ).run(NOW)
    db.prepare(
      `INSERT INTO facts (type, actor_json, at, cause, hops, payload) VALUES
       ('workflow.created', '{"kind":"owner","via":"ui"}', ?, NULL, NULL, '{"workflow":{"id":"wf-mixed"}}')`,
    ).run(NOW)
    createProjectionWriter(db).apply(
      {
        table: 'workflows',
        key: 'wf-mixed',
        row: sample.workflow({ id: 'wf-mixed', name: '混合' }),
      },
      NOW,
    )
    store.rememberCommand('c-mixed', [
      {
        seq: 1,
        type: 'event.received',
        actor: { kind: 'host', via: 'channel' },
        at: NOW,
        payload: { source: 'app' } as never,
      },
      {
        seq: 2,
        type: 'workflow.created',
        actor: { kind: 'owner', via: 'ui' },
        at: NOW,
        payload: { workflow: { id: 'wf-mixed' } } as never,
      },
    ] as never)

    const result = await router.dispatch({
      commandId: 'c-mixed',
      type: 'workflow.create',
      input: { name: '混合', stages: [{ name: '待办', entryMode: 'none' }] },
    })
    expect((result.value as { id: string }).id).toBe('wf-mixed')
  })
})
