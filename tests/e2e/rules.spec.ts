/**
 * M6 规则 E2E：设置页保存规则（`rules.replace`）→ `rules.all` 投影。
 *
 * 种子（`helpers/seed-rules.ts`）只种运行时/智能体/工作流并停用运行时；规则本身
 * 由 UI 新建保存，证明「表单 → 命令 → 事实 → `rules.all` 投影」整条链路。
 *
 * 事件命中规则建任务那半段由 `webhook.spec.ts` 覆盖（真实来源 + 带签名的 POST）：
 * 工作台不再有 app 插件事件（番茄时钟已移除），客户端没有可注入的伪事件入口，
 * 这里只验「人在界面上配的规则真的落了库」。
 *
 * 断言一律读临时 userData 里的库文件，不依赖真 CLI、不动真实 %APPDATA%。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { RuleSetView } from '@workbench/protocol/rules'
import type { WorkbenchApi } from '@workbench/contract-api'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRulesBase, type RulesSeed } from './helpers/seed-rules'

let launched: LaunchedApp | undefined
let page: Page
let seed: RulesSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('规则页：UI 保存规则 → rules.all 版本递增且内容是刚建的那条', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedRulesBase(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = seed
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 1) 设置 → 规则配置 → 新建规则（事件来源 webhook / issues.opened）
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '规则', exact: true }).click()
  await page.getByRole('button', { name: '新建规则' }).click()

  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('规则名称').fill('e2e 入口规则')
  await page.getByLabel('规则事件来源').fill('webhook')
  await page.getByLabel('规则事件类型').fill('issues.opened')
  await page.getByRole('combobox', { name: '规则目标工作流' }).click()
  await page.getByRole('option', { name: seeded.workflowName }).click()
  // M18：首阶段是内置「待办」（不派活），规则要选 agent 阶段才会入队一轮 run
  await page.getByRole('combobox', { name: '规则起始阶段' }).click()
  await page.getByRole('option', { name: '执行' }).click()
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByLabel('规则名称')).toBeHidden()

  // 2) rules.all：版本 1，且保存的是本条规则（证明走 rules.replace 落事实/投影）
  const ruleSet = (await page.evaluate(() => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.query('rules.all')
  })) as RuleSetView
  expect(ruleSet.version).toBe(1)
  expect(ruleSet.rules).toHaveLength(1)
  expect(ruleSet.rules[0]).toMatchObject({
    name: 'e2e 入口规则',
    enabled: true,
    when: { source: 'webhook', types: ['issues.opened'] },
    to: { workflowId: seeded.workflowId },
  })

  // 3) 库里确实落了这条规则（事实 → 投影同源，不是只在界面上显示）
  const reloaded = (await page.evaluate(() => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.query('rules.all')
  })) as RuleSetView
  expect(reloaded.rules.map((rule) => rule.id)).toEqual(ruleSet.rules.map((rule) => rule.id))

  // 4) 回到工作台：工作流切换器仍在，规则不该影响看板可用性
  await page.getByRole('button', { name: '返回工作台' }).click()
  await expect(page.getByRole('combobox', { name: '选择工作流' })).toBeVisible()
})
