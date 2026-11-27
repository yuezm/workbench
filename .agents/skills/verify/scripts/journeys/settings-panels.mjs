/** 设置七个栏目逐个打开（features/settings.md 的 settings-nav 之外的补充抽查：每栏都要有内容） */
export default async function run({ page, shot }) {
  const panels = []
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('navigation', { name: '设置栏目' }).waitFor()
  for (const name of ['运行时', '智能体', '工作流', '规则', '用量', '插件', '服务']) {
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(250)
    const text = (await page.locator('main').innerText().catch(() => page.locator('body').innerText())).replace(/\s+/g, ' ').trim()
    const current = await page.getByRole('button', { name, exact: true }).getAttribute('aria-current')
    await shot(`settings-${encodeURIComponent(name)}`)
    panels.push({ name, current, chars: text.length, head: text.slice(0, 160) })
  }
  return { panels }
}
