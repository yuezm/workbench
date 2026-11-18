/**
 * 派单 E2E（M29 取代 M7 交接两列；M50 话题统一）：真实应用里完成任务 → 目标工作流出现关联工单。
 *
 * 种子（`helpers/seed-handoff.ts`）建 A（首阶段配一条 `manual` 派单到 B）与 B，并在 A 首阶段建源任务；
 * 之后经桥 `task.complete`，断言：
 * - B 出现一条 `origin='handoff'` 的任务，`handoff_from_task_id` / `handoff_from_stage_id` 指向源；
 * - **M50**：缺省话题策略是 `inherit` —— 派单卡落在**源任务同一条话题**里（`threads.source` 仍是
 *   创建任务时的 `manual`，话题内 2 张卡）；显式 `thread='new'` 才另开 `source='handoff'` 的新话题；
 * - 源任务变 `completed`；同一 `commandId` 重放（连点 / 重试）不重复建——命令幂等，
 *   这是 M29/M30 下仍然成立的去重口径：人工离开不按 `(任务, 阶段)` 去重（SPEC 派单一节：
 *   「人工拖动 / 完成任务没有 run，不去重」），重复提交由 `commands` 表按 `commandId` 回放。
 *
 * 断言一律读临时 userData 里的库文件，不依赖真 CLI、不动真实 %APPDATA%。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { WorkbenchApi } from '@workbench/contract-api'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readHandoffState, seedHandoffBase, type HandoffSeed } from './helpers/seed-handoff'

let launched: LaunchedApp | undefined
let page: Page
let seed: HandoffSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('跨工作流派单：完成阶段在目标工作流建关联工单（同话题），同一命令重放不重复建', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedHandoffBase(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = seed
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')
  await page.getByRole('button', { name: 'AI 工作流' }).click()

  // 1) 源任务当前在 A 的首阶段：完成它 → 触发交接
  await page.evaluate(
    ({ taskId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({ type: 'task.complete', commandId: 'e2e-handoff-1', id: taskId })
    },
    { taskId: seeded.sourceTaskId },
  )

  await expect
    .poll(() => readHandoffState(seeded.dbPath, seeded), { timeout: 15_000 })
    .toMatchObject({
      targetTaskCount: 1,
      origin: 'handoff',
      handoffFromTaskId: seeded.sourceTaskId,
      handoffFromStageId: seeded.sourceStageId,
      handoffFromRunId: null,
      stageFails: 0,
      title: seeded.sourceTitle,
      // M50：派单卡与源任务同一条话题，话题内两张卡；来源仍记在任务列上
      threadId: seeded.sourceThreadId,
      threadSource: 'manual',
      threadTaskCount: 2,
      sourceStatus: 'completed',
      taskCreatedFacts: 2,
    })

  // 2) 同一 commandId 重放（连点「完成任务」/ 请求重试）：命令幂等，不重复建工单
  await page.evaluate(
    ({ taskId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({ type: 'task.complete', commandId: 'e2e-handoff-1', id: taskId })
    },
    { taskId: seeded.sourceTaskId },
  )

  expect(readHandoffState(seeded.dbPath, seeded)).toMatchObject({
    targetTaskCount: 1,
    taskCreatedFacts: 2,
  })
})

test('派单显式 thread=new：另开 source=handoff 的话题（独立事项口径保留）', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedHandoffBase(path.join(userDataDir, 'ai-workflow.db'), { thread: 'new' })
  const seeded = seed
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')
  await page.getByRole('button', { name: 'AI 工作流' }).click()

  await page.evaluate(
    ({ taskId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({ type: 'task.complete', commandId: 'e2e-handoff-new', id: taskId })
    },
    { taskId: seeded.sourceTaskId },
  )

  await expect
    .poll(() => readHandoffState(seeded.dbPath, seeded), { timeout: 15_000 })
    .toMatchObject({
      targetTaskCount: 1,
      origin: 'handoff',
      threadSource: 'handoff',
      threadTaskCount: 1,
      sourceStatus: 'completed',
    })

  const state = readHandoffState(seeded.dbPath, seeded)
  expect(state.threadId).not.toBe(seeded.sourceThreadId)
})
