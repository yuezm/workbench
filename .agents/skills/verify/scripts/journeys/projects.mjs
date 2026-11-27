/** 功能 3/5：项目（features/projects.md） */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

export default async function run({ page, shot, sql, state, artifacts, api }) {
  const steps = []
  const step = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: (await fn()) ?? '' })
    } catch (error) {
      steps.push({ name, ok: false, detail: String(error?.message ?? error).split('\n')[0] })
    }
    return steps.at(-1).ok
  }
  const row = (name) => page.getByRole('button', { name: `项目：${name}` })

  await step('入口：AI 工作流 看板 + 侧栏项目列表', async () => {
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: 'AI 工作流' }).click()
    await page.getByRole('heading', { name: /^工作流「/ }).waitFor({ timeout: 10000 })
    await row('验证项目').waitFor({ timeout: 8000 })
    const list = (await page.getByRole('button', { name: /^项目：/ }).allInnerTexts()).map((t) => t.replaceAll('\n', ' '))
    return `已有项目=${JSON.stringify(list)}`
  })

  await step('project-add 新建项目', async () => {
    await page.getByRole('button', { name: '+ 添加' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 8000 })
    await dialog.getByLabel('项目名称').fill('验收项目')
    await dialog.getByLabel('文件夹路径').fill(state.dataDir)
    await shot('project-dialog')
    await dialog.getByRole('button', { name: '保存' }).click()
    await row('验收项目').waitFor({ timeout: 10000 })
    const db = sql('SELECT name, path FROM projects ORDER BY created_at')
    await shot('project-created')
    return `库内=${JSON.stringify(db)}`
  })

  await step('project-switch 切换项目', async () => {
    await row('验证项目').click()
    const current = await row('验证项目').getAttribute('aria-current')
    const other = await row('验收项目').getAttribute('aria-current')
    if (current !== 'page') throw new Error(`验证项目 aria-current=${current}`)
    if (other === 'page') throw new Error('两个项目同时是当前项')
    return `验证项目 aria-current=page；验收项目=${other}`
  })

  await step('project-edit 改名', async () => {
    await row('验收项目').click()
    await page.getByRole('button', { name: '编辑项目 验收项目' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 8000 })
    await dialog.getByLabel('项目名称').fill('验收项目-改名')
    await dialog.getByRole('button', { name: '保存' }).click()
    await row('验收项目-改名').waitFor({ timeout: 10000 })
    const db = sql('SELECT name FROM projects')
    await shot('project-renamed')
    return `库内=${JSON.stringify(db.map((r) => r.name))}`
  })

  await step('project-remove 删除项目', async () => {
    await row('验收项目-改名').click()
    await page.getByRole('button', { name: '编辑项目 验收项目-改名' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 8000 })
    await dialog.getByRole('button', { name: '删除项目' }).click()
    await row('验收项目-改名').waitFor({ state: 'hidden', timeout: 10000 })
    const db = sql("SELECT name FROM projects WHERE name LIKE '验收项目%'")
    if (db.length > 0) throw new Error(`库里还有：${JSON.stringify(db)}`)
    await shot('project-removed')
    return '行消失且库里没有'
  })

  await step('default-dir 默认目录行（落无项目任务）', async () => {
    await page.getByRole('button', { name: '默认目录' }).click()
    const current = await page.getByRole('button', { name: '默认目录' }).getAttribute('aria-current')
    const editVisible = await page.getByRole('button', { name: /^编辑项目 / }).count()
    // 造一张无项目任务，证明默认目录看的是 tasks.unassigned
    await api.dispatch({
      type: 'task.create',
      commandId: 'verify-unassigned-task',
      input: { title: '验收：无项目任务', workflowId: state.seeded.workflowId, stageId: state.seeded.stageIds['待办'], projectId: null },
    })
    await page.getByRole('button', { name: '任务：验收：无项目任务' }).waitFor({ timeout: 10000 })
    await shot('project-default-dir')
    await row('验证项目').click()
    const hiddenUnderProject = await page.getByRole('button', { name: '任务：验收：无项目任务' }).count()
    return `默认目录 aria-current=${current}；编辑入口=${editVisible}；无项目任务在默认目录可见=1、切到验证项目后=${hiddenUnderProject}`
  })

  writeFileSync(path.join(artifacts, 'projects.aria.txt'), await page.locator('body').ariaSnapshot(), 'utf8')
  return { feature: 'projects', steps }
}
