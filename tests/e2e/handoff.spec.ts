/**
 * 派单 E2E（M29 取代 M7 交接两列；M50 话题统一；M53 完成与归档分离）：真实应用里把源任务
 * 移到内置「已完成」→ 目标工作流出现关联工单。
 *
 * 种子（`helpers/seed-handoff.ts`）建 A（首阶段配一条 `manual` 派单到 B）与 B，并在 A 首阶段建源任务；
 * 之后经桥 `task.move` 到 A 的内置「已完成」，断言：
 * - B 出现一条 `origin='handoff'` 的任务，`handoff_from_task_id` / `handoff_from_stage_id` 指向源；
 * - **M50**：缺省话题策略是 `inherit` —— 派单卡落在**源任务同一条话题**里（`threads.source` 仍是
 *   创建任务时的 `manual`，话题内 2 张卡）；显式 `thread='new'` 才另开 `source='handoff'` 的新话题；
 * - 源任务停在「已完成」阶段且**未被归档**（M53：完成与归档是两条轴，完成不顺手收纳）；
 *   同一 `commandId` 重放（连点 / 重试）不重复建——命令幂等，
 *   这是 M29/M30 下仍然成立的去重口径：人工离开不按 `(任务, 阶段)` 去重（SPEC 派单一节：
 *   「人工拖动 / 移到终态列没有 run，不去重」），重复提交由 `commands` 表按 `commandId` 回放。
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

  // 1) 源任务当前在 A 的首阶段：把它移到内置「已完成」→ 触发派单
  await page.evaluate(
    ({ taskId, doneStageId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({
        type: 'task.move',
        commandId: 'e2e-handoff-1',
        id: taskId,
        stageId: doneStageId,
      })
    },
    { taskId: seeded.sourceTaskId, doneStageId: seeded.sourceDoneStageId },
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
      // M53：完成 = 停在「已完成」阶段；归档是另一条轴，这次没动
      sourceStageId: seeded.sourceDoneStageId,
      sourceArchived: false,
      taskCreatedFacts: 2,
    })

  // 2) 同一 commandId 重放（连点「移到已完成」/ 请求重试）：命令幂等，不重复建工单
  await page.evaluate(
    ({ taskId, doneStageId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({
        type: 'task.move',
        commandId: 'e2e-handoff-1',
        id: taskId,
        stageId: doneStageId,
      })
    },
    { taskId: seeded.sourceTaskId, doneStageId: seeded.sourceDoneStageId },
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
    ({ taskId, doneStageId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({
        type: 'task.move',
        commandId: 'e2e-handoff-new',
        id: taskId,
        stageId: doneStageId,
      })
    },
    { taskId: seeded.sourceTaskId, doneStageId: seeded.sourceDoneStageId },
  )

  await expect
    .poll(() => readHandoffState(seeded.dbPath, seeded), { timeout: 15_000 })
    .toMatchObject({
      targetTaskCount: 1,
      origin: 'handoff',
      threadSource: 'handoff',
      threadTaskCount: 1,
      sourceStageId: seeded.sourceDoneStageId,
      sourceArchived: false,
    })

  const state = readHandoffState(seeded.dbPath, seeded)
  expect(state.threadId).not.toBe(seeded.sourceThreadId)
})
