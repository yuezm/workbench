import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { decide } from '../kernel/decide'
import { chatPrompt } from '../kernel/prompt'
import { nextWakeAt } from '../kernel/next-wake'
import { project } from '../kernel/project'
import { viewSpec } from '../kernel/view-spec'
import type { KernelPort } from '../kernel/types'
import { createClock, type Clock } from '../host/clock'
import { createChannels, type Channels } from '../host/channels'
import {
  createCommandRouter,
  type HostViewResolver,
  type PluginCommandDeps,
} from '../host/commands'
import { createEffects } from '../host/effects'
import { createFactFeed, type FactFeed } from '../host/feed'
import { defaultSpawn, killPidTree } from '../host/process'
import { createProcessRegistry } from '../host/process-registry'
import { reconcile } from '../host/reconcile'
import { createScheduler, type Scheduler } from '../host/scheduler'
import { openDatabase } from '../host/db'
import { createNetCapability } from '../host/net'
import {
  createExternalChannelPlugin,
  createExternalSourcePlugin,
  type ExternalAdapterOptions,
} from '../host/plugins/adapters'
import {
  discoverExternalPlugins,
  type ExternalPluginEntry,
  type ExternalPluginRejection,
} from '../host/plugins/discover'
import {
  createPluginSecrets,
  resolvePluginConfig,
  type SecretCipher,
} from '../host/plugins/settings'
import { createSources, type Sources, type SourceRegistryEntry } from '../host/sources'
import { createStore, DEFAULT_LIMITS } from '../host/store/index'
import { importLegacyIfNeeded } from '../host/store/import'
import { registerIpcHandlers } from './ipc'
// 系统通知原件（M4）：宿主不 import electron，由装配根注入 sdk（`sdk.notify` 的门控在 sdk 层）
import { notify } from './notify'
import { createTray } from './tray'
import { createSdkHost } from '../host/sdk-host'
import { createExecutorRegistry } from '../host/executor-registry'
import {
  channelById,
  channels as pluginChannels,
  detectAll,
  executors as pluginExecutors,
  sourceById,
  sources as pluginSources,
} from '../plugins/registry'
import type {
  ChannelRegistryEntry,
  SourceRegistryEntry as BuiltinSourceEntry,
} from '../plugins/registry'
import type { RuntimeExecutorChoice, RuntimeInput } from '../protocol/entities'
import type { PluginManifest, PluginKind } from '../protocol/manifest'
import { PLUGIN_KINDS } from '../protocol/manifest'
import type { PluginSetting, PluginView, PluginStatus } from '../protocol/plugins'
import { WORKBENCH_EVENT_CHANNEL } from '../protocol/ipc'

let quitting = false
let win: BrowserWindow | null = null
/** 装配完成后的调度器句柄：退出流程要 best-effort 取消活跃 run（T15）。 */
let activeScheduler: Scheduler | null = null
/** 装配完成后的通道 hub：退出流程 abort + best-effort dispose（M4 D9）。 */
let activeChannels: Channels | null = null
/** 装配完成后的来源 hub（M7）：退出流程先停 sources 再停 channels。 */
let activeSources: Sources | null = null
/** 事实推送（M5）：批次 + 聊天流；退出时停表。 */
let activeFeed: FactFeed | null = null

/** M7：磁盘插件目录（内置 + 用户目录）合并后的一条。 */
interface CatalogEntry {
  id: string
  kind: PluginKind
  builtin: boolean
  manifest: PluginManifest
  /** 用户目录插件（内置为 null） */
  external: ExternalPluginEntry | null
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16161e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win?.show())

  // 点 X 隐藏到托盘而不是退出，真正退出走托盘菜单（before-quit 里置位）
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win?.hide()
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// 单实例：锁必须在 whenReady 之前判断。已有实例在跑时，本进程直接退出，
// 不建窗口、不注册托盘、不开库、不注册 IPC，全部装配都留给第一个实例。
if (app.requestSingleInstanceLock()) {
  // 第二次启动：已有窗口就唤到前台，窗口全关了则重建
  app.on('second-instance', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      return
    }
    win?.show()
    win?.focus()
  })

  app.whenReady().then(async () => {
    // Windows 通知归属需要 AppUserModelId
    app.setAppUserModelId('com.workbench.desktop')

    // M5：事实推送（批次 ≤500 条 / 16 ms + 聊天流旁路）；IPC 只暴露 dispatch/query/subscribe。
    const feed = createFactFeed()
    activeFeed = feed
    feed.subscribe((event) => {
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          w.webContents.send(WORKBENCH_EVENT_CHANNEL, event)
        } catch {
          // 窗口/渲染进程已失效：推送只是显示，事实才是数据源
        }
      }
    })
    const userData = app.getPath('userData')
    const db = openDatabase(path.join(userData, 'ai-workflow.db'))
    // 内核门面：decide / project / viewSpec / nextWakeAt 是纯函数，store 与 clock 只依赖这个端口。
    const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }
    const store = createStore({ db, kernel })
    // 启动顺序：先把 v2 存量导成事实导入根，再对账投影（指纹失配/seq 落后则从事实重建）。
    // 先导入更安全：空事实 + 存量投影时不会因为指纹失配把存量当投影清掉。
    importLegacyIfNeeded(db, kernel)
    store.ensureProjection()
    // 执行器插件：dsh 会话持久化放在 userData 下，聊天才能跨轮续接；
    // 目录必须先存在（dsh profile 会直接在 session root 下写会话/spill 文件）。
    const sessionsDir = path.join(userData, 'ai-workflow', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    // 插件能力面（宿主注入）：spawn/解析/杀树/时钟/会话根/网络；插件只经 sdk 拿副作用。
    const net = createNetCapability()
    const sdkHost = createSdkHost({ sessionRoot: sessionsDir, notify, net })
    // 执行器注册表：按运行时配置的 executorKey 取插件端口；未知 key 由调度器兜底终态。
    const executors = createExecutorRegistry(pluginExecutors, sdkHost)
    // M7：插件 secret 只存密文（safeStorage）；不可用时写入口拒绝，不落明文。
    const pluginCipher: SecretCipher = {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, 'base64')),
    }
    const pluginSecrets = createPluginSecrets({
      db,
      cipher: pluginCipher,
      log: (line) => sdkHost.log(line),
    })
    // 用户目录插件：只发现/校验，不执行安装脚本；同名（kind+id）覆盖内置。
    const discovered = await discoverExternalPlugins({
      pluginsRoot: path.join(userData, 'plugins'),
      builtins: [...pluginExecutors, ...pluginChannels, ...pluginSources].map((entry) => ({
        kind: entry.manifest.kind,
        id: entry.key,
      })),
    })
    const pluginRejections: ExternalPluginRejection[] = [...discovered.rejections]
    const catalog: CatalogEntry[] = []
    for (const entry of [...pluginExecutors, ...pluginChannels, ...pluginSources]) {
      catalog.push({
        id: entry.key,
        kind: entry.manifest.kind,
        builtin: true,
        manifest: entry.manifest,
        external: null,
      })
    }
    for (const external of discovered.entries) {
      const sameKind = catalog.findIndex(
        (candidate) => candidate.id === external.id && candidate.kind === external.kind,
      )
      const next: CatalogEntry = {
        id: external.id,
        kind: external.kind,
        builtin: false,
        manifest: external.manifest,
        external,
      }
      if (sameKind >= 0 && catalog[sameKind]?.builtin === true) {
        catalog[sameKind] = next
        continue
      }
      // 插件 id 全局唯一：与其它 kind 的内置/外部插件撞 id 时拒绝（不静默并存）
      if (catalog.some((candidate) => candidate.id === external.id)) {
        pluginRejections.push({
          path: `${external.kind}/${external.id}`,
          kind: external.kind,
          id: external.id,
          reason: 'duplicate_id',
          detail: `插件 id 已被占用: ${external.id}`,
        })
        continue
      }
      catalog.push(next)
    }
    const pluginSettingsOf = () => store.query('plugins.settings')
    const pluginSettingOf = (id: string): PluginSetting | null =>
      pluginSettingsOf().settings.find((row) => row.id === id) ?? null
    const declaredOf = (entry: CatalogEntry) => [...entry.manifest.capabilities]
    const grantedOf = (entry: CatalogEntry) =>
      entry.builtin ? declaredOf(entry) : (pluginSettingOf(entry.id)?.granted ?? [])
    const pluginAuthorized = (entry: CatalogEntry) =>
      declaredOf(entry).every((capability) => grantedOf(entry).includes(capability))
    const pluginEnabled = (entry: CatalogEntry): boolean => {
      const setting = pluginSettingOf(entry.id)
      if (entry.builtin) return setting?.enabled !== false
      return setting?.enabled === true && pluginAuthorized(entry)
    }
    const pluginConfigOf = (entry: CatalogEntry) =>
      resolvePluginConfig(
        entry.manifest,
        pluginSettingOf(entry.id),
        pluginSecrets.readSecrets(entry.id),
        entry.builtin,
      )
    const adapterOptions = (entry: CatalogEntry): ExternalAdapterOptions | null => {
      if (entry.external === null) return null
      return {
        execPath: process.execPath,
        spawn: defaultSpawn,
        granted: grantedOf(entry),
        config: pluginConfigOf(entry),
        log: (line) => sdkHost.log(line),
      }
    }
    const channelEntries: ChannelRegistryEntry[] = catalog
      .filter((entry) => entry.kind === 'channel')
      .map((entry) => {
        const options = adapterOptions(entry)
        const external = entry.external
        if (external !== null && options !== null) {
          return {
            key: entry.id,
            label: entry.manifest.name,
            manifest: entry.manifest,
            plugin: createExternalChannelPlugin(external, options),
          }
        }
        return channelById(entry.id)
      })
    const sourceEntries: SourceRegistryEntry[] = catalog
      .filter((entry) => entry.kind === 'source')
      .map((entry) => {
        const options = adapterOptions(entry)
        const external = entry.external
        if (external !== null && options !== null) {
          return {
            key: entry.id,
            label: entry.manifest.name,
            manifest: entry.manifest,
            plugin: createExternalSourcePlugin(external, options),
          }
        }
        return sourceById(entry.id) as BuiltinSourceEntry
      })
    /**
     * 运行时表单的默认值来自执行器插件 manifest（内核与宿主都不写产品名）。
     * 未指定 key 时取注册表首项；key 不存在直接抛可读错误（IPC 原样展示）。
     */
    const manifestDefault = (entry: (typeof pluginExecutors)[number], fieldKey: string): string => {
      const field = (entry.manifest.config ?? []).find((candidate) => candidate.key === fieldKey)
      if (field === undefined) return ''
      const value = 'default' in field ? field.default : undefined
      return typeof value === 'string' ? value : ''
    }
    const executorEntry = (key: string | undefined): (typeof pluginExecutors)[number] => {
      const entry =
        key === undefined
          ? pluginExecutors[0]
          : pluginExecutors.find((candidate) => candidate.key === key)
      if (entry === undefined) throw new Error('执行器插件未注册: ' + String(key))
      return entry
    }
    const executorDefaults = (
      key: string | undefined,
    ): Required<Pick<RuntimeInput, 'executorKey' | 'command' | 'profile'>> => {
      const entry = executorEntry(key)
      return {
        executorKey: entry.key,
        command: manifestDefault(entry, 'command'),
        profile: manifestDefault(entry, 'profile'),
      }
    }
    /** 运行时表单下拉（D11）：只读，顺序即注册表顺序 */
    const executorChoices = (): RuntimeExecutorChoice[] =>
      pluginExecutors.map((entry) => ({
        key: entry.key,
        label: entry.label,
        command: manifestDefault(entry, 'command'),
        profile: manifestDefault(entry, 'profile'),
      }))
    // 启动对账（T13）：先按 process_registry 的残留 pid 终止上次崩溃留下的进程树、清登记，
    // 再 dispatch clock.tick 回收超租约（run.abandoned / executor_lost）与超时（timeout）的 run。
    // 此刻 scheduler 还没装配：直接走 store.dispatch（启动期没有订阅者），随后的
    // scheduler.wake() 会接住被重排回 queued 的 run。
    const registry = createProcessRegistry(db)
    const reconciled = reconcile({
      registry,
      // 崩溃时正在跑的聊天轮次：落 failed/executor_lost，内核补一条错误 assistant 消息
      staleChatRuns: () => store.query('runs.stale-chat'),
      dispatch: (input) => store.dispatch(input),
      // 投影里的 run 状态；run 已随任务/工作流删除时视为缺失（只清登记行）
      runStatus: (runId) => store.query('run.byId', { runId })?.status ?? null,
      // M4 D13：waiting 且无 open 卡的 run 没有可答对象（重建后无 card.* 事实）→ 兜底取消；
      // 有 open 卡的保持等待（有人可答）。过滤由读路径 join，reconcile 不查库。
      waitingRuns: () =>
        store.query('runs.waiting').map((run) => ({
          id: run.runId,
          leaseId: run.leaseId,
          turn: run.turn,
          hasOpenCard: run.hasOpenCard,
        })),
      killPid: killPidTree,
    })
    // 摘要只用于诊断：残留进程与回收数量非零时留一条 warn（不建 UI 通道）
    if (
      reconciled.killed > 0 ||
      reconciled.facts > 0 ||
      reconciled.settledChats > 0 ||
      reconciled.settledWaitings > 0
    ) {
      console.warn(
        `[reconcile] 终止残留进程 ${reconciled.killed} 个、清理登记 ${reconciled.cleared} 行、回收事实 ${reconciled.facts} 条`,
      )
    }
    // 写入口与提交后分发：effects.dispatch 是 IPC / scheduler / clock / 通道的唯一写路径；
    // effects / channels / scheduler 按构造顺序互相惰性取（getter 首次调用发生在装配完成后）
    const channelsHolder: { current: Channels | null } = { current: null }
    const effects = createEffects({
      store,
      scheduler: () => scheduler,
      channels: () => {
        const hub = channelsHolder.current
        if (hub === null) throw new Error('通道 hub 尚未装配')
        return hub
      },
      onFacts: (facts) => feed.publish(facts),
    })
    // 通道 hub（M4 D9）：effects 之后创建、scheduler 之前 startAll；
    // 启动时先补投 `delivery='pending'` 的 open 卡（重启只补未送达的版本）。
    // M7：用户停用/未授权的通道不启动；每条通道只拿到自己的 config（含按授权解密的 secret）。
    const catalogEntryOf = (kind: PluginKind, key: string): CatalogEntry | undefined =>
      catalog.find((entry) => entry.kind === kind && entry.id === key)
    const channelConfigOf = (entry: ChannelRegistryEntry): Record<string, unknown> => {
      const found = catalogEntryOf('channel', entry.key)
      return found === undefined ? {} : pluginConfigOf(found)
    }
    const channelEnabledOf = (entry: ChannelRegistryEntry): boolean => {
      const found = catalogEntryOf('channel', entry.key)
      return found === undefined ? true : pluginEnabled(found)
    }
    const channels = createChannels({
      store,
      effects,
      entries: channelEntries,
      sdkHost,
      configOf: channelConfigOf,
      isEnabled: channelEnabledOf,
    })
    channelsHolder.current = channels
    await channels.startAll()
    activeChannels = channels
    // 来源 hub（M7 D8）：通道之后启动、scheduler 之前 startAll；退出先停 sources 再停 channels。
    const sources = createSources({
      entries: sourceEntries,
      sdkHost,
      effects,
      configOf: (entry) => {
        const found = catalogEntryOf('source', entry.key)
        return found === undefined ? {} : pluginConfigOf(found)
      },
      isEnabled: (entry) => {
        const found = catalogEntryOf('source', entry.key)
        return found === undefined ? true : pluginEnabled(found)
      },
      log: (line) => sdkHost.log(line),
    })
    await sources.startAll()
    activeSources = sources

    /**
     * M7 宿主视图 `plugins.all`：磁盘发现的插件目录 + 当前设置 + 运行状态。
     * secret 只回键名；`manifest_error` 行来自用户目录扫描的拒绝项。
     */
    const pluginViews = (): PluginView[] => {
      const views: PluginView[] = catalog.map((entry) => {
        const setting = pluginSettingOf(entry.id)
        const declared = declaredOf(entry)
        const granted = grantedOf(entry)
        const enabled = pluginEnabled(entry)
        let status: PluginStatus = 'disabled'
        let error: string | null = null
        if (enabled) status = 'ready'
        else if (!entry.builtin && !pluginAuthorized(entry)) status = 'unauthorized'
        if (entry.kind === 'source' && enabled) {
          const runtimeStatus = sources.statuses().find((item) => item.key === entry.id)
          if (runtimeStatus?.state === 'error') {
            status = 'error'
            error = runtimeStatus.error
          }
        }
        return {
          id: entry.id,
          kind: entry.kind,
          name: entry.manifest.name,
          version: entry.manifest.version,
          description: entry.manifest.description ?? '',
          builtin: entry.builtin,
          enabled,
          declared,
          granted,
          configFields: [...(entry.manifest.config ?? [])],
          config: setting?.config ?? {},
          secretKeys: pluginSecrets.listSecretKeys(entry.id),
          status,
          error,
        }
      })
      for (const rejection of pluginRejections) {
        views.push({
          id: rejection.id ?? rejection.path,
          kind: (PLUGIN_KINDS as readonly string[]).includes(rejection.kind ?? '')
            ? (rejection.kind as PluginKind)
            : 'source',
          name: rejection.path || '插件目录',
          version: '',
          description: '',
          builtin: false,
          enabled: false,
          declared: [],
          granted: [],
          configFields: [],
          config: {},
          secretKeys: [],
          status: 'manifest_error',
          error: rejection.detail,
        })
      }
      return views
    }
    /** 命令路由的插件编排依赖（M7）：磁盘条目 / 视图行 / secret 写入。 */
    const pluginDeps: PluginCommandDeps = {
      entry: (id) => {
        const found = catalog.find((item) => item.id === id)
        return found === undefined ? null : { manifest: found.manifest, builtin: found.builtin }
      },
      view: (id) => pluginViews().find((item) => item.id === id) ?? null,
      writeSecrets: (id, patch) => {
        try {
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) pluginSecrets.removeSecret(id, key)
            else pluginSecrets.setSecret(id, key, value)
          }
        } catch (error) {
          // 不把密文/明文写进错误文案；宿主安全存储不可用时拒绝而不是明文落库
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`无法保存插件 secret：${message.split(':')[0] ?? 'unknown'}`, {
            cause: error,
          })
        }
      },
    }
    // 唯一时钟先建（调度器领取/收尾时通过 rearm 重新排期），start 在首次领取之后
    const clock: Clock = createClock({
      store: {
        dispatch: (input) => effects.dispatch(input),
        nextWakeAt: (at) => store.nextWakeAt(at),
      },
      now: () => new Date().toISOString(),
      onTick: () => scheduler.wake(),
    })
    const scheduler: Scheduler = createScheduler({
      dispatch: (input) => effects.dispatch(input),
      runtimes: () => store.query('runtimes.all'),
      executors,
      limits: DEFAULT_LIMITS,
      // 重启后重跑同一 run 时帧 seq 继续全局单调（读 run_events 投影的 MAX(seq)）
      lastFrameSeq: (runId) => store.query('run.last-event-seq', { runId }),
      registry,
      // run 领取 / 收尾 / 取消后重排唯一定时器：启动之后才出现的租约与超时靠它纳入排期
      rearmClock: () => clock.rearm(),
      // 聊天 run 的帧实时旁路（subscribe 的 stream 事件）：渲染端显示，入账仍走 run.frames
      onChatStream: (runId, conversationId, event) =>
        feed.stream({ kind: 'stream', runId, conversationId, event }),
      onChatStreamEnd: (runId, conversationId) =>
        feed.stream({ kind: 'stream-end', runId, conversationId }),
      // 续接被拒重试用完整历史 prompt（续接轮只发新消息，回退必须带上整段对话）
      chatFallbackPrompt: (run) => {
        if (run.purpose !== 'chat' || run.conversationId === null) return null
        const agent = store.query('agents.all').find((item) => item.id === run.agentId)
        const messages = store.query('messages.byConversation', {
          conversationId: run.conversationId,
        })
        return agent && messages.length > 0 ? chatPrompt(agent, messages) : null
      },
    })
    // 退出流程据此取消活跃 run（before-quit 在模块作用域，拿不到这里的局部变量）
    activeScheduler = scheduler
    // 三动词的宿主实现：命令路由（校验/幂等/编排）+ 读视图（DB 视图走 store，
    // 宿主视图走插件注册表 / CLI 探测 / 执行器模型目录；只读、不写库）
    const hostView: HostViewResolver = (view, params) => {
      switch (view) {
        case 'runtimes.executors':
          return executorChoices()
        case 'runtimes.detected':
          return detectAll(sdkHost)
        case 'runtimes.models': {
          const id = params?.runtimeId ?? ''
          const runtime = store.query('runtimes.all').find((item) => item.id === id)
          if (runtime === undefined) throw new Error('运行时不存在: ' + id)
          const port = executors.forRuntime(runtime)
          if (port?.models === undefined) return Promise.resolve([])
          return port.models(runtime)
        }
        case 'plugins.all':
          // M7：插件设置页的只读视图（磁盘目录 + 设置 + 运行状态；secret 只回键名）
          return pluginViews()
      }
    }
    const router = createCommandRouter({
      store,
      dispatch: (input) => effects.dispatch(input),
      executors,
      executorDefaults,
      hostView,
      plugins: pluginDeps,
    })
    registerIpcHandlers({ router })
    // 启动：对账已在上方完成（残留进程已清、超租约已回收），这里先领取遗留 queued run，
    // 再挂唯一定时器（周期回收走 nextWakeAt + clock.tick，不再单独轮询）
    scheduler.wake()
    clock.start()

    createWindow()

    const trayIconDir = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'resources')
    createTray(trayIconDir, () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      win?.show()
      win?.focus()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else win?.show()
    })
  })
} else {
  app.quit()
}

app.on('before-quit', () => {
  quitting = true
  // 退出前 best-effort 取消活跃 run：立即杀进程树并写取消终态，不等待回执（不阻塞退出）
  activeScheduler?.cancelAll()
  // M7 顺序：先停来源（不再接收外部事件）再停通道（abort + dispose 异步，进程退出不等待）
  void activeSources?.stopAll()
  void activeChannels?.stopAll()
  // 推送停表：退出后不再排批次（已入账的事实仍然完整）
  activeFeed?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
