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
  const item = nav.getByRole('button', { name: '番茄时钟' })
  await expect(item).toBeVisible()
  await expect(item).toHaveAttribute('aria-current', 'page')
})

test('默认打开第一个注册的 app：番茄时钟 idle 25:00', async () => {
  await expect(page.getByText('25:00', { exact: true })).toBeVisible()
  await expect(page.getByText('专注', { exact: true })).toBeVisible()
})
