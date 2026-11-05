/**
 * M2 崩溃恢复 E2E（refactor-plan 验收三件事）：
 *
 * 1. 上次崩溃残留的子进程在启动对账时被强杀；
 * 2. 超租约的 running run 由 `clock.tick` 回收（落 `failed{executor_lost}`），不再锁住任务；
 * 3. 恢复后任务可以正常拖动，重启一次投影仍一致（无残留 running / 登记行）。
 *
 * 种子库用真实 `openDatabase` + `createStore`（真实 kernel）在临时 userData 里预置，
 * 应用启动后走与生产完全相同的对账 / 调度路径。
 */
import { expect, test, type Page } from '@playwright/test'
import type { WorkbenchApi } from '../../src/shared/workbench-api'
import path from 'node:path'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { isPidAlive, readRecoveryState, seedCrashState, type CrashSeed } from './helpers/seed-crash'

let launched: LaunchedApp | undefined
let crash: CrashSeed | undefined
let page: Page

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  crash?.cleanup()
  crash = undefined
})

test('崩溃恢复：对账强杀残留进程、回收租约、任务可拖动、重启后投影一致', async () => {
  // Windows 句柄释放较慢，给两次启动留足余量
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  crash = await seedCrashState(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = crash
  // 种子阶段确实留下了一个活着的子进程（对账才有东西可杀）
  expect(isPidAlive(seeded.pid)).toBe(true)

  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 启动对账：先按登记 pid 强杀残留进程树
  await expect.poll(() => isPidAlive(seeded.pid), { timeout: 15_000 }).toBe(false)
  // clock.tick 把超租约 running 回收成 failed（重试已到上限，不再回 queued）
  await expect
    .poll(() => readRecoveryState(seeded.dbPath, seeded.runId), { timeout: 15_000 })
    .toMatchObject({ runStatus: 'failed', runningRuns: 0, registryRows: 0 })

  // 任务不再被判「执行中」：经三动词桥 dispatch task.move 应成功
  const moved = await page.evaluate(
    async ({ taskId, stageId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      const result = await bridge.dispatch({
        type: 'task.move',
        commandId: 'e2e-move',
        id: taskId,
        stageId,
      })
      return result.value as { id: string; currentStageId: string }
    },
    { taskId: seeded.taskId, stageId: seeded.targetStageId },
  )
  expect(moved.id).toBe(seeded.taskId)
  expect(moved.currentStageId).toBe(seeded.targetStageId)
  expect(readRecoveryState(seeded.dbPath, seeded.runId).runningRuns).toBe(0)

  // 同一份 userData 重启：启动正常，投影里不再有残留 running 与进程登记行
  await launched.close({ removeUserData: false })
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')
  await expect
    .poll(() => readRecoveryState(seeded.dbPath, seeded.runId), { timeout: 15_000 })
    .toMatchObject({ runStatus: 'failed', runningRuns: 0, registryRows: 0 })
})
