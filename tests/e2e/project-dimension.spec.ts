/**
 * 项目维度 E2E（M11「项目是聊天与任务共用的顶层上下文」）。
 *
 * 种子：两个项目各挂一个任务 + 只挂在项目甲的一个会话；工作流只有一个 `none` 阶段，
 * 所以不会派活、不会起进程（本用例只验证「切项目 → 清单跟着换」）。
 *
 * 覆盖：项目切换器常驻在栏目切换之上；切到项目甲 → 看板是甲的任务、会话清单有甲会话；
 * 切到项目乙 → 看板换成乙的任务、甲会话不在清单里；切回默认目录 → 两个任务都不在。
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { writeFakeAgent } from './helpers/fake-agent'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { seedProjectDimension, type ProjectSeed } from './helpers/seed-agent'

let launched: LaunchedApp | undefined
let page: Page
let seed: ProjectSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('项目维度：切项目 → 看板任务与会话清单一起换回本项目的', async () => {
  test.setTimeout(180_000)

  const userDataDir = createTempUserDataDir()
  const dirA = path.join(userDataDir, 'a')
  const dirB = path.join(userDataDir, 'b')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  const command = writeFakeAgent(userDataDir)

  seed = await seedProjectDimension(path.join(userDataDir, 'ai-workflow.db'), {
    command,
    dirA,
    dirB,
  })
  const seeded = seed

  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await expect(page.getByRole('heading', { name: 'AI 工作流' })).toBeVisible()

  // 项目切换器常驻在栏目切换之上
  await expect(page.getByRole('region', { name: '项目列表' })).toBeVisible()

  // 切到项目乙：看板是乙的任务；甲会话不在清单里（会话按项目过滤）
  await page.getByRole('button', { name: `项目：${seeded.projectB.name}` }).click()
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.getByText('乙任务')).toBeVisible()
  await expect(page.getByText('甲任务')).toHaveCount(0)
  await page.getByRole('button', { name: '聊天', exact: true }).click()
  await expect(page.getByRole('button', { name: /^甲会话/ })).toHaveCount(0)

  // 切到项目甲：看板换成甲的任务；甲会话出现在会话清单里
  await page.getByRole('button', { name: `项目：${seeded.projectA.name}` }).click()
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.getByText('甲任务')).toBeVisible()
  await expect(page.getByText('乙任务')).toHaveCount(0)
  await page.getByRole('button', { name: '聊天', exact: true }).click()
  // 会话清单里有甲会话，聊天区也把它的标题摆出来
  await expect(page.getByRole('button', { name: /^甲会话/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: '甲会话' })).toBeVisible()

  // 切回默认目录：两个项目的任务都不在（默认目录 = 没有项目文件夹）
  await page.getByRole('button', { name: '默认目录' }).click()
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.getByText('甲任务')).toHaveCount(0)
  await expect(page.getByText('乙任务')).toHaveCount(0)
})
