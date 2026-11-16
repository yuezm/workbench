// @vitest-environment node
/**
 * 装配根的「宿主视图 + 命令编排」：router.query/dispatch 打到装配根注入的接缝上。
 *
 * 这些分支只在真装配里存在（视图要读插件目录、执行器注册表、会话日志；命令要写 secret 表），
 * 所以用真库 + 真插件目录跑，而不是给每个依赖写 mock。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, RuntimeExecutorChoice } from '../../src/protocol/entities'
import type { PluginView } from '../../src/protocol/plugins'
import { createWorkbench, type Workbench } from '../../src/server/assembly'

const created: string[] = []
let workbench: Workbench | null = null

afterEach(async () => {
  await workbench?.shutdown()
  workbench = null
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const boot = async (): Promise<Workbench> => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-views-'))
  created.push(dataDir)
  workbench = await createWorkbench({ dataDir, publish: () => undefined })
  return workbench
}

describe('宿主视图', () => {
  it('runtimes.executors：按注册表顺序给出执行器与 manifest 默认值', async () => {
    const wb = await boot()
    const choices = await wb.router.query('runtimes.executors')
    const rows = choices as RuntimeExecutorChoice[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.key).toBe('dsh')
    expect(rows[0]?.command.length).toBeGreaterThan(0)
  })

  it('runtimes.default-workdir：给运行时会用的目录（留空时的实际值）', async () => {
    const wb = await boot()
    const dir = await wb.router.query('runtimes.default-workdir')
    expect(typeof dir).toBe('string')
    expect(path.isAbsolute(dir as string)).toBe(true)
  })

  it('runtimes.detected：探测本机执行器（返回数组，不抛错）', async () => {
    const wb = await boot()
    const detected = await wb.router.query('runtimes.detected')
    expect(Array.isArray(detected)).toBe(true)
  })

  it('runtimes.models：运行时不存在 → 可读错误', async () => {
    const wb = await boot()
    await expect(wb.router.query('runtimes.models', { runtimeId: 'nope' })).rejects.toThrow(
      /运行时不存在: nope/u,
    )
  })

  it('run.approvals：运行不存在 → 可读错误（不把空数组当成功）', async () => {
    const wb = await boot()
    await expect(wb.router.query('run.approvals', { runId: 'nope' })).rejects.toThrow(
      /运行不存在: nope/u,
    )
  })
})

describe('命令编排', () => {
  it('project.create：真写库，返回值就是新项目行', async () => {
    const wb = await boot()
    const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-project-'))
    created.push(dataDir)
    const result = await wb.router.dispatch({
      type: 'project.create',
      commandId: 'c-project',
      input: { name: '工作台', path: dataDir, description: '' },
    })
    const project = result.value as Project
    expect(project.name).toBe('工作台')
    expect(project.path).toBe(dataDir)
    expect(result.facts.length).toBeGreaterThan(0)
  })

  it('plugin.set：写设置与 secret（只落密文），视图只回键名', async () => {
    const wb = await boot()
    const set = await wb.router.dispatch({
      type: 'plugin.set',
      commandId: 'c-plugin',
      pluginId: 'webhook-channel',
      enabled: true,
      config: {},
      secrets: { secret: 'plain-secret-value' },
    })
    const view = set.value as PluginView
    expect(view.id).toBe('webhook-channel')
    expect(view.secretKeys).toContain('secret')
    // 视图与返回值都不回显 secret 值
    expect(JSON.stringify(view)).not.toContain('plain-secret-value')

    const listed = (await wb.router.query('plugins.all')) as PluginView[]
    const row = listed.find((item) => item.id === 'webhook-channel')
    expect(row?.secretKeys).toContain('secret')
  })

  it('plugin.set：secrets 里 null 表示删除该键', async () => {
    const wb = await boot()
    await wb.router.dispatch({
      type: 'plugin.set',
      commandId: 'c-set',
      pluginId: 'webhook-channel',
      enabled: true,
      secrets: { secret: 'v' },
    })
    const removed = await wb.router.dispatch({
      type: 'plugin.set',
      commandId: 'c-remove',
      pluginId: 'webhook-channel',
      enabled: true,
      secrets: { secret: null },
    })
    const view = removed.value as PluginView
    expect(view.secretKeys).not.toContain('secret')
  })
})
