/**
 * e2e 的外部通道隔离（测试环境 ↔ 正式环境之间的那道闸）。
 *
 * 为什么需要它：`launchApp` 只隔离 `userData`（临时库 + 单实例锁作用域），隔离不到
 * **真实身份**。飞书通道读的是本机 `~/.lark-cli` 的登录态：安装过 `lark-cli` 并登录的人
 * 跑一次 `pnpm e2e`，`readFeishuConnections` 的 legacy 分支总会给出一条 `default` 连接，
 * `start` 里 `owner()` 拿到真实 open_id → 目标 = 私聊本人 → 种子库里那张 `delivery='pending'`
 * 的 ask 卡会被补投成**一条真的飞书卡片消息**，`card.answer` 还会原地改口。
 *
 * 隔离手段：在应用启动前把「会把消息送到真人 / 外部系统」的通道写进测试库的
 * `plugin_settings` 并停用。内置插件 `pluginEnabled` 判的是 `setting?.enabled !== false`
 * （`src/main/index.ts`），停用后 `channels.startAll()` 不启动它 —— 不 spawn `lark-cli`、
 * 不挂事件长连接、不发卡。`in-app` 与 `desktop` 留在测试里（前者测的就是它，后者只在
 * 本机弹通知，不出机器）。
 *
 * 落 `plugins.replace` 而不是 `plugin.set`：后者由宿主编排（要读磁盘 manifest 与 secret
 * 表），测试侧只有内核事实日志，直接换整批快照才是同一条口径。
 */
import { openDatabase } from '../../src/host/db'
import { createStore } from '../../src/host/store/index'
import { decide } from '../../src/kernel/decide'
import { nextWakeAt } from '../../src/kernel/core/next-wake'
import { project } from '../../src/kernel/scopes/project'
import { viewSpec } from '../../src/kernel/scopes/view-spec'
import type { KernelPort } from '../../src/kernel/core/types'
import type { PluginSetting } from '../../src/protocol/plugins'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

/**
 * 会被测试环境停用的通道：只有飞书。
 * 加新通道前先问一句「它会不会把消息交给一个真人」——会，就加进来。
 */
export const ISOLATED_CHANNEL_IDS = ['feishu'] as const

/** 固定 commandId：同一份 userData 反复 prepare 只落一条事实（命令幂等）。 */
export const ISOLATION_COMMAND_ID = 'e2e-isolate-external-channels'

/**
 * 在既有设置上做「停用外部通道」的整批替换：别的插件的设置原样保留，
 * 被隔离的通道没有设置行就补一行（`enabled:false`），有就改成停用。
 */
export function isolatedPluginSettings(
  existing: readonly PluginSetting[],
  ids: readonly string[] = ISOLATED_CHANNEL_IDS,
): PluginSetting[] {
  const isolated = new Set(ids)
  const kept = existing.map((setting) =>
    isolated.has(setting.id) ? { ...setting, enabled: false } : { ...setting },
  )
  const present = new Set(kept.map((setting) => setting.id))
  for (const id of ids) {
    if (present.has(id)) continue
    kept.push({ id, kind: 'channel', enabled: false, granted: [], config: {} })
  }
  return kept
}

/**
 * 把一份设置快照整批写进一个（可能还不存在的）工作台库文件。
 * 必须在应用启动**之前**调用——通道只在 `startAll()` 时读一次设置。
 */
export function writePluginSettings(
  dbPath: string,
  settings: readonly PluginSetting[],
  commandId: string,
): void {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })
    store.dispatch({ type: 'plugins.replace', commandId, settings: [...settings] })
  } finally {
    db.close()
  }
}

/**
 * 把隔离写进一个（可能还不存在的）工作台库文件：应用随后启动就会读到停用态。
 */
export function seedChannelIsolation(
  dbPath: string,
  ids: readonly string[] = ISOLATED_CHANNEL_IDS,
): void {
  const db = openDatabase(dbPath)
  let settings: PluginSetting[]
  try {
    settings = isolatedPluginSettings(
      createStore({ db, kernel }).query('plugins.settings').settings,
      ids,
    )
  } finally {
    db.close()
  }
  writePluginSettings(dbPath, settings, ISOLATION_COMMAND_ID)
}
