/**
 * 删任务后顶部通知条必须清空的回归（M55 停机卡）。
 *
 * 症状（2026-11-26 报告）：「把任务或者线程删掉了后，顶部通知栏无法关闭掉了，点了没反应，
 * 也删不掉」。根因不在投影：卡片行是随 `run.removed` 按 `run_id` 级联删掉的（库里确实没了）；
 * 问题在浏览器侧的失效表——`run.removed` / `task.removed` / `thread.removed` 都不失效
 * `cards.open`，于是通知条继续渲染一份已经不存在的卡片清单：点进去只有「任务不存在」，
 * 通知条上又没有关闭入口。
 *
 * 为什么用停机卡造现场：普通 ask / notice 卡在 run 落终态时会被 `closeCardsOnFinish` 收掉，
 * 删任务又先经取消流程顺手关卡，复现不出来。停机卡按设计留着（它问的是「你来不来接手」），
 * 才是「卡片行还在、任务已经没了」这条路上的真实样本。
 *
 * 为什么删任务走桥而不是点「删除任务」按钮：按钮那条路会切路由（详情 → 看板），通知条在
 * 切换的那一帧会整体卸载再挂回来——「已清空」和「没刷新」在断言点上重合，用例会假绿。
 * 桥发的就是按钮发的那条命令，界面这边只看通知条是否把卡片清掉。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { WorkbenchApi } from '@workbench/contract-api'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { countCards, seedStallState, type StallSeed } from './helpers/seed-stall'

let launched: LaunchedApp | undefined
let page: Page
let seed: StallSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('删任务：停机卡的行从通知条消失（库里同样没有残留）', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedStallState(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = seed
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 种子里静默哨兵已经开了卡：通知条列出来
  const bar = page.getByRole('region', { name: '待审批' })
  await expect(bar.getByRole('button', { name: /任务停机待接手：e2e 停机任务/ })).toBeVisible()

  // 删任务（它名下那一轮已落终态，不会先走取消流程再关卡）
  await page.evaluate(async (taskId) => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    await bridge.dispatch({ type: 'task.remove', commandId: 'e2e-stall-remove', id: taskId })
  }, seeded.taskId)

  // 通知条整块消失：留着一张点不动的条目就是这个 bug
  await expect(page.getByRole('region', { name: '待审批' })).toHaveCount(0)

  // 库里也一样：卡片行随 run 级联删掉（证明不是「界面刷新了但数据还在」）
  await expect.poll(() => countCards(seeded.dbPath), { timeout: 15_000 }).toBe(0)
})
