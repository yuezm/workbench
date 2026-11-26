/**
 * 核心流程 E2E：**执行成功 → 产物归档落盘 → 服务重启后仍可读**。
 *
 * 归档是「跑完就散」与「留下可复查痕迹」的分界：`<dataDir>/artifacts/threads/<threadId>/runs/<runId>/`
 * 下的 `output.md` 是任务索引与后续轮次的入口，重启时 `backfillRunOutputs` 还会再补齐一次
 * （幂等）。这条链路此前只有 `host/artifacts` 的单测，没有走过「真执行 → 落盘 → 重启再读」。
 *
 * 断言：
 * 1. 真 spawn 的执行成功后，`output.md` 存在且含假智能体的回复标记；
 * 2. 任务索引（`index.md`）指向该 run；
 * 3. 关掉服务、用同一份数据目录重启后，任务、run 输出与产物文件都还在（没有被回填逻辑改坏）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type Page } from '@playwright/test'
import type { WorkbenchApi } from '@workbench/contract-api'
import { FAKE_AGENT_MARKER, writeFakeAgent } from './helpers/fake-agent'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readAgentState, seedAgentBase, type AgentSeed } from './helpers/seed-agent'

let launched: LaunchedApp | undefined
let seed: AgentSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

/** 任务的线程 id（归档目录按线程分） */
function threadIdOf(dbPath: string, taskId: string): string | null {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('SELECT thread_id FROM tasks WHERE id = ?').get(taskId) as
      { thread_id: string | null } | undefined
    return row?.thread_id ?? null
  } finally {
    db.close()
  }
}

test('成功执行 → 产物落盘 → 重启后任务、输出与归档文件都还在', async () => {
  test.setTimeout(240_000)

  const userDataDir = createTempUserDataDir()
  const workDir = path.join(userDataDir, 'work')
  mkdirSync(workDir, { recursive: true })
  const command = writeFakeAgent(userDataDir, {
    receiptBlock: { verdict: 'pass', checks: [{ cmd: 'pnpm test', exitCode: 0 }] },
  })

  seed = await seedAgentBase(path.join(userDataDir, 'ai-workflow.db'), {
    command,
    projectPath: workDir,
    stages: [
      { name: '干活', entryMode: 'agent', gate: { maxFails: 2, onPassIndex: 1 } },
      { name: '收尾', entryMode: 'none' },
    ],
  })
  const seeded = seed
  const workflowId = seeded.workflowId
  if (workflowId === null) throw new Error('归档种子：工作流没建出来')

  launched = await launchApp({ userDataDir })
  let page: Page = launched.page
  await expect(page).toHaveTitle('Workbench')

  await page.evaluate(
    (input) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({ type: 'task.create', commandId: 'e2e-archive-task', input })
    },
    {
      title: 'e2e 归档任务',
      workflowId,
      projectId: seeded.projectId,
      stageId: seeded.stageIds[0],
    },
  )

  // 1) 真执行 → 闸门通过 → 任务进「收尾」
  await expect
    .poll(
      () =>
        readAgentState(seeded.dbPath).tasks.find(
          (task) => task.currentStageId === seeded.stageIds[1],
        )?.currentStageId ?? null,
      { timeout: 120_000 },
    )
    .toBe(seeded.stageIds[1])

  const state = readAgentState(seeded.dbPath)
  const stageRun = state.runs.find((run) => run.purpose === 'stage')
  expect(stageRun?.status).toBe('succeeded')
  expect(stageRun?.output).toContain(FAKE_AGENT_MARKER)

  const taskId = state.tasks[0]?.id as string
  const threadId = threadIdOf(seeded.dbPath, taskId)
  expect(threadId).not.toBeNull()

  // 2) 归档落盘：output.md 有正文，任务索引指向这一轮
  const runDir = path.join(
    userDataDir,
    'artifacts',
    'threads',
    threadId as string,
    'runs',
    stageRun?.id as string,
  )
  const outputPath = path.join(runDir, 'output.md')
  await expect.poll(() => existsSync(outputPath), { timeout: 30_000 }).toBe(true)
  expect(readFileSync(outputPath, 'utf8')).toContain(FAKE_AGENT_MARKER)

  const indexPath = path.join(userDataDir, 'artifacts', 'threads', threadId as string, 'index.md')
  await expect.poll(() => existsSync(indexPath), { timeout: 30_000 }).toBe(true)
  expect(readFileSync(indexPath, 'utf8')).toContain(stageRun?.id as string)

  // 3) 关服务（保留数据目录）→ 同一份目录重启
  await launched.close({ removeUserData: false })
  launched = undefined
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  const restarted = readAgentState(seeded.dbPath)
  expect(restarted.tasks[0]?.currentStageId).toBe(seeded.stageIds[1])
  expect(restarted.runs.find((run) => run.id === stageRun?.id)?.output).toContain(FAKE_AGENT_MARKER)
  // 回填是幂等的：重启不会清空或重写已有正文
  expect(readFileSync(outputPath, 'utf8')).toContain(FAKE_AGENT_MARKER)

  const runs = await page.evaluate((id) => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.query('runs.byTask', { taskId: id })
  }, taskId)
  const reopened = runs.find((run) => run.id === stageRun?.id)
  expect(reopened?.status).toBe('succeeded')
})
