/**
 * M7.5 任务上下文 / 反馈 E2E：任务详情页像 issue 一样补反馈 → 事实 / 投影 / 视图整条链路。
 *
 * 种子复用规则 E2E 的基座（运行时停用）：首阶段是 agent 入口，建任务时入队一条 run
 * 但不会真的执行，所以详情页稳定停在「排队中」，反馈只记上下文、不排第二轮。
 */
import { expect, test, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRulesBase } from './helpers/seed-rules'

let launched: LaunchedApp | undefined
let page: Page

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
})

/** 只读复查：反馈行与相关事实数（应用运行中也可读，WAL + busy_timeout）。 */
function readCommentState(dbPath: string): {
  comments: Array<{ task_id: string; author: string; text: string }>
  commentFacts: number
  runs: number
} {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const comments = db
      .prepare('SELECT task_id, author, text FROM task_comments ORDER BY created_at, rowid')
      .all() as Array<{ task_id: string; author: string; text: string }>
    const count = (type: string): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM facts WHERE type = ?').get(type) as { n: number }).n
    return {
      comments,
      commentFacts: count('task.comment_added'),
      runs: (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n,
    }
  } finally {
    db.close()
  }
}

test('任务详情页：补一条反馈，上下文与运行记录一起展示', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  const seed = await seedRulesBase(path.join(userDataDir, 'ai-workflow.db'))
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 1) 建任务（首阶段 agent：入队一条 run，运行时停用所以不会执行）
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByLabel('任务标题').fill('e2e 反馈任务')
  // M18：默认落内置「待办」（不派活），要进 agent 阶段得显式选
  await page.getByLabel('起始阶段').click()
  await page.getByRole('option', { name: '执行' }).click()
  await page.getByRole('button', { name: '创建' }).click()
  await expect(page.getByText('e2e 反馈任务', { exact: true })).toBeVisible()

  // 2) 进任务详情页：上下文里有本轮运行
  await page.getByLabel('任务：e2e 反馈任务').click()
  const detail = page.getByRole('region', { name: '任务详情' })
  await expect(detail).toBeVisible()
  const context = detail.getByRole('region', { name: '上下文' })
  await expect(context).toBeVisible()
  await expect(context.getByText('排队中')).toBeVisible()
  await expect(context).toContainText('运行 1')
  await expect(context).toContainText('反馈 0')

  // 3) 写反馈：任务停在 agent 阶段，勾选框可用（有活跃 run 时内核只记上下文）
  const form = detail.getByRole('form', { name: '添加反馈' })
  await expect(form.getByRole('checkbox', { name: '同时让智能体接着做' })).toBeChecked()
  await form.getByLabel('反馈内容').fill('按钮颜色改成粉色')
  await form.getByRole('button', { name: '发送反馈' }).click()

  // 4) 反馈进上下文活动流，输入清空
  await expect(context.getByText('按钮颜色改成粉色')).toBeVisible()
  await expect(context).toContainText('反馈 1')
  await expect(form.getByLabel('反馈内容')).toHaveValue('')

  // 5) 事实与投影落库：一条 task.comment_added、一行 task_comments，未多排 run
  await expect
    .poll(() => readCommentState(seed.dbPath), { timeout: 15_000 })
    .toMatchObject({
      commentFacts: 1,
      comments: [{ author: 'owner', text: '按钮颜色改成粉色' }],
      runs: 1,
    })

  // 6) 返回看板
  await page.getByRole('button', { name: '返回' }).click()
  await expect(detail).toBeHidden()
  await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible()
})
