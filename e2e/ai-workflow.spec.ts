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

test('AI 工作流：侧边栏可进入，设置里左侧栏目切换各配置页且新建才弹表单', async () => {
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await expect(page.getByRole('heading', { name: 'AI 工作流' })).toBeVisible()

  // 工作台里看不到设置栏目
  await expect(page.getByRole('navigation', { name: '设置栏目' })).toBeHidden()

  // 打开设置：左侧二级栏目
  await page.getByRole('tab', { name: '设置' }).click()
  await expect(page.getByRole('navigation', { name: '设置栏目' })).toBeVisible()

  // 运行时配置
  await expect(page.getByText('运行时', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建运行时' })).toBeVisible()
  await expect(page.getByLabel('运行时名称')).toBeHidden()

  // 点「新建运行时」才弹出表单
  await page.getByRole('button', { name: '新建运行时' }).click()
  await expect(page.getByLabel('运行时名称')).toBeVisible()
  await expect(page.getByRole('button', { name: '添加运行时' })).toBeVisible()
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByLabel('运行时名称')).toBeHidden()

  // 智能体配置
  await page.getByRole('button', { name: '智能体配置' }).click()
  await expect(page.getByText('智能体', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '运行时' })).toBeHidden()

  // 工作流配置
  await page.getByRole('button', { name: '工作流配置' }).click()
  // exact：避免与顶栏「AI 工作流」标题一起命中
  await expect(page.getByRole('heading', { name: '工作流', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '智能体' })).toBeHidden()
})
