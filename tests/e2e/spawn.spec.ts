/**
 * M8 任务派生 E2E：真实应用里人工挂子任务 → 子任务完成 → 父任务 rollup 通知。
 *
 * 种子（`helpers/seed-spawn.ts`）建 two-stage 工作流与父任务；之后经桥：
 * 1. `task.create` 带 `parentTaskId` → 子任务继承父线程、`parent_task_id` 指向父；
 * 2. `query('tasks.byParent')` 能取到该子任务；
 * 3. `task.complete` 子任务 → 父任务收到 rollup 通知（`none` 阶段降级为任务评论）。
 *
 * 断言一律读临时 userData 里的库文件，不依赖真 CLI、不动真实 %APPDATA%。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { WorkbenchApi } from '../../src/shared/workbench-api'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readSpawnState, seedSpawnBase, type SpawnSeed } from './helpers/seed-spawn'

let launched: LaunchedApp | undefined
let page: Page
let seed: SpawnSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('任务派生：人工挂子任务继承父线程，子任务完成后父任务收到 rollup 通知', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedSpawnBase(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = seed
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')
  await page.getByRole('button', { name: 'AI 工作流' }).click()

  // 1) 人工挂子任务
  await page.evaluate(
    ({ workflowId, parentTaskId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({
        type: 'task.create',
        commandId: 'e2e-spawn-child',
        input: {
          title: 'e2e 子任务',
          workflowId,
          parentTaskId,
        },
      })
    },
    { workflowId: seeded.workflowId, parentTaskId: seeded.parentTaskId },
  )

  await expect
    .poll(() => readSpawnState(seeded.dbPath, seeded), { timeout: 15_000 })
    .toMatchObject({
      childCount: 1,
      childParentId: seeded.parentTaskId,
      childThreadId: seeded.parentThreadId,
      childOrigin: 'manual',
    })

  // 2) tasks.byParent 视图能取到子任务
  const child = await page.evaluate(
    async ({ parentTaskId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      const children = await bridge.query('tasks.byParent', { taskId: parentTaskId })
      return children[0] ?? null
    },
    { parentTaskId: seeded.parentTaskId },
  )
  expect(child).not.toBeNull()

  // 3) 完成子任务 → 父任务 rollup 通知（评论）
  await page.evaluate(
    ({ childId }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({ type: 'task.complete', commandId: 'e2e-spawn-done', id: childId })
    },
    { childId: child?.id as string },
  )

  await expect
    .poll(() => readSpawnState(seeded.dbPath, seeded), { timeout: 15_000 })
    .toMatchObject({ childCount: 1 })
  const state = readSpawnState(seeded.dbPath, seeded)
  expect(state.parentComment).toContain('子任务已全部结束')
})
