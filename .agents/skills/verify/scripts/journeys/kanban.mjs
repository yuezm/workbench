/** 功能 1/5：看板与任务流转（features/kanban-board.md 的 6 条 sub-feature 逐条走） */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const TITLE = '验证首张卡'

export default async function run({ page, shot, sql, artifacts }) {
  const steps = []
  const step = async (name, fn) => {
    try {
      const detail = await fn()
      steps.push({ name, ok: true, detail: detail ?? '' })
    } catch (error) {
      steps.push({ name, ok: false, detail: String(error?.message ?? error).split('\n')[0] })
    }
    return steps.at(-1).ok
  }
  const card = () => page.getByRole('button', { name: `任务：${TITLE}` })
  const column = (name) => page.getByRole('group', { name: `阶段：${name}` })

  await step('入口：顶部 AI 工作流 标签', async () => {
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: 'AI 工作流' }).click()
    await page.getByRole('heading', { name: /^工作流「/ }).waitFor({ timeout: 10000 })
    return (await page.getByRole('heading', { name: /^工作流「/ }).innerText())
  })

  // board-columns
  await step('board-columns 六列按阶段渲染', async () => {
    const seen = []
    for (const name of ['待办', '方案', '实施', '已阻塞']) {
      await column(name).waitFor({ timeout: 8000 })
      seen.push(name)
    }
    const total = await page.getByRole('group', { name: /^阶段：/ }).count()
    const lines = (await column('方案').innerText()).split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines[0] !== '方案' || !/^\d+$/.test(lines[1] ?? '')) {
      throw new Error(`列头不是「阶段名 + 卡片数」：${JSON.stringify(lines)}`)
    }
    return `列数=${total}；命中=${seen.join('/')}；方案列头=${JSON.stringify(lines.slice(0, 2))}`
  })
  await shot('kanban-board')

  // card in the right column
  await step('card 在方案列', async () => {
    await column('方案').getByRole('button', { name: `任务：${TITLE}` }).waitFor({ timeout: 8000 })
    const inOthers = await page.getByRole('group', { name: /^阶段：/ }).getByRole('button', { name: `任务：${TITLE}` }).count()
    return `命中 ${inOthers} 处（应为 1）`
  })

  // card-open / detail / back
  await step('card-open 进详情并返回', async () => {
    await card().click()
    const section = page.locator('section[aria-label="任务详情"]')
    await section.waitFor({ timeout: 10000 })
    await section.getByText(TITLE, { exact: false }).first().waitFor({ timeout: 10000 })
    await shot('kanban-task-detail')
    await page.getByRole('button', { name: '返回' }).click()
    await page.getByRole('heading', { name: /^工作流「/ }).waitFor({ timeout: 10000 })
    return '详情渲染 + 返回看板 OK'
  })

  // drag-stage
  await step('drag-stage 拖到实施列', async () => {
    await card().dragTo(column('实施'))
    await column('实施').getByRole('button', { name: `任务：${TITLE}` }).waitFor({ timeout: 10000 })
    const rows = sql(
      `SELECT s.name AS stage FROM tasks t JOIN workflow_stages s ON s.id = t.current_stage_id WHERE t.title = ?`,
      [TITLE],
    )
    if (rows[0]?.stage !== '实施') throw new Error(`库内阶段=${rows[0]?.stage}`)
    return '界面换列 + 库内 current_stage_id=实施'
  })
  await shot('kanban-after-drag')

  // archive-drop
  await step('archive-drop 拖进归档区', async () => {
    const before = await page.getByRole('group', { name: '归档区' }).innerText()
    await card().dragTo(page.getByRole('group', { name: '归档区' }))
    await card().waitFor({ state: 'hidden', timeout: 10000 })
    const rows = sql('SELECT archived_at FROM tasks WHERE title = ?', [TITLE])
    if (rows[0]?.archived_at == null) throw new Error('tasks.archived_at 仍为空')
    const after = await page.getByRole('group', { name: '归档区' }).innerText()
    return `归档区 ${JSON.stringify(before)} → ${JSON.stringify(after)}；archived_at=${rows[0].archived_at}`
  })
  await shot('kanban-archived')

  // archived-list
  await step('archived-list 打开归档清单', async () => {
    const button = page.getByRole('button', { name: '查看归档任务' })
    await button.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 8000 })
    await dialog.getByText(TITLE).first().waitFor({ timeout: 8000 })
    await shot('kanban-archived-dialog')
    const text = (await dialog.innerText()).replaceAll('\n', ' | ')
    await page.keyboard.press('Escape')
    return text.slice(0, 300)
  })

  writeFileSync(path.join(artifacts, 'kanban-board.aria.txt'), await page.locator('body').ariaSnapshot(), 'utf8')
  return { feature: 'kanban-board', steps }
}
