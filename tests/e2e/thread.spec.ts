/**
 * M6.5 线程 E2E：手工任务自动挂隐式线程 → 线程详情页补笔记 → 绑定外部入口 → 归档；
 * 断言覆盖「UI 命令 → 事实 → threads 投影 / thread.byId 视图」整条链路。
 *
 * 种子复用规则 E2E 的基座（运行时停用，任务进入 agent 阶段只入队不执行）；
 * 断言一律读临时 userData 里的库文件，不依赖真 CLI、不动真实 %APPDATA%。
 */
import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
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
  await page.getByRole('button', { name: '任务', exact: true }).click()
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

/** 该线程相关的行数（删除后应为 0）。 */
function countBy(dbPath: string, table: string, column: string, value: string): number {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
        n: number
      }
    ).n
  } finally {
    db.close()
  }
}

/** 库里第一条线程 id（本用例只建了一条）。 */
function findThreadId(dbPath: string): string | null {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('SELECT id FROM threads ORDER BY created_at LIMIT 1').get() as
      { id: string } | undefined
    return row?.id ?? null
  } finally {
    db.close()
  }
}

test('删除线程：连带任务与执行记录一起清掉，并回到看板；归档条在看板底部', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  const seed = await seedRulesBase(path.join(userDataDir, 'ai-workflow.db'))
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '任务', exact: true }).click()

  // 布局：归档条压在阶段列下方，比单列宽（横排一条，不再挤占列宽）
  const archive = page.getByRole('group', { name: '归档区' })
  const stageColumn = page.getByRole('group', { name: /^阶段：/ }).first()
  const archiveBox = (await archive.boundingBox()) as {
    x: number
    y: number
    width: number
    height: number
  }
  const stageBox = (await stageColumn.boundingBox()) as {
    x: number
    y: number
    width: number
    height: number
  }
  expect(archiveBox.y).toBeGreaterThanOrEqual(stageBox.y + stageBox.height - 1)
  expect(archiveBox.width).toBeGreaterThan(stageBox.width)

  // 建任务：起始阶段选「待办」（entryMode=none，不产 run），线程与任务各一条
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByLabel('任务标题').fill('e2e 待删任务')
  await page.getByLabel('起始阶段').click()
  await page.getByRole('option', { name: '待办' }).click()
  await page.getByRole('button', { name: '创建' }).click()
  await expect(page.getByText('e2e 待删任务', { exact: true })).toBeVisible()

  const threadId = findThreadId(seed.dbPath)
  if (threadId === null) throw new Error('种子库里没有线程')

  // 删除线程：确认弹窗写明连带任务与执行记录，确认后直接出栈回看板
  await page.getByRole('button', { name: '打开线程：e2e 待删任务' }).click()
  const threadPage = page.getByRole('region', { name: '线程详情' })
  await expect(threadPage).toBeVisible()
  await threadPage.getByRole('button', { name: '删除线程' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('执行记录')
  await dialog.getByRole('button', { name: '删除' }).click()

  await expect(threadPage).toBeHidden()
  await expect(page.getByText('e2e 待删任务', { exact: true })).toHaveCount(0)

  await expect
    .poll(() => countBy(seed.dbPath, 'threads', 'id', threadId), { timeout: 15_000 })
    .toBe(0)
  expect(countBy(seed.dbPath, 'tasks', 'thread_id', threadId)).toBe(0)
  expect(countBy(seed.dbPath, 'runs', 'thread_id', threadId)).toBe(0)
  // 落盘的执行记录目录（index.md + runs/*）随线程一起消失
  expect(existsSync(path.join(userDataDir, 'artifacts', 'threads', threadId))).toBe(false)
})

test('看板列内快速新建：标题 + 描述落到该阶段，agent 列建完即带内容派活', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  const seed = await seedRulesBase(path.join(userDataDir, 'ai-workflow.db'))
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '任务', exact: true }).click()

  // 「待办」（entryMode=none）：标题 + 描述一起提交，描述里的 Enter 只换行
  const stage = page.getByRole('group', { name: '阶段：待办' })
  await stage.getByRole('button', { name: '在「待办」阶段添加任务' }).click()
  const input = stage.getByLabel('阶段「待办」的新任务标题')
  await expect(input).toBeFocused()
  await input.fill('列内任务一')
  await stage.getByLabel('阶段「待办」的新任务要求').fill('把按钮改成绿色\n并补一条用例')
  await stage.getByLabel('阶段「待办」的新任务要求').press('Control+Enter')
  await expect(page.getByRole('button', { name: '任务：列内任务一' })).toBeVisible()

  // 成功后在原列清空输入、保持展开：接着敲第二张（这次用「添加」按钮）
  await expect(stage.getByLabel('阶段「待办」的新任务标题')).toHaveValue('')
  await stage.getByLabel('阶段「待办」的新任务标题').fill('列内任务二')
  await stage.getByRole('button', { name: '添加' }).click()
  await expect(page.getByRole('button', { name: '任务：列内任务二' })).toBeVisible()

  // 「执行」（entryMode=agent）：建完立刻派活，但要求随任务一起落库，智能体有内容可做
  const exec = page.getByRole('group', { name: '阶段：执行' })
  await exec.getByRole('button', { name: '在「执行」阶段添加任务' }).click()
  await exec.getByLabel('阶段「执行」的新任务标题').fill('执行任务')
  await exec.getByLabel('阶段「执行」的新任务要求').fill('跑一遍构建并汇报失败项')
  await exec.getByLabel('阶段「执行」的新任务要求').press('Control+Enter')
  await expect(page.getByRole('button', { name: '任务：执行任务' })).toBeVisible()

  const db = new DatabaseSync(seed.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    // 三张卡都落在各自阶段（不是首阶段，也不是别的列），描述随行落库
    const todoRows = db
      .prepare(
        `SELECT t.title, t.description FROM tasks t
         JOIN workflow_stages s ON s.id = t.current_stage_id
         WHERE s.name = '待办' ORDER BY t.created_at`,
      )
      .all() as Array<{ title: string; description: string }>
    expect(todoRows).toEqual([
      { title: '列内任务一', description: '把按钮改成绿色\n并补一条用例' },
      { title: '列内任务二', description: '' },
    ])

    const execRow = db
      .prepare(
        `SELECT t.id, t.description FROM tasks t
         JOIN workflow_stages s ON s.id = t.current_stage_id
         WHERE s.name = '执行' AND t.title = '执行任务'`,
      )
      .get() as { id: string; description: string } | undefined
    expect(execRow).toMatchObject({ description: '跑一遍构建并汇报失败项' })
    // agent 列建完立刻入队一轮 run（运行时停用 → 停在 queued，不起子进程）
    const queued = db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status = 'queued'")
      .get(execRow?.id ?? '') as { n: number }
    expect(queued.n).toBe(1)
  } finally {
    db.close()
  }
})
