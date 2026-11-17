/**
 * M41 新建任务 E2E：任务像 issue，建的时候就能指定投给哪条工作流。
 *
 * 断言两条链路：
 * 1. UI —— 弹窗里换工作流后起始阶段跟着换、创建后侧栏自动切到那条流程（否则卡片不出现，
 *    人只会当成没建成）、别的流程的看板上看不到这张卡；
 * 2. 落库 —— `tasks.workflow_id` / `current_stage_id` 真的是选中的那条流程与那一列。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readTaskPlacement, seedTwoWorkflows } from './helpers/seed-two-workflows'

let launched: LaunchedApp | undefined
let page: Page

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
})

test('新建任务时可以换工作流：阶段跟着换、建成后看板跟着切、卡片落在选中的流程', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  const seed = await seedTwoWorkflows(path.join(userDataDir, 'ai-workflow.db'))
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  await page.getByRole('button', { name: 'AI 工作流' }).click()

  // 先到「交付流程」的看板：默认选中项由视图顺序决定，不靠假设，显式切一次
  const switcher = page.getByRole('combobox', { name: '选择工作流' })
  await switcher.click()
  await page.getByRole('option', { name: seed.firstWorkflowName }).click()
  await expect(
    page.getByRole('heading', { name: new RegExp(`工作流「${seed.firstWorkflowName}」`) }),
  ).toBeVisible()

  // 弹窗默认停在同一工作流；换一条后起始阶段回落到新工作流的首阶段（内置「待办」）
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const inDialogWorkflow = dialog.getByRole('combobox', { name: '所属工作流' })
  const inDialogStage = dialog.getByRole('combobox', { name: '起始阶段' })
  await expect(inDialogWorkflow).toContainText(seed.firstWorkflowName)
  await expect(inDialogStage).toContainText('待办')

  await dialog.getByLabel('任务标题').fill('投给缺陷流程的任务')
  await inDialogWorkflow.click()
  await page.getByRole('option', { name: seed.secondWorkflowName }).click()
  await expect(inDialogWorkflow).toContainText(seed.secondWorkflowName)
  await expect(inDialogStage).toContainText('待办')

  // 起始阶段照样可以选中间那一列——弹窗现在是「从指定的阶段起卡」的唯一入口
  await inDialogStage.click()
  await page.getByRole('option', { name: seed.secondUserStageName }).click()
  await expect(inDialogStage).toContainText(seed.secondUserStageName)
  await dialog.getByLabel('任务描述').fill('背景：登录页偶发白屏')
  await dialog.getByRole('button', { name: '创建' }).click()

  await expect(dialog).toBeHidden()
  // 建成后看板自动切到任务所属的工作流：不切就看不到刚建的卡
  await expect(
    page.getByRole('heading', { name: new RegExp(`工作流「${seed.secondWorkflowName}」`) }),
  ).toBeVisible()
  const card = page.getByRole('button', { name: '任务：投给缺陷流程的任务' })
  await expect(card).toBeVisible()
  // 卡片在选中的那一列里，不是首列
  const stage = page.getByRole('group', { name: `阶段：${seed.secondUserStageName}` })
  await expect(stage.getByRole('button', { name: '任务：投给缺陷流程的任务' })).toBeVisible()

  // 切回第一条流程：这张卡不该出现在别人的看板上
  await switcher.click()
  await page.getByRole('option', { name: seed.firstWorkflowName }).click()
  await expect(
    page.getByRole('heading', { name: new RegExp(`工作流「${seed.firstWorkflowName}」`) }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '任务：投给缺陷流程的任务' })).toBeHidden()

  // 落库口径：工作流与起始阶段都是弹窗里选的那一对
  expect(readTaskPlacement(seed.dbPath, '投给缺陷流程的任务')).toEqual({
    workflowName: seed.secondWorkflowName,
    stageName: seed.secondUserStageName,
    description: '背景：登录页偶发白屏',
  })
})
