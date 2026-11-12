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

test('顶部栏顺序：AI 工作流在番茄时钟前面', async () => {
  const nav = page.getByRole('navigation', { name: '应用导航' })
  await expect(nav).toBeVisible()
  const buttons = nav.getByRole('button')
  await expect(buttons).toHaveCount(2)
  const names = await buttons.allTextContents()
  expect(names.map((n) => n.trim())).toEqual(['AI 工作流', '番茄时钟'])
})

test('默认打开第一个注册的 app：AI 工作流工作台', async () => {
  // 工作台默认栏目是任务（看板），聊天是针对需进入的第二个栏目
  await expect(page.getByRole('button', { name: '任务', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('combobox', { name: '选择工作流' })).toBeVisible()
})

test('切到番茄时钟：idle 25:00 专注', async () => {
  await page.getByRole('button', { name: '番茄时钟' }).click()
  await expect(page.getByText('25:00', { exact: true })).toBeVisible()
  await expect(page.getByText('专注', { exact: true })).toBeVisible()
})
