/**
 * M6.5 线程 E2E：手工任务自动挂隐式线程 → 线程详情页补笔记 → 绑定外部入口 → 归档；
 * 断言覆盖「UI 命令 → 事实 → threads 投影 / thread.byId 视图」整条链路。
 *
 * 种子复用规则 E2E 的基座（运行时停用，任务进入 agent 阶段只入队不执行）；
 * 断言一律读临时 userData 里的库文件，不依赖真 CLI、不动真实 %APPDATA%。
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

interface ThreadState {
  threads: number
  threadSource: string | null
  threadRef: string | null
  threadStatus: string | null
  threadNotes: number
  taskThreadId: string | null
  openedFacts: number
  attachedFacts: number
  noteFacts: number
  boundFacts: number
  closedFacts: number
}

/** 只读复查（应用运行中也可读，WAL + busy_timeout）。 */
function readThreadState(dbPath: string): ThreadState {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const thread = db
      .prepare(
        'SELECT source, external_ref, status, notes_json FROM threads ORDER BY created_at LIMIT 1',
      )
      .get() as
      | { source: string; external_ref: string | null; status: string; notes_json: string }
      | undefined
    const count = (type: string): number =>
      (
        db.prepare('SELECT COUNT(*) AS n FROM facts WHERE type = ?').get(type) as {
          n: number
        }
      ).n
    const task = db.prepare('SELECT thread_id FROM tasks ORDER BY created_at LIMIT 1').get() as
      { thread_id: string | null } | undefined
    return {
      threads: (db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n,
      threadSource: thread?.source ?? null,
      threadRef: thread?.external_ref ?? null,
      threadStatus: thread?.status ?? null,
      threadNotes: thread === undefined ? 0 : (JSON.parse(thread.notes_json) as unknown[]).length,
      taskThreadId: task?.thread_id ?? null,
      openedFacts: count('thread.opened'),
      attachedFacts: count('thread.task_attached'),
      noteFacts: count('thread.note_appended'),
      boundFacts: count('thread.bound'),
      closedFacts: count('thread.closed'),
    }
  } finally {
    db.close()
  }
}

test('线程详情页：手工任务隐式线程 → 笔记 → 绑定入口 → 归档', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  const seed = await seedRulesBase(path.join(userDataDir, 'ai-workflow.db'))
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 1) 建手工任务：自动挂隐式线程（source=manual / externalRef=null）
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '任务' }).click()
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByLabel('任务标题').fill('e2e 线程任务')
  await page.getByRole('button', { name: '创建' }).click()
  await expect(page.getByText('e2e 线程任务', { exact: true })).toBeVisible()

  expect.soft(readThreadState(seed.dbPath)).toMatchObject({
    threads: 1,
    threadSource: 'manual',
    threadRef: null,
    threadStatus: 'open',
    openedFacts: 1,
    attachedFacts: 1,
  })

  // 2) 打开线程详情页（页面，不是弹窗）：未绑定、任务列表里有本任务
  await page.getByRole('button', { name: '打开线程：e2e 线程任务' }).click()
  const threadPage = page.getByRole('region', { name: '线程详情' })
  await expect(threadPage).toBeVisible()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(threadPage.getByText('未绑定')).toBeVisible()
  await expect(threadPage.getByRole('region', { name: '任务列表' })).toContainText('e2e 线程任务')

  // 3) 补一条笔记（thread.note）
  await threadPage.getByLabel('线程笔记').fill('先跑一遍 e2e 再提交')
  await threadPage.getByRole('button', { name: '添加笔记' }).click()
  await expect(threadPage.getByText('先跑一遍 e2e 再提交')).toBeVisible()

  // 4) 绑定外部入口（thread.bind）；绑定后表单收起、只读展示
  await threadPage.getByLabel('入口来源').fill('github')
  await threadPage.getByLabel('外部入口键').fill('issue-e2e')
  await threadPage.getByRole('button', { name: '绑定', exact: true }).click()
  await expect(threadPage.getByText('已绑定：')).toBeVisible()

  // 5) 归档（thread.close）
  await threadPage.getByRole('button', { name: '归档' }).click()
  await expect(threadPage.getByText('已归档', { exact: true })).toBeVisible()

  // 6) 页面导航：任务列表 → 任务详情页 → 返回线程 → Esc 回看板
  await threadPage.getByRole('button', { name: '打开任务：e2e 线程任务' }).click()
  const taskPage = page.getByRole('region', { name: '任务详情' })
  await expect(taskPage).toBeVisible()
  await expect(taskPage.getByRole('region', { name: '上下文' })).toBeVisible()
  await page.getByRole('button', { name: '返回' }).click()
  await expect(threadPage).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(threadPage).toBeHidden()
  await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible()

  await expect
    .poll(() => readThreadState(seed.dbPath), { timeout: 15_000 })
    .toMatchObject({
      threads: 1,
      threadSource: 'github',
      threadRef: 'issue-e2e',
      threadStatus: 'closed',
      threadNotes: 1,
      noteFacts: 1,
      boundFacts: 1,
      closedFacts: 1,
    })
  expect(readThreadState(seed.dbPath).taskThreadId).not.toBeNull()
})
