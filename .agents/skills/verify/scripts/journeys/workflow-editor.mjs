/** 功能 5/5：工作流编辑器（features/workflow-editor.md） */
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
  const stageChips = () => dialog().getByLabel(/^阶段\d+$/)
  const openEditor = async () => {
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: 'AI 工作流' }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置栏目' }).waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('button', { name: '新建工作流' }).waitFor({ timeout: 10000 })
  }
  const order = async () =>
    (
      await page
        .getByRole('button', { name: /^选择工作流 / })
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
    ).map((label) => String(label).replace('选择工作流 ', ''))

  await step('入口：设置 → 工作流', async () => {
    await openEditor()
    return `现有=${JSON.stringify(await order())}`
  })

  await step('wf-new-blank 从空白创建（四个内置阶段）', async () => {
    await page.getByRole('button', { name: '新建工作流' }).click()
    await page.getByRole('menuitem', { name: '从空白创建工作流' }).click()
    await dialog().waitFor({ timeout: 8000 })
    const chips = await stageChips().count()
    const names = await stageChips().allInnerTexts()
    await dialog().getByLabel('工作流名称').fill('空白验证流')
    await shot('workflow-blank-dialog')
    if (chips !== 4) throw new Error(`草稿阶段数=${chips}，应为 4`)
    await dialog().getByRole('button', { name: '保存' }).click()
    await page.getByRole('button', { name: '选择工作流 空白验证流' }).waitFor({ timeout: 10000 })
    const db = sql('SELECT name FROM workflows')
    return `草稿阶段=${JSON.stringify(names.map((n) => n.replace(/\s+/g, ' ')))}；库内=${JSON.stringify(db.map((r) => r.name))}`
  })

  await step('wf-new-template SOP 模板预填 10 阶段 + 未选智能体保存被拒', async () => {
    await page.getByRole('button', { name: '新建工作流' }).click()
    await page.getByRole('menuitem', { name: '使用模板 产品发现' }).click()
    await dialog().waitFor({ timeout: 8000 })
    const name = await dialog().getByLabel('工作流名称').inputValue()
    const chips = await stageChips().count()
    const names = (await stageChips().allInnerTexts()).map((n) => n.replace(/\s+/g, ' ').replace(/^\d+\s*/, ''))
    await shot('workflow-template-dialog')
    await dialog().getByRole('button', { name: '保存' }).click()
    await dialog().getByRole('alert').first().waitFor({ timeout: 8000 })
    const alertText = await dialog().getByRole('alert').first().innerText()
    await shot('workflow-template-rejected')
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {})
    const db = sql("SELECT name FROM workflows WHERE name = '产品发现'")
    if (chips !== 10) throw new Error(`模板阶段数=${chips}，应为 10`)
    if (db.length !== 0) throw new Error('被拒的定义竟然落库了')
    return `名称=${name}；阶段=${JSON.stringify(names)}；保存被拒文案=「${alertText}」`
  })

  await step('wf-edit 改名', async () => {
    const listitem = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: '选择工作流 空白验证流' }) })
    await listitem.getByRole('button', { name: '编辑' }).click()
    await dialog().waitFor({ timeout: 8000 })
    await dialog().getByLabel('工作流名称').fill('空白验证流-改名')
    await dialog().getByRole('button', { name: '保存' }).click()
    await page.getByRole('button', { name: '选择工作流 空白验证流-改名' }).waitFor({ timeout: 10000 })
    const db = sql('SELECT name FROM workflows')
    return `库内=${JSON.stringify(db.map((r) => r.name))}`
  })

  await step('wf-reorder 拖拽排序，刷新后仍在', async () => {
    const before = await order()
    await page
      .getByRole('button', { name: '拖动排序：工作流 空白验证流-改名' })
      .dragTo(page.getByRole('button', { name: '拖动排序：工作流 验证流程' }))
    await page.waitForTimeout(400)
    const after = await order()
    await page.reload()
    await openEditor()
    const reloaded = await order()
    await shot('workflow-reordered')
    if (JSON.stringify(after) === JSON.stringify(before)) throw new Error(`拖动后顺序没变：${JSON.stringify(after)}`)
    if (JSON.stringify(reloaded) !== JSON.stringify(after)) throw new Error(`刷新后顺序变了：${JSON.stringify(reloaded)}`)
    return `前=${JSON.stringify(before)} → 拖后=${JSON.stringify(after)} → 刷新后=${JSON.stringify(reloaded)}`
  })

  await step('wf-remove 删除工作流', async () => {
    await page.getByRole('button', { name: '删除工作流 空白验证流-改名' }).click()
    await page.getByRole('button', { name: '选择工作流 空白验证流-改名' }).waitFor({ state: 'hidden', timeout: 10000 })
    const db = sql("SELECT name FROM workflows WHERE name LIKE '空白验证流%'")
    if (db.length > 0) throw new Error(`库里还有：${JSON.stringify(db)}`)
    await shot('workflow-deleted')
    return `剩余工作流=${JSON.stringify(sql('SELECT name FROM workflows').map((r) => r.name))}`
  })

  writeFileSync(path.join(artifacts, 'workflow-editor.aria.txt'), await page.locator('body').ariaSnapshot(), 'utf8')
  return { feature: 'workflow-editor', steps }
}
