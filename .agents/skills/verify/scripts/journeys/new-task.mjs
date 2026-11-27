/** 功能 2/5：新建任务（features/new-task.md） */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

export default async function run({ page, shot, sql, artifacts }) {
  const steps = []
  const step = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: (await fn()) ?? '' })
    } catch (error) {
      steps.push({ name, ok: false, detail: String(error?.message ?? error).split('\n')[0] })
    }
    return steps.at(-1).ok
  }
  const dialog = () => page.getByRole('dialog')
  const clickAny = async (scope, name) => {
    for (const role of ['button', 'tab', 'radio', 'menuitem']) {
      const loc = scope.getByRole(role, { name, exact: true })
      if ((await loc.count()) > 0) {
        await loc.first().click()
        return role
      }
    }
    throw new Error(`找不到可点控件「${name}」`)
  }

  await step('入口：AI 工作流 看板', async () => {
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: 'AI 工作流' }).click()
    await page.getByRole('heading', { name: /^工作流「/ }).waitFor({ timeout: 10000 })
    return await page.getByRole('heading', { name: /^工作流「/ }).innerText()
  })

  await step('new-dialog 打开弹窗，默认读数是当前工作流 + 待办', async () => {
    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await dialog().waitFor({ timeout: 8000 })
    const text = (await dialog().innerText()).replaceAll('\n', ' | ')
    await shot('new-task-dialog')
    if (!text.includes('待办')) throw new Error(`弹窗文本里没有「待办」默认阶段：${text.slice(0, 200)}`)
    return text.slice(0, 300)
  })

  await step('title-required 空标题被拦（弹窗不关）', async () => {
    await dialog().getByRole('button', { name: '创建' }).click()
    const alert = dialog().getByRole('alert')
    await alert.first().waitFor({ timeout: 8000 })
    const text = await alert.first().innerText()
    const stillOpen = await dialog().isVisible()
    if (!text.includes('任务标题必填')) throw new Error(`alert 文案=${text}`)
    if (!stillOpen) throw new Error('弹窗被关掉了')
    await shot('new-task-title-required')
    return `alert「${text}」，弹窗仍开`
  })

  await step('created-lands 填写后创建，卡片落在待办', async () => {
    await dialog().getByLabel('任务标题').fill('验收：新建任务')
    await dialog().getByLabel('任务描述').fill('由 verify harness 新建')
    await dialog().getByRole('button', { name: '创建' }).click()
    await page.getByRole('button', { name: '任务：验收：新建任务' }).waitFor({ timeout: 10000 })
    const inTodo = await page.getByRole('group', { name: '阶段：待办' }).getByRole('button', { name: '任务：验收：新建任务' }).count()
    if (inTodo !== 1) throw new Error(`卡片不在待办列（count=${inTodo}）`)
    await shot('new-task-created')
    return '卡片落在「待办」列'
  })

  await step('落库复查（工作流/阶段/描述）', async () => {
    const rows = sql(
      `SELECT w.name AS workflow, s.name AS stage, t.description AS description
       FROM tasks t JOIN workflows w ON w.id = t.workflow_id JOIN workflow_stages s ON s.id = t.current_stage_id
       WHERE t.title = ?`,
      ['验收：新建任务'],
    )
    if (rows.length !== 1) throw new Error(`命中 ${rows.length} 行`)
    const row = rows[0]
    if (row.workflow !== '验证流程' || row.stage !== '待办' || row.description !== '由 verify harness 新建') {
      throw new Error(JSON.stringify(row))
    }
    return JSON.stringify(row)
  })

  await step('choose-stage 换起始阶段到实施', async () => {
    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await dialog().waitFor()
    await dialog().getByRole('combobox', { name: '起始阶段' }).click()
    await page.getByRole('option', { name: '实施' }).click()
    await dialog().getByLabel('任务标题').fill('验收：从实施开始')
    await dialog().getByRole('button', { name: '创建' }).click()
    const inStage = page.getByRole('group', { name: '阶段：实施' }).getByRole('button', { name: '任务：验收：从实施开始' })
    await inStage.waitFor({ timeout: 10000 })
    await shot('new-task-stage-picked')
    const rows = sql(
      `SELECT s.name AS stage FROM tasks t JOIN workflow_stages s ON s.id=t.current_stage_id WHERE t.title=?`,
      ['验收：从实施开始'],
    )
    return `界面在实施列；库内 stage=${rows[0]?.stage}`
  })

  await step('brief-modes 需求模式按字段填并序列化', async () => {
    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await dialog().waitFor()
    const modeRole = await clickAny(dialog(), '需求')
    const labels = await dialog().locator('label').allInnerTexts()
    const boxes = dialog().getByRole('textbox')
    const boxCount = await boxes.count()
    for (let i = 0; i < boxCount; i += 1) await boxes.nth(i).fill(`字段${i + 1}:验收值`)
    await dialog().getByRole('button', { name: '创建' }).click()
    await page.getByRole('button', { name: '任务：字段1:验收值' }).waitFor({ timeout: 10000 }).catch(() => {})
    const rows = sql('SELECT title, description FROM tasks ORDER BY created_at DESC LIMIT 1')
    await shot('new-task-brief-mode')
    return `切到「需求」模式(${modeRole})；字段=${JSON.stringify(labels)}；最新任务 title=${rows[0]?.title} description=${(rows[0]?.description ?? '').slice(0, 200).replaceAll('\n', '\\n')}`
  })

  writeFileSync(path.join(artifacts, 'new-task.aria.txt'), await page.locator('body').ariaSnapshot(), 'utf8')
  return { feature: 'new-task', steps }
}
