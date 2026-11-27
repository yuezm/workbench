/** 功能 4/5：设置与服务信息（features/settings.md） */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

export default async function run({ page, shot, artifacts, state, url }) {
  const steps = []
  const step = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: (await fn()) ?? '' })
    } catch (error) {
      steps.push({ name, ok: false, detail: String(error?.message ?? error).split('\n')[0] })
    }
    return steps.at(-1).ok
  }

  await step('settings-enter 从工作台进设置', async () => {
    await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: 'AI 工作流' }).click()
    await page.getByRole('heading', { name: /^工作流「/ }).waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置栏目' }).waitFor({ timeout: 10000 })
    return '设置栏目导航可见'
  })

  await step('settings-nav 七个栏目', async () => {
    const items = (await page.getByRole('navigation', { name: '设置栏目' }).getByRole('button').allInnerTexts()).map((t) => t.trim())
    await shot('settings-nav')
    const want = ['运行时', '智能体', '工作流', '规则', '用量', '插件', '服务']
    const missing = want.filter((name) => !items.some((item) => item === name || item.startsWith(name)))
    if (missing.length > 0) throw new Error(`缺栏目 ${missing.join('/')}；实际=${JSON.stringify(items)}`)
    return JSON.stringify(items)
  })

  await step('service-panel 服务栏读数与实例一致', async () => {
    await page.getByRole('button', { name: '服务', exact: true }).click()
    await page.getByText(state.dataDir, { exact: true }).waitFor({ timeout: 10000 })
    await page.getByText(url, { exact: true }).first().waitFor({ timeout: 5000 })
    await page.getByText(String(state.pid), { exact: true }).first().waitFor({ timeout: 5000 })
    await shot('settings-service')
    const current = await page.getByRole('button', { name: '服务', exact: true }).getAttribute('aria-current')
    if (current !== 'page') throw new Error(`「服务」项 aria-current=${current}`)
    return `数据目录 / 地址 / 进程号 三项命中；服务项 aria-current=page`
  })

  await step('只读：没有输入框与保存按钮', async () => {
    const inputs = await page.getByRole('textbox').count()
    const save = await page.getByRole('button', { name: /保存/ }).count()
    const text = await page.locator('body').innerText()
    return `textbox=${inputs}；保存按钮=${save}；含「重启」文案=${/重启/.test(text)}`
  })

  await step('回到工作台', async () => {
    await page.getByRole('button', { name: '返回工作台' }).click()
    await page.getByRole('heading', { name: /^工作流「/ }).waitFor({ timeout: 10000 })
    return await page.getByRole('heading', { name: /^工作流「/ }).innerText()
  })

  writeFileSync(path.join(artifacts, 'settings.aria.txt'), await page.locator('body').ariaSnapshot(), 'utf8')
  return { feature: 'settings', steps }
}
