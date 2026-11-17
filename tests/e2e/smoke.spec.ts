import { expect, test, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp
let page: Page

test.beforeEach(async () => {
  launched = await launchApp()
  page = launched.page
})

test.afterEach(async () => {
  await launched.close()
})

test('启动冒烟：窗口标题与顶部 app 标签栏就绪', async () => {
  expect(await page.title()).toBe('Workbench')
  const nav = page.getByRole('navigation', { name: '应用导航' })
  await expect(nav).toBeVisible()
  const item = nav.getByRole('button', { name: 'AI 工作流' })
  await expect(item).toBeVisible()
  await expect(item).toHaveAttribute('aria-current', 'page')
})

test('顶部栏只有一个 app：AI 工作流', async () => {
  const nav = page.getByRole('navigation', { name: '应用导航' })
  await expect(nav).toBeVisible()
  const buttons = nav.getByRole('button')
  await expect(buttons).toHaveCount(1)
  const names = await buttons.allTextContents()
  expect(names.map((n) => n.trim())).toEqual(['AI 工作流'])
})

test('默认打开第一个注册的 app：AI 工作流工作台', async () => {
  // 工作台只有任务一栏：侧栏是项目切换器 + 工作流切换器，没有栏目切换与聊天
  await expect(page.getByRole('region', { name: '项目列表' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '选择工作流' })).toBeVisible()
  await expect(page.getByRole('button', { name: '聊天', exact: true })).toHaveCount(0)
})
