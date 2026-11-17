/**
 * 测试环境 ↔ 正式环境的隔离（e2e 不得碰真实飞书）。
 *
 * 起因：`launchApp` 的临时 userData 隔离不到本机 `~/.lark-cli` 的登录态。装过 `lark-cli`
 * 并登录的人跑 `pnpm e2e`，飞书通道会按 legacy 单连接拿到真实 open_id，把种子库里那张
 * `delivery='pending'` 的 ask 卡**真的发到本人飞书**（`card.answer` 还会原地改口）。
 *
 * 三条断言：
 * 1. 测试环境启动后飞书通道是停用态（`plugin_settings` 里落 `enabled:false`）；
 * 2. spec 自己的种子即使把飞书打开，也压不过 `launchApp` 的隔离（覆盖顺序固定）；
 * 3. 端到端证据：一张 pending ask 卡在 e2e 里只投给 `in-app`，投递引用里没有飞书。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { PluginView } from '@workbench/protocol/plugins'
import type { WorkbenchApi } from '@workbench/contract-api'
import {
  ISOLATED_CHANNEL_IDS,
  isolatedPluginSettings,
  writePluginSettings,
} from '../support/channel-isolation'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readApprovalState, seedApprovalState } from './helpers/seed-approval'

let launched: LaunchedApp | undefined
let page: Page

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
})

/** 经桥读宿主视图 `plugins.all`（与设置页同一份口径）。 */
function pluginsOf(target: Page): Promise<PluginView[]> {
  return target.evaluate(() => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.query('plugins.all')
  })
}

test('飞书通道在 e2e 里默认停用，in-app 照常可用', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  const plugins = await pluginsOf(page)
  for (const id of ISOLATED_CHANNEL_IDS) {
    const feishu = plugins.find((plugin) => plugin.id === id)
    expect(feishu, `plugins.all 里应有内置通道 ${id}`).toBeDefined()
    expect(feishu?.enabled, `${id} 在测试环境里必须是停用态`).toBe(false)
    expect(feishu?.status, `${id} 的状态应为已停用`).toBe('disabled')
  }
  // 隔离只针对外部通道：应用内通道仍要正常启动，否则测的就不是产品行为了
  expect(plugins.find((plugin) => plugin.id === 'in-app')?.status).toBe('ready')
})

test('spec 种子把飞书打开也压不过隔离（覆盖顺序固定）', async () => {
  test.setTimeout(120_000)
  const userDataDir = createTempUserDataDir()
  const dbPath = path.join(userDataDir, 'ai-workflow.db')
  const isolated = new Set<string>(ISOLATED_CHANNEL_IDS)
  launched = await launchApp({
    userDataDir,
    prepare: () => {
      // 模拟「有人忘了隔离」：种子里明确把飞书打开
      const settings = isolatedPluginSettings([]).map((setting) =>
        isolated.has(setting.id) ? { ...setting, enabled: true } : setting,
      )
      writePluginSettings(dbPath, settings, 'e2e-enable-feishu-on-purpose')
    },
  })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  const plugins = await pluginsOf(page)
  expect(plugins.find((plugin) => plugin.id === 'feishu')?.enabled).toBe(false)
})

test('pending 的 ask 卡只投给 in-app，投递引用里没有飞书', async () => {
  test.setTimeout(120_000)
  const userDataDir = createTempUserDataDir()
  const seeded = await seedApprovalState(path.join(userDataDir, 'ai-workflow.db'))
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 启动时会补投 `delivery='pending'` 的 open 卡；隔离生效时它只落在 in-app
  await expect
    .poll(() => readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId), { timeout: 15_000 })
    .toMatchObject({ cardStatus: 'open', cardDelivery: 'delivered' })

  const state = readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId)
  expect(state.cardDeliveryRef).toBe('in-app')
})
