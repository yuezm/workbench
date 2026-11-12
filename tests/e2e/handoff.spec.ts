/**
 * M7 跨工作流交接 E2E：真实应用里完成任务 → 目标工作流出现关联任务。
 *
 * 种子（`helpers/seed-handoff.ts`）建 A（首阶段交接目标 = B）与 B，并在 A 首阶段建源任务；
 * 之后经桥 `task.complete`，断言：
 * - B 出现一条 `origin='handoff'` 的任务，`handoff_from_task_id` / `handoff_from_stage_id` 指向源；
 * - 该任务挂新隐式线程（`threads.source='handoff'`）；
 * - 源任务变 `completed`；重复完成任务不重复建（同一 (任务, 阶段) 只交接一次）。
 *
 * 断言一律读临时 userData 里的库文件，不依赖真 CLI、不动真实 %APPDATA%。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { WorkbenchApi } from '../../src/shared/workbench-api'
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

test('跨工作流交接：完成阶段在目标工作流建关联任务，重复完成不重复建', async () => {
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
      title: seeded.sourceTitle,
      threadSource: 'handoff',
      sourceStatus: 'completed',
      taskCreatedFacts: 2,
    })

  // 2) 再完成一次（源任务已完成 / 同 (任务, 阶段) 已交接）：不重复建任务
  await page.evaluate(
    ({ taskId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({ type: 'task.complete', commandId: 'e2e-handoff-2', id: taskId })
    },
    { taskId: seeded.sourceTaskId },
  )

  expect(readHandoffState(seeded.dbPath, seeded)).toMatchObject({
    targetTaskCount: 1,
    taskCreatedFacts: 2,
  })
})
