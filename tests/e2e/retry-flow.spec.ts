/**
 * 核心流程 E2E：**执行失败 → 原地重跑 → 闸门通过 → 任务推进**。
 *
 * 既有 `gate-execution.spec.ts` 只走「一次成功」；真实使用里更常见的是执行器先崩一次
 * （CLI 挂了 / 超时 / 关机），必须能停在原地等重跑，而不是把任务打飞到别的列。
 *
 * 种子：两阶段工作流（`干活` agent+闸门 → `收尾` none）+ 走 `command` 执行器的假智能体；
 * 假智能体第 1 轮退出码 1，第 2 轮退出码 0 并带回 `verdict=pass` 的回执块。
 *
 * 断言：
 * 1. 第 1 轮失败：run 终态 `failed`、输出含失败标记、任务仍在 `干活`；
 * 2. `task.rerun` 原地再排一轮（不是拖走再拖回）：第 2 轮 `succeeded`、输出含成功标记；
 * 3. 闸门判定通过后任务落到 `收尾`，看板同步（不只库里改了行）。
 * 计数器落在假智能体自己的 `attempts.txt` 里，证明真的是两次独立执行。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { WorkbenchApi } from '@workbench/contract-api'
import { FLAKY_FAIL_MARKER, FLAKY_OK_MARKER, writeFlakyAgent } from './helpers/flaky-agent'
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

test('失败 → 原地重跑 → 闸门通过：任务停在原阶段等重跑，成功后推进到下一阶段', async () => {
  test.setTimeout(240_000)

  const userDataDir = createTempUserDataDir()
  const workDir = path.join(userDataDir, 'work')
  mkdirSync(workDir, { recursive: true })

  // 第 1 轮失败、第 2 轮成功；成功轮带回闸门判定
  const command = writeFlakyAgent(userDataDir, {
    failTimes: 1,
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
  if (workflowId === null) throw new Error('重跑种子：工作流没建出来')
  expect(seeded.stageIds).toHaveLength(2)

  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  const taskTitle = 'e2e 失败重跑任务'
  await page.evaluate(
    (input) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({ type: 'task.create', commandId: 'e2e-retry-task', input })
    },
    { title: taskTitle, workflowId, projectId: seeded.projectId, stageId: seeded.stageIds[0] },
  )

  // 1) 第 1 轮：真 spawn → 退出码 1 → run 终态 failed，任务留在「干活」
  await expect.poll(() => readAgentState(seeded.dbPath).runs.length, { timeout: 90_000 }).toBe(1)
  await expect
    .poll(
      () => {
        const state = readAgentState(seeded.dbPath)
        return {
          status: state.runs[0]?.status ?? null,
          stage: state.tasks[0]?.currentStageId ?? null,
        }
      },
      { timeout: 90_000 },
    )
    .toEqual({ status: 'failed', stage: seeded.stageIds[0] })

  const failedState = readAgentState(seeded.dbPath)
  expect(failedState.runs[0]?.output).toContain(FLAKY_FAIL_MARKER)
  expect(failedState.runs[0]?.error ?? '').not.toBe('')
  // 失败不是业务上没过：闸门预算没消耗、任务没被标成降级
  expect(failedState.tasks[0]?.gateFailsByStage).toEqual({})
  expect(failedState.tasks[0]?.labels).not.toContain('gate:degraded')
  expect(readFileSync(path.join(userDataDir, 'attempts.txt'), 'utf8').trim()).toBe('1')

  // 2) 原地重跑（run 失败收口后的正规入口，不是把卡片拖走再拖回）
  const taskId = failedState.tasks[0]?.id as string
  await page.evaluate((id) => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.dispatch({ type: 'task.rerun', commandId: 'e2e-retry-rerun', id })
  }, taskId)

  // 3) 第 2 轮：成功 + 回执块 → 闸门通过 → 任务进「收尾」
  await expect
    .poll(
      () => {
        const state = readAgentState(seeded.dbPath)
        return {
          runs: state.runs.length,
          last: state.runs[state.runs.length - 1]?.status ?? null,
          stage: state.tasks[0]?.currentStageId ?? null,
        }
      },
      { timeout: 120_000 },
    )
    .toEqual({ runs: 2, last: 'succeeded', stage: seeded.stageIds[1] })

  const settled = readAgentState(seeded.dbPath)
  expect(settled.runs[1]?.output).toContain(FLAKY_OK_MARKER)
  expect(settled.runs[1]?.error ?? null).toBeNull()
  expect(readFileSync(path.join(userDataDir, 'attempts.txt'), 'utf8').trim()).toBe('2')

  // 看板同步：切到本条工作流后，卡片真的在「收尾」列
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  // 应用可能停在任务详情（上一轮点开过）：先退回看板
  const back = page.getByRole('button', { name: '返回', exact: true })
  if (await back.isVisible().catch(() => false)) await back.click()
  const switcher = page.getByRole('combobox', { name: '选择工作流' })
  await switcher.click()
  await page.getByRole('option', { name: 'e2e 执行流程' }).click()
  const stageGroup = page.getByRole('group', { name: '阶段：收尾' })
  await expect(stageGroup.getByRole('button', { name: `任务：${taskTitle}` })).toBeVisible({
    timeout: 30_000,
  })

  // 经桥复查：看板读到的任务确实在收尾阶段（不只是库里改了行）
  const tasks = await page.evaluate((projectId) => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.query('tasks.byProject', { projectId })
  }, seeded.projectId)
  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.currentStageId).toBe(seeded.stageIds[1])
})
