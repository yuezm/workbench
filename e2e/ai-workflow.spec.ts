import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

let electronApp: ElectronApplication
let page: Page

test.beforeEach(async () => {
  electronApp = await electron.launch({ args: ['.'] })
  page = await electronApp.firstWindow()
})

test.afterEach(async () => {
  await electronApp.close()
})

test('AI 工作流：侧边栏可进入，管理区在设置视图渲染', async () => {
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await expect(page.getByRole('heading', { name: 'AI 工作流' })).toBeVisible()
  await page.getByRole('tab', { name: '设置' }).click()
  await expect(page.getByText('运行时', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '添加运行时' })).toBeVisible()
  await expect(page.getByText('智能体', { exact: true })).toBeVisible()
})
