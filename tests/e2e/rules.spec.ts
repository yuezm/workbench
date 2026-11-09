/**
 * M6 规则 E2E：设置页保存规则（`rules.replace`）→ app 事件命中规则建任务。
 *
 * 种子（`helpers/seed-rules.ts`）只种运行时/智能体/工作流并停用运行时；规则本身
 * 由 UI 新建保存，证明「表单 → 命令 → 事实 → `rules.all` 投影」整条链路。
 * 随后经桥注入 `app.event`（pomodoro.completed，白名单内），断言：
 * - 看板出现规则任务，库里 `task.created{origin='rule', rule_id, external_ref}` + 一条 `run.queued`；
 * - 同 subject 的第二次事件不重复建任务（externalRef 去重）。
 *
 * 断言一律读临时 userData 里的库文件，不依赖真 CLI、不动真实 %APPDATA%。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { RuleSetView } from '../../src/protocol/rules'
import type { WorkbenchApi } from '../../src/shared/workbench-api'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readRuleTaskState, seedRulesBase, type RulesSeed } from './helpers/seed-rules'

let launched: LaunchedApp | undefined
let page: Page
let seed: RulesSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('规则页：UI 保存规则 → app 事件建任务，同 subject 不重复建', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedRulesBase(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = seed
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 1) 设置 → 规则配置 → 新建规则（事件来源 app / pomodoro.completed）
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '规则', exact: true }).click()
  await page.getByRole('button', { name: '新建规则' }).click()

  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('规则名称').fill('e2e 番茄规则')
  await page.getByLabel('规则事件来源').fill('app')
  await page.getByLabel('规则事件类型').fill('pomodoro.completed')
  await page.getByRole('combobox', { name: '规则目标工作流' }).click()
  await page.getByRole('option', { name: seeded.workflowName }).click()
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
    name: 'e2e 番茄规则',
    enabled: true,
    when: { source: 'app', types: ['pomodoro.completed'] },
    to: { workflowId: seeded.workflowId },
  })
  const ruleId = ruleSet.rules[0].id

  // 3) 注入 app 事件（pomodoro.completed 在 APP_EVENTS 白名单内）→ 规则建任务
  await page.evaluate(() => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.dispatch({
      type: 'app.event',
      commandId: 'e2e-rules-1',
      appId: 'pomodoro',
      eventType: 'pomodoro.completed',
      subject: 'e2e-番茄',
    })
  })

  await expect
    .poll(() => readRuleTaskState(seeded.dbPath, seeded.workflowId), { timeout: 15_000 })
    .toMatchObject({
      taskCount: 1,
      taskTitle: 'e2e-番茄',
      origin: 'rule',
      ruleId,
      externalRef: 'e2e-番茄',
      taskCreatedFacts: 1,
      queuedRuns: 1,
      runRuleId: ruleId,
    })

  // 4) 看板出现规则任务（任务栏 + 唯一工作流默认选中）
  await page.getByRole('button', { name: '返回工作台' }).click()
  await page.getByRole('button', { name: '任务' }).click()
  await expect(page.getByText('e2e-番茄', { exact: true })).toBeVisible()

  // 5) 同一 subject 再发一次：事件照常入账，但同规则 + 同 externalRef 不再建任务
  await page.evaluate(() => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.dispatch({
      type: 'app.event',
      commandId: 'e2e-rules-2',
      appId: 'pomodoro',
      eventType: 'pomodoro.completed',
      subject: 'e2e-番茄',
    })
  })

  expect(readRuleTaskState(seeded.dbPath, seeded.workflowId)).toMatchObject({
    taskCount: 1,
    taskCreatedFacts: 1,
    queuedRuns: 1,
  })
  await expect(page.getByText('e2e-番茄', { exact: true })).toHaveCount(1)
})
