/**
 * 闸门闭环 E2E：**真实子进程执行 + 闸门判定**。
 *
 * 工作流：`干活`（agent 阶段，兼作闸门）→ `收尾`（none 阶段）。
 * 假智能体在输出末尾带回执块（```json 围栏），给出 `verdict=pass` 与一条退出码 0 的证据；
 * 内核据此判闸门通过，把任务送到「通过时进入」的阶段。
 *
 * 覆盖的是「建任务 → 领取 → 真实 spawn → 回执块解析 → 闸门判定 → 阶段流转 → 任务落新阶段」
 * 这条链路——M11 闸门最核心的一段，此前只有单测覆盖，没有走过真实执行链。
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { WorkbenchApi } from '../../src/shared/workbench-api'
import { FAKE_AGENT_MARKER, writeFakeAgent } from './helpers/fake-agent'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readAgentState, seedAgentBase, type AgentSeed } from './helpers/seed-agent'

let launched: LaunchedApp | undefined
let page: Page
let seed: AgentSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('闸门闭环：真实执行带回执块判定 → 任务通过闸门进入收尾阶段', async () => {
  test.setTimeout(180_000)

  const userDataDir = createTempUserDataDir()
  const workDir = path.join(userDataDir, 'work')
  mkdirSync(workDir, { recursive: true })
  // 假智能体：回一句话 + 给闸门判定与证据（回执块只认最后一个 ```json 围栏）
  const command = writeFakeAgent(userDataDir, {
    receiptBlock: {
      verdict: 'pass',
      checks: [{ cmd: 'pnpm test', exitCode: 0 }],
    },
  })

  seed = await seedAgentBase(path.join(userDataDir, 'ai-workflow.db'), {
    command,
    projectPath: workDir,
    stages: [
      // 阶段 0：交给智能体，兼作闸门（通过时进入阶段 1）
      { name: '干活', entryMode: 'agent', gate: { maxFails: 2, onPassIndex: 1 } },
      { name: '收尾', entryMode: 'none' },
    ],
  })
  const seeded = seed
  const workflowId = seeded.workflowId
  if (workflowId === null) throw new Error('闸门种子：工作流没建出来')
  expect(seeded.stageIds).toHaveLength(2)

  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 建任务（经桥发命令，界面层由既有 e2e 覆盖）
  const created = await page.evaluate(
    (input) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({
        type: 'task.create',
        commandId: 'e2e-gate-task',
        input,
      })
    },
    { title: '闸门任务', workflowId, projectId: seeded.projectId },
  )
  expect(created.value).toBeTruthy()

  // 调度器领取 → 真实 spawn → 回执块判定 → 任务落到「收尾」阶段
  await expect
    .poll(
      () =>
        readAgentState(seeded.dbPath).tasks.find(
          (task) => task.currentStageId === seeded.stageIds[1],
        )?.currentStageId ?? null,
      { timeout: 90_000 },
    )
    .toBe(seeded.stageIds[1])

  const state = readAgentState(seeded.dbPath)
  const task = state.tasks[0]
  expect(task.status).toBe('active')
  // 一次通过：预算没消耗，也没有「闸门放行」的降级标签
  expect(task.gateFails).toBe(0)
  expect(task.labels).not.toContain('gate:degraded')

  const stageRun = state.runs.find((run) => run.purpose === 'stage')
  expect(stageRun?.status).toBe('succeeded')
  expect(stageRun?.error ?? null).toBeNull()
  expect(stageRun?.output).toContain(FAKE_AGENT_MARKER)

  // 经桥复查：看板读到的任务确实在「收尾」阶段（不只是库里改了行）
  const tasks = await page.evaluate((projectId) => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.query('tasks.byProject', { projectId })
  }, seeded.projectId)
  expect(tasks).toHaveLength(1)
  expect(tasks[0].currentStageId).toBe(seeded.stageIds[1])
  expect(tasks[0].status).toBe('active')
})
