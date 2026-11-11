// @vitest-environment node
/**
 * T8 端到端验收：证明「新增一个运行时协议 = 只写插件 + registry 一行」。
 *
 * 验收路径（不 import `src/main/**`、不 import `electron`、不真 spawn 进程）：
 * 1. 假协议插件（`tests/plugins/support/fake-plugin.ts`）实现 `ExecutorPlugin`；
 * 2. 把 `fakePluginEntry` 作为一条 entry 拼进注册表清单，交给**真** `createExecutorRegistry`
 *    （内置 dsh 仍在清单里，说明新协议只是清单多一行）；
 * 3. 内存库 + 真 `createStore`（真 decide/project/viewSpec）+ 真 `createScheduler`
 *    + 真 `createEffects`，命令全部走真实决策路径，`run.queued` 由内核产生；
 * 4. `scheduler.wake()` / `idle()` 后读投影断言：run 挂 fake、两帧按宿主 seq 入账、
 *    终态事实在帧之后；另一条 `executorKey` 的运行时只会取到自己的插件。
 *
 * 断言清单：
 * - `runs.byTask` 的 run `status === 'succeeded'`；`run.byId` 的 `executorKey === 'fake'`；
 * - `run.events` 恰好两帧、`seq` 从 1 单调、`type === 'text'`、文本按插件发送顺序；
 * - `run.frames` 事实全部早于终态事实 `run.succeeded`（终态在帧之后）；
 * - fake 插件 `run` 被调用一次，拿到的是 stage 轮与正确的 `leaseId`；
 * - 同一注册表里 dsh 运行时取到 dsh entry、fake 运行时取到 fake entry，互不串用；
 * - 未注册的 `executorKey` 取端口返回 `null`（调度器据此落 runtime_missing 兜底）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createEffects, type Effects } from '../../src/host/effects'
import { openDatabase } from '../../src/host/db'
import { createExecutorRegistry, type ExecutorPluginEntry } from '../../src/host/executor-registry'
import { createScheduler, type Scheduler, type SchedulerExecutors } from '../../src/host/scheduler'
import { createStore, type Store } from '../../src/host/store/index'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import type { KernelPort } from '../../src/kernel/types'
import { executors } from '../../src/plugins/registry'
import type { Runtime, Task, WorkflowStage } from '../../src/protocol/entities'
import type { Turn } from '../../src/protocol/executor'
import type { ExecutorContext, ExecutorPlugin, SdkHost } from '../../src/sdk/types'
import { FAKE_FRAME_TEXTS, fakePlugin, fakePluginEntry } from '../plugins/support/fake-plugin'

const kernel: KernelPort = { decide, project, viewSpec }

/** 假宿主能力面：执行器测试不需要真进程 / 真文件系统，所有方法给最小实现。 */
const fakeSdkHost: SdkHost = {
  log: () => undefined,
  now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  paths: { sessionRoot: null },
  config: <T = Record<string, unknown>>() => ({}) as T,
  process: {
    // 假协议不 spawn：真被调用说明用例接错了路径，直接失败
    spawn: () => {
      throw new Error('假 SdkHost 不启动子进程')
    },
    resolve: (command) => ({ path: null, error: `假 SdkHost 不解析命令：${command}` }),
    killTree: () => false,
    scanDirs: () => [],
    findInDirs: () => null,
  },
}

const worlds: World[] = []
let commandSeq = 0

const nextCommandId = (): string => {
  commandSeq += 1
  return `cmd-${commandSeq}`
}

interface World {
  db: DatabaseSync
  store: Store
  effects: Effects
  scheduler: Scheduler
  /** 真装配出来的 SchedulerExecutors（按 runtime.executorKey 路由插件） */
  executors: SchedulerExecutors
}

/** 内存库 + 真 store + 真 effects + 真 scheduler，写入口统一走 effects.dispatch。 */
function makeWorld(entries: readonly ExecutorPluginEntry[]): World {
  const db = openDatabase(':memory:')
  const store = createStore({ db, kernel })
  store.ensureProjection()
  const holder: { scheduler?: Scheduler } = {}
  const effects = createEffects({
    store,
    scheduler: () => {
      if (holder.scheduler === undefined) throw new Error('调度器尚未装配')
      return holder.scheduler
    },
  })
  const schedulerExecutors = createExecutorRegistry(entries, fakeSdkHost)
  const scheduler = createScheduler({
    dispatch: (input) => effects.dispatch(input),
    runtimes: () => store.query('runtimes.all'),
    agents: () => store.query('agents.all'),
    executors: schedulerExecutors,
    limits: {
      heartbeatMs: 30_000,
      runTimeoutMs: 600_000,
      maxFramesPerBatch: 500,
      cancelGraceMs: 20,
      killAfterMs: 20,
    },
    lastFrameSeq: (runId) => store.query('run.last-event-seq', { runId }),
  })
  holder.scheduler = scheduler
  const world: World = { db, store, effects, scheduler, executors: schedulerExecutors }
  worlds.push(world)
  return world
}

afterEach(() => {
  for (const world of worlds.splice(0)) world.db.close()
})

interface Seeded {
  runtime: Runtime
  task: Task
  runId: string
}

/**
 * 走真实决策路径种一条「运行时 + 智能体 + 两阶段工作流（首阶段 agent）+ 任务」；
 * 任务进入 agent 阶段时内核自己产 `run.queued`，不手工造 run。
 */
function seedTask(world: World, executorKey: string): Seeded {
  const runtimeFacts = world.effects.dispatch({
    type: 'runtime.create',
    commandId: nextCommandId(),
    input: { name: `rt-${executorKey}-${commandSeq}`, executorKey, command: 'fake-cli' },
  }).facts
  const createdRuntime = (
    runtimeFacts.find((fact) => fact.type === 'runtime.created')?.payload as {
      runtime: Runtime
    }
  ).runtime
  const runtime = world.store.query('runtimes.all').find((item) => item.id === createdRuntime.id)
  if (runtime === undefined) throw new Error('运行时未落投影: ' + createdRuntime.id)

  const agentFacts = world.effects.dispatch({
    type: 'agent.create',
    commandId: nextCommandId(),
    input: { name: 'coder', runtimeId: runtime.id, systemPrompt: 'sys' },
  }).facts
  const agentId = (
    agentFacts.find((fact) => fact.type === 'agent.created')?.payload as {
      agent: { id: string }
    }
  ).agent.id

  const workflowFacts = world.effects.dispatch({
    type: 'workflow.create',
    commandId: nextCommandId(),
    input: {
      name: 'w',
      stages: [
        { name: '执行', entryMode: 'agent', agentId },
        { name: '完成', entryMode: 'none' },
      ],
    },
  }).facts
  const workflowId = (
    workflowFacts.find((fact) => fact.type === 'workflow.created')?.payload as {
      workflow: { id: string }
    }
  ).workflow.id
  // M18：新任务默认落内置「待办」（不派活）；要起 run 必须显式落到自己添加的阶段
  const stageId = (
    workflowFacts
      .filter((fact) => fact.type === 'stage.created')
      .map((fact) => (fact.payload as { stage: WorkflowStage }).stage)
      .find((stage) => (stage.builtin ?? null) === null) as WorkflowStage
  ).id

  // M10：任务必须挂在项目下（项目文件夹就是本轮工作目录）。
  // 同一个库里可能 seed 多次：名称与路径都要唯一（内核按项目集判重）。
  const projectLabel = nextCommandId()
  const projectFacts = world.effects.dispatch({
    type: 'project.create',
    commandId: `pj-${projectLabel}`,
    input: { name: `项目 ${projectLabel}`, path: `D:/work/${projectLabel}` },
  }).facts
  const projectId = (
    projectFacts.find((fact) => fact.type === 'project.created')?.payload as {
      project: { id: string }
    }
  ).project.id

  const taskFacts = world.effects.dispatch({
    type: 'task.create',
    commandId: nextCommandId(),
    input: { title: 'T', description: 'd', workflowId, projectId, stageId },
  }).facts
  const task = (taskFacts.find((fact) => fact.type === 'task.created')?.payload as { task: Task })
    .task

  const run = world.store.query('runs.byTask', { taskId: task.id })[0]
  if (run === undefined) throw new Error('内核没有为 agent 阶段产生 run')
  return { runtime, task, runId: run.id }
}

/** 事实日志的类型序列（断言 run.frames 早于 run.receipt 等先后关系）。 */
const factTypes = (world: World): string[] =>
  (
    world.db.prepare('SELECT type FROM facts ORDER BY seq').all() as unknown as Array<{
      type: string
    }>
  ).map((row) => row.type)

/** 包一层 run spy：转发给原插件，同时记录每一轮 Turn，用来数调用次数。 */
function withRunSpy(plugin: ExecutorPlugin): { plugin: ExecutorPlugin; calls: Turn[] } {
  const calls: Turn[] = []
  return {
    calls,
    plugin: {
      ...plugin,
      run: (ctx: ExecutorContext, turn: Turn, io) => {
        calls.push(turn)
        return plugin.run(ctx, turn, io)
      },
    },
  }
}

/** 只记录调用的假插件（替身 entry 用，不跑任何真实执行器实现）。 */
function recordingPlugin(text: string): { plugin: ExecutorPlugin; calls: Turn[] } {
  const calls: Turn[] = []
  return {
    calls,
    plugin: {
      async run(_ctx, turn, io) {
        calls.push(turn)
        io.emit({ seq: 99, type: 'text', text })
        return {
          status: 'succeeded',
          leaseId: turn.leaseId,
          turn: turn.turn,
          output: text,
          exitCode: 0,
          durationMs: 1,
        }
      },
    },
  }
}

describe('假协议端到端验收（只写插件 + registry 一行）', () => {
  it('fake 运行时走完整决策链：两帧按宿主 seq 入账、终态在帧之后', async () => {
    const spy = withRunSpy(fakePlugin)
    // registry 唯一改动：清单多一行 fake（内置 dsh 原样保留）
    const entries: ExecutorPluginEntry[] = [
      ...executors,
      { ...fakePluginEntry, plugin: spy.plugin },
    ]
    const world = makeWorld(entries)
    const seeded = seedTask(world, 'fake')

    world.scheduler.wake()
    await world.scheduler.idle()

    // 1) run 挂到 fake，成功终态、无错误
    const runs = world.store.query('runs.byTask', { taskId: seeded.task.id })
    expect(runs.map((run) => run.status)).toEqual(['succeeded'])
    const run = world.store.query('run.byId', { runId: seeded.runId })
    if (run === null) throw new Error('run 未落投影: ' + seeded.runId)
    // runs.byTask 是 IPC 形状（不含调度列），executorKey 经 run.byId 读投影行
    expect(run.executorKey).toBe('fake')
    expect(run.status).toBe('succeeded')
    expect(run.error).toBeNull()
    expect(run.errorCode).toBeNull()
    expect(run.leaseId).toBeNull()

    // 2) 帧：插件本地 seq 被丢弃，宿主按 run 从 1 重新分配
    const events = world.store.query('run.events', { runId: seeded.runId })
    expect(events.map((event) => [event.seq, event.type, event.text])).toEqual([
      [1, 'text', FAKE_FRAME_TEXTS[0]],
      [2, 'text', FAKE_FRAME_TEXTS[1]],
    ])
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.seq).toBeGreaterThan(events[index - 1]!.seq)
    }

    // 3) 终态事实在帧之后：宿主的执行链先 flush 帧、再落 run.receipt 派生的终态
    const types = factTypes(world)
    const lastFrames = types.lastIndexOf('run.frames')
    const settled = types.lastIndexOf('run.succeeded')
    expect(lastFrames).toBeGreaterThanOrEqual(0)
    expect(settled).toBeGreaterThan(lastFrames)

    // 4) 插件确实被调用一次，拿到的是内核领取后的 stage 轮与租约
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]?.purpose).toBe('stage')
    expect(spy.calls[0]?.turn).toBe(1)
    expect(spy.calls[0]?.leaseId).toBe(`${seeded.runId}:1`)

    // 5) 注册表把插件的 probe/models 接进端口（配置表单路径，不参与调度）
    const port = world.executors.forRuntime(seeded.runtime)
    if (port === null) throw new Error('fake 运行时未取到执行器端口')
    if (port.probe === undefined || port.models === undefined) {
      throw new Error('fake 插件缺少 probe/models')
    }
    expect((await port.probe(seeded.runtime)).state).toBe('ready')
    expect(await port.models(seeded.runtime)).toEqual([])
  })

  it('按 runtime.executorKey 路由：fake 与 dsh 各自取到自己的 entry，互不调用', async () => {
    const builtin = executors.find((entry) => entry.key === 'dsh')
    if (builtin === undefined) throw new Error('内置注册表缺少 dsh 执行器')
    const dsh = recordingPlugin('dsh 帧')
    const fake = recordingPlugin('fake 帧')
    // 假 entries：dsh 用记录型插件替身（不真跑 dsh），fake 同样记录调用
    const entries: ExecutorPluginEntry[] = [
      { ...builtin, plugin: dsh.plugin },
      { ...fakePluginEntry, plugin: fake.plugin },
    ]
    const world = makeWorld(entries)

    const dshTask = seedTask(world, 'dsh')
    world.scheduler.wake()
    await world.scheduler.idle()

    expect(dsh.calls).toHaveLength(1)
    expect(fake.calls).toHaveLength(0)
    const dshRun = world.store.query('run.byId', { runId: dshTask.runId })
    expect(dshRun?.executorKey).toBe('dsh')
    expect(dshRun?.status).toBe('succeeded')

    const fakeTask = seedTask(world, 'fake')
    world.scheduler.wake()
    await world.scheduler.idle()

    expect(fake.calls).toHaveLength(1)
    expect(dsh.calls).toHaveLength(1)
    const fakeRun = world.store.query('run.byId', { runId: fakeTask.runId })
    expect(fakeRun?.executorKey).toBe('fake')
    expect(fakeRun?.status).toBe('succeeded')

    // 同一条运行时配置取到的端口稳定（插件实例不串用）；未注册的 key 返回 null
    expect(world.executors.forRuntime(fakeTask.runtime)).not.toBe(
      world.executors.forRuntime(dshTask.runtime),
    )
    expect(
      world.executors.forRuntime({ ...fakeTask.runtime, executorKey: 'not-registered' }),
    ).toBeNull()
  })
})
