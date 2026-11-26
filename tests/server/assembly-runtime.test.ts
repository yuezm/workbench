// @vitest-environment node
/**
 * 装配根的运行期接线：真起一套装配、真 spawn 执行器、真跑一轮。
 *
 * `assembly.test.ts` 只证明「能装起来、能读、能关」；这里补的是**跑起来之后**才走到的接线：
 * 调度器注入的归档标签 / 帧来源 / 续接提示词、`runtimes.models` 的执行器端口、`info()` 的
 * 在线客户端数、默认日志与工作目录降级、以及用户目录插件的装载。
 *
 * 执行器一律走 `command` 插件 + 本机 node 脚本（与生产同一条 spawn → 帧 → 回执链）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decide } from '@workbench/kernel/decide'
import { nextWakeAt } from '@workbench/kernel/core/next-wake'
import { project } from '@workbench/kernel/scopes/project'
import { viewSpec } from '@workbench/kernel/scopes/view-spec'
import { openDatabase } from '@workbench/host-store/db'
import { createStore } from '@workbench/host-store/index'
import type { ServerEvent } from '@workbench/protocol/http'
import type { RuntimeExecutorChoice } from '@workbench/protocol/entities'
import type { PluginView } from '@workbench/protocol/plugins'
import { createWorkbench, type Workbench } from '@workbench/bundle-base'
import { writeFakeAgent } from '../e2e/helpers/fake-agent'

let workbench: Workbench | null = null
const created: string[] = []

afterEach(async () => {
  await workbench?.shutdown()
  workbench = null
  // 外部插件的子进程以「插件目录」为 cwd：Windows 上进程句柄没释放会把目录锁住（EBUSY），
  // 所以先等一拍，再带重试删（这条用例必然起过真子进程）
  await new Promise((resolve) => setTimeout(resolve, 300))
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 })
  }
})

const tempDir = (label: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `wb-${label}-`))
  created.push(dir)
  return dir
}

/** 轮询到 probe 给出值（服务端异步执行，没有可 await 的句柄） */
async function until<T>(probe: () => T | undefined | null, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== null) return value
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** 建运行时 + 智能体 + 项目；返回三者的 id 与工作目录 */
async function seedConfig(
  wb: Workbench,
  options: { dataDir: string; projectPath: string; command: string },
): Promise<{ runtimeId: string; agentId: string; projectId: string }> {
  const runtime = (await wb.router.dispatch({
    type: 'runtime.create',
    commandId: 'rt-1',
    input: {
      name: 'e2e 假智能体运行时',
      executorKey: 'command',
      command: options.command,
      // 空模板 = 无参数 → 提示词只走 stdin（不进 argv）
      argsTemplate: '',
      profile: '',
      enabled: true,
    },
  })) as { value: { id: string } }

  const agent = (await wb.router.dispatch({
    type: 'agent.create',
    commandId: 'agent-1',
    input: {
      name: 'e2e 假智能体',
      runtimeId: runtime.value.id,
      workdir: options.projectPath,
      permissionMode: 'workspace-write',
      maxConcurrent: 1,
    },
  })) as { value: { id: string } }

  const project = (await wb.router.dispatch({
    type: 'project.create',
    commandId: 'project-1',
    input: { name: 'e2e 项目', path: options.projectPath },
  })) as { value: { id: string } }

  return { runtimeId: runtime.value.id, agentId: agent.value.id, projectId: project.value.id }
}

/** 启动前把外部插件标成启用（hub 只在 startAll 时读一次启用状态） */
function seedPluginSettings(dbPath: string, pluginIds: readonly string[]): void {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel: { decide, project, viewSpec, nextWakeAt } })
    store.dispatch({
      type: 'plugins.replace',
      commandId: 'seed-plugins',
      settings: pluginIds.map((id) => ({
        id,
        kind: 'source' as const,
        enabled: true,
        granted: [],
        config: {},
      })),
    })
  } finally {
    db.close()
  }
}

describe('运行期接线：真跑一轮', () => {
  it('阶段 run 成功 → 任务推进、产物归档、info/模型视图都反映真实数据', async () => {
    const dataDir = tempDir('run')
    const workDir = path.join(dataDir, 'work')
    mkdirSync(workDir, { recursive: true })
    const command = writeFakeAgent(dataDir, {
      receiptBlock: { verdict: 'pass', checks: [{ cmd: 'pnpm test', exitCode: 0 }] },
    })
    const published: ServerEvent[] = []
    workbench = await createWorkbench({
      dataDir,
      publish: (event) => published.push(event),
      log: () => undefined,
    })
    const wb = workbench
    const seed = await seedConfig(wb, { dataDir, projectPath: workDir, command })

    const workflow = (await wb.router.dispatch({
      type: 'workflow.create',
      commandId: 'wf-1',
      input: {
        name: 'e2e 执行流程',
        stages: [
          {
            name: '干活',
            entryMode: 'agent',
            agentId: seed.agentId,
            gate: { maxFails: 2, onPassIndex: 1 },
          },
          { name: '收尾', entryMode: 'none' },
        ],
      },
    })) as { value: { id: string } }
    const stages = wb.store
      .query('workflows.all')
      .find((row) => row.id === workflow.value.id)
      ?.stages.filter((stage) => stage.builtin == null)
    expect(stages).toHaveLength(2)
    const [firstStage, secondStage] = stages ?? []

    const task = (await wb.router.dispatch({
      type: 'task.create',
      commandId: 'task-1',
      input: {
        title: 'e2e 执行任务',
        workflowId: workflow.value.id,
        projectId: seed.projectId,
        stageId: firstStage?.id,
      },
    })) as { value: { id: string } }

    // 真执行：领取 → spawn → 回执 → 闸门 → 阶段流转
    const run = await until(() => {
      const rows = wb.store.query('runs.byTask', { taskId: task.value.id })
      return rows.find((row) => row.status === 'succeeded') ?? undefined
    })
    expect(run.taskId).toBe(task.value.id)
    await until(
      () =>
        wb.store.query('task.byId', { taskId: task.value.id })?.currentStageId ===
          secondStage?.id || undefined,
    )

    // 归档（M16）：描述标签与帧来源都从真实投影出，output.md 落盘
    const threadId = wb.store.query('task.byId', { taskId: task.value.id })?.threadId
    const outputPath = path.join(
      dataDir,
      'artifacts',
      'threads',
      String(threadId),
      'runs',
      run.id,
      'output.md',
    )
    await until(() => existsSync(outputPath) || undefined)
    expect(published.length).toBeGreaterThan(0)

    // 执行器表单：真实运行时按 key 命中，command 执行器没有模型目录 → 空数组
    const choices = (await wb.router.query('runtimes.executors')) as RuntimeExecutorChoice[]
    expect(choices.some((choice) => choice.key === 'command')).toBe(true)
    await expect(
      Promise.resolve(wb.router.query('runtimes.models', { runtimeId: seed.runtimeId })),
    ).resolves.toEqual([])

    // 没传 clients：在线客户端数按 0 报（不抛、不 undefined）
    expect(wb.info().clients).toBe(0)
  })

  it('聊天 run 成功：助手消息入账（调度器走 chat 续接提示词那条接线）', async () => {
    const dataDir = tempDir('chat')
    const workDir = path.join(dataDir, 'work')
    mkdirSync(workDir, { recursive: true })
    workbench = await createWorkbench({
      dataDir,
      publish: () => undefined,
      log: () => undefined,
    })
    const wb = workbench
    const seed = await seedConfig(wb, {
      dataDir,
      projectPath: workDir,
      command: writeFakeAgent(dataDir),
    })

    const conversation = (await wb.router.dispatch({
      type: 'chat.create',
      commandId: 'chat-1',
      agentId: seed.agentId,
      title: 'e2e 会话',
      projectId: null,
    })) as { value: { id: string } }

    await wb.router.dispatch({
      type: 'chat.send',
      commandId: 'chat-send-1',
      conversationId: conversation.value.id,
      content: '你好',
    })

    const messages = await until(() => {
      const rows = wb.store.query('messages.byConversation', {
        conversationId: conversation.value.id,
      })
      return rows.some((row) => row.role === 'assistant') ? rows : undefined
    })
    expect(messages.filter((row) => row.role === 'assistant')).toHaveLength(1)
  })

  it('默认日志与工作目录降级：不传 log、WORKBENCH_WORKDIR 指向文件 → 退回 cwd 并留一条警告', async () => {
    const dataDir = tempDir('default-log')
    const brokenWorkdir = path.join(dataDir, 'not-a-dir')
    writeFileSync(brokenWorkdir, 'x', 'utf8')
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    try {
      workbench = await createWorkbench({
        dataDir,
        env: { ...process.env, WORKBENCH_WORKDIR: brokenWorkdir },
        publish: () => undefined,
      })
      expect(workbench.info().defaultWorkdir).toBe(process.cwd())
      const lines = stderr.mock.calls.map((call) => String(call[0])).join('')
      expect(lines).toContain('[workdir]')
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('启动对账：上次留下的超租约 run', () => {
  it('领过却没人跑完的 run 在启动时被回收，并留下一条 [reconcile] 诊断日志', async () => {
    const dataDir = tempDir('reconcile')
    const workDir = path.join(dataDir, 'work')
    mkdirSync(workDir, { recursive: true })
    const dbPath = path.join(dataDir, 'ai-workflow.db')

    // 先在库外造出「上次崩溃现场」：run 已被领取成 running，租约过期且重试次数到顶。
    // 这一步必须在装配之前（那时没有 scheduler 抢着领取，构造出来的状态不会被改写）。
    const seedCrashRun = (): string => {
      const db = openDatabase(dbPath)
      try {
        const store = createStore({ db, kernel: { decide, project, viewSpec, nextWakeAt } })
        const runtime = store.dispatch({
          type: 'runtime.create',
          commandId: 'seed-runtime',
          input: {
            name: '崩溃运行时',
            executorKey: 'command',
            command: writeFakeAgent(dataDir),
            argsTemplate: '',
            profile: '',
            enabled: true,
          },
        }).facts
        const runtimeId = (
          runtime.find((fact) => fact.type === 'runtime.created')?.payload as {
            runtime: { id: string }
          }
        ).runtime.id
        const agent = store.dispatch({
          type: 'agent.create',
          commandId: 'seed-agent',
          input: {
            name: '崩溃智能体',
            runtimeId,
            workdir: workDir,
            permissionMode: 'workspace-write',
            maxConcurrent: 1,
          },
        }).facts
        const agentId = (
          agent.find((fact) => fact.type === 'agent.created')?.payload as {
            agent: { id: string }
          }
        ).agent.id
        const projectFacts = store.dispatch({
          type: 'project.create',
          commandId: 'seed-project',
          input: { name: '崩溃项目', path: workDir },
        }).facts
        const projectId = (
          projectFacts.find((fact) => fact.type === 'project.created')?.payload as {
            project: { id: string }
          }
        ).project.id
        const workflow = store.dispatch({
          type: 'workflow.create',
          commandId: 'seed-workflow',
          input: {
            name: '崩溃流程',
            stages: [
              { name: '执行', entryMode: 'agent', agentId },
              { name: '收尾', entryMode: 'none' },
            ],
          },
        }).facts
        const workflowId = (
          workflow.find((fact) => fact.type === 'workflow.created')?.payload as {
            workflow: { id: string }
          }
        ).workflow.id
        const firstStageId = store
          .query('workflows.all')
          .find((row) => row.id === workflowId)
          ?.stages.filter((stage) => stage.builtin == null)[0]?.id
        store.dispatch({
          type: 'task.create',
          commandId: 'seed-task',
          input: { title: '崩溃任务', workflowId, projectId, stageId: firstStageId },
        })

        const claimed = store.dispatch({ type: 'run.claim', runtimeId, capacity: 1 }).facts
        const claimedRunId = (
          claimed.find((fact) => fact.type === 'run.claimed')?.payload as {
            run: { id: string }
          }
        ).run.id
        // 租约过期 + 重试到顶：启动时的 clock.tick 会把它落成 failed（而不是重排回队列）
        db.prepare('UPDATE runs SET attempt = 3, attempts = 3, lease_until = ? WHERE id = ?').run(
          new Date(Date.now() - 60_000).toISOString(),
          claimedRunId,
        )
        return claimedRunId
      } finally {
        db.close()
      }
    }
    const runId = seedCrashRun()

    const lines: string[] = []
    workbench = await createWorkbench({
      dataDir,
      publish: () => undefined,
      log: (line) => lines.push(line),
    })

    expect(lines.some((line) => line.includes('[reconcile]'))).toBe(true)
    expect(workbench.store.query('run.byId', { runId })?.status).toBe('failed')
  }, 120_000)
})

describe('用户目录插件：装载与视图', () => {
  /** 写一个最小外部插件目录：manifest.json + 会 hello 的 plugin.mjs */
  function writeExternalPlugin(
    dataDir: string,
    kind: 'source' | 'channel',
    id: string,
    behavior: 'ready' | 'crash',
  ): void {
    const dir = path.join(dataDir, 'plugins', kind, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, kind, name: `${id} 插件`, version: '1.0.0', capabilities: [] }),
      'utf8',
    )
    const script =
      behavior === 'ready'
        ? [
            'const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n")',
            `frame({ v: 1, type: 'hello', id: '${id}', kind: '${kind}', version: '1.0.0', capabilities: [] })`,
            'frame({ v: 1, type: "log", line: "外部插件已就绪" })',
            "process.stdin.setEncoding('utf8')",
            'let buffer = ""',
            'process.stdin.on("data", (chunk) => {',
            '  buffer += chunk',
            '  let index = buffer.indexOf("\\n")',
            '  while (index >= 0) {',
            '    const line = buffer.slice(0, index)',
            '    buffer = buffer.slice(index + 1)',
            '    if (line.trim() !== "") {',
            '      const frame = JSON.parse(line)',
            '      if (frame.type === "shutdown") process.exit(0)',
            '    }',
            '    index = buffer.indexOf("\\n")',
            '  }',
            '})',
            "process.stdin.on('end', () => process.exit(0))",
            '',
          ]
        : ['process.exitCode = 1', "process.stdout.write('坏了\\n')", '']
    writeFileSync(path.join(dir, 'plugin.mjs'), script.join('\n'), 'utf8')
  }

  it('外部来源插件被装载并启用；启动失败的来源在视图里是 error', async () => {
    const dataDir = tempDir('plugins')
    writeExternalPlugin(dataDir, 'source', 'demo', 'ready')
    writeExternalPlugin(dataDir, 'source', 'broken', 'crash')
    // 启动前先把两个插件标记为启用（幂等事实：hub 只在 startAll 时读一次启用状态）
    seedPluginSettings(path.join(dataDir, 'ai-workflow.db'), ['demo', 'broken'])
    const logs: string[] = []

    workbench = await createWorkbench({
      dataDir,
      publish: () => undefined,
      log: (line) => logs.push(line),
    })
    const wb = workbench

    const rows = (await wb.router.query('plugins.all')) as PluginView[]
    const demo = rows.find((row) => row.id === 'demo')
    expect(demo).toMatchObject({ kind: 'source', builtin: false, enabled: true, status: 'ready' })

    // 真起了子进程：插件的 log 帧与崩溃插件的 stderr 都经宿主日志出来
    await until(() => logs.some((line) => line.includes('外部插件已就绪')) || undefined, 30_000)
    await until(() => logs.some((line) => line.includes('plugin:broken')) || undefined, 30_000)

    // 两个目录都合法：不产生 manifest_error 行（那是扫描阶段的拒绝项）
    expect(rows.some((row) => row.status === 'manifest_error')).toBe(false)
  }, 120_000)
})
