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

test('AI 工作流：顶部标签可进入，单列侧栏切换栏目，设置里各配置页且新建才弹表单', async () => {
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await expect(page.getByRole('heading', { name: 'AI 工作流' })).toBeVisible()

  // 工作台默认落在聊天栏：侧栏顶部是聊天/任务切换条 + 会话清单；设置栏目不可见
  await expect(page.getByRole('navigation', { name: '工作台栏目' })).toBeVisible()
  await expect(page.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: '新对话' })).toBeVisible()
  await expect(page.getByLabel('消息输入')).toBeVisible()
  await expect(page.getByRole('navigation', { name: '设置栏目' })).toBeHidden()

  // 切到任务栏：侧栏换成工作流切换器，内容区看板运行记录就位
  await page.getByRole('button', { name: '任务' }).click()
  await expect(page.getByRole('combobox', { name: '选择任务查看运行' })).toBeVisible()
  await expect(page.getByLabel('消息输入')).toBeHidden()

  // 侧栏底部切到设置：设置栏目
  await page.getByRole('tab', { name: '设置' }).click()
  await expect(page.getByRole('navigation', { name: '设置栏目' })).toBeVisible()

  // 运行时配置
  await expect(page.getByRole('heading', { name: '运行时', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建运行时' })).toBeVisible()
  await expect(page.getByLabel('运行时名称')).toBeHidden()

  // 点「新建运行时」才弹出表单
  await page.getByRole('button', { name: '新建运行时' }).click()
  await expect(page.getByLabel('运行时名称')).toBeVisible()
  await expect(page.getByRole('button', { name: '添加' })).toBeVisible()
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByLabel('运行时名称')).toBeHidden()

  // 智能体配置
  await page.getByRole('button', { name: '智能体', exact: true }).click()
  await expect(page.getByRole('heading', { name: '智能体', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '运行时' })).toBeHidden()

  // 工作流配置
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  // exact：栏目标题「工作流」与其它含「工作流」的文案区分开
  await expect(page.getByRole('heading', { name: '工作流', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '智能体' })).toBeHidden()
})
