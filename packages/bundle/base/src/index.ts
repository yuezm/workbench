/**
 * 装配根（服务端）：把内核、宿主、插件、通道、调度器装成一台常驻服务。
 *
 * 与桌面形态的唯一区别是「副作用从哪来」：窗口/托盘/系统通知/安全存储不见了，换成
 * 数据目录、SSE 广播、本地密钥与 HTTP 会话。`packages/host/**` 一行未改——宿主本来就不
 * import Electron，能力全部由这里注入。
 *
 * 启动顺序（每一步都别调换）：
 * 1. 数据目录收紧 → 产物根 → 回填终态正文（幂等）；
 * 2. 开库 → 建 store → 导入 v2 存量 → 对账投影 → 补内置阶段；
 * 3. 执行器会话根、默认工作目录、网络与回执工具 → sdk 能力面；
 * 4. 插件目录合并（内置 + 用户目录）→ secret 加密 → 通道/来源启动；
 * 5. 时钟与调度器 → 唯一写路径 `effects.dispatch` → 命令路由；
 * 6. 启动对账（残留进程、超租约、崩溃中的聊天）→ `scheduler.wake()` → `clock.start()`。
 *
 * 退出顺序与之相反：先取消活跃 run，再停来源（不再收外部事件）、停通道（abort 投递）、
 * 停推送批次，最后关库。
 *
 * 本文件只做**接线**：判断与派生都在 `catalog.ts`（插件目录/视图）、`executor-tables.ts`
 * （表单默认值）、`host-views.ts`（只读查询）、`wiring.ts`（时序接线）里，各自可单测。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { decide } from '@workbench/kernel/decide'
import { nextWakeAt } from '@workbench/kernel/core/next-wake'
import { project } from '@workbench/kernel/scopes/project'
import { viewSpec } from '@workbench/kernel/scopes/view-spec'
import type { KernelPort } from '@workbench/kernel/core/types'
import { KERNEL_VERSION } from '@workbench/kernel/core/types'
import { backfillRunOutputs } from '@workbench/host/artifacts'
import { createClock, type Clock } from '@workbench/host/clock'
import { createChannels, type Channels } from '@workbench/host/channels'
import {
  createCommandRouter,
  type CommandRouter,
  type HostViewResolver,
} from '@workbench/host/commands'
import { createEffects } from '@workbench/host/effects'
import { createFactFeed, type FactFeed } from '@workbench/host/feed'
import { resolveReceiptTool } from '@workbench/host/receipt-tool'
import { defaultSpawn, killPidTree } from '@workbench/host/process'
import { createProcessRegistry } from '@workbench/host/process-registry'
import { reconcile } from '@workbench/host/reconcile'
import { createScheduler, type Scheduler } from '@workbench/host/scheduler'
import { ensureProjectAgents } from '@workbench/host/project-agents'
import { openDatabase } from '@workbench/host-store/db'
import { secureDataDir } from '@workbench/host/secure-dir'
import { createNetCapability } from '@workbench/host/net'
import { createLarkAdmin } from '@workbench/host/lark-admin'
import { discoverExternalPlugins } from '@workbench/host/plugins/discover'
import { createPluginSecrets } from '@workbench/host/plugins/settings'
import { createSources, type Sources } from '@workbench/host/sources'
import { createStore, DEFAULT_LIMITS, type Store } from '@workbench/host-store/index'
import { importLegacyIfNeeded } from '@workbench/host-store/import'
import { createSdkHost } from '@workbench/host/sdk-host'
import { createExecutorRegistry } from '@workbench/host/executor-registry'
import {
  channels as pluginChannels,
  detectAll,
  executors as pluginExecutors,
  sources as pluginSources,
} from '@workbench/plugins-registry'
import type { ServerEvent, ServerInfo } from '@workbench/protocol/http'
import type { PluginSetting } from '@workbench/protocol/plugins'
import { createLocalCipher, KEY_FILE } from '@workbench/api-http/secret-cipher'
import { createNotifier } from '@workbench/api-http/notify'
import {
  mergeCatalog,
  channelEntriesOf,
  sourceEntriesOf,
  pluginViewsOf,
  pluginCommandDepsOf,
  secretWriterOf,
  hubConfigOf,
  hubEnabledOf,
  type AdapterDeps,
  type PluginRuntimeState,
} from './catalog'
import { executorDefaultsOf } from './executor-tables'
import { chatFallbackPromptOf, describeRunOf, hostViewOf, reconcileReadsOf } from './host-views'
import { resolveWorkdir } from './workdir'
import {
  announceNoticesOf,
  chatStreamHooksOf,
  lazyChannelHub,
  prefixedLog,
  reconcileLogLines,
  passthroughDispatch,
  clockTickHook,
  schedulerRef,
} from './wiring'
import { SERVER_NAME, SERVER_VERSION } from './version'

export interface WorkbenchOptions {
  /** 数据目录（库、产物、插件、密钥、会话都在这里） */
  dataDir: string
  /** 环境来源（默认 `process.env`） */
  env?: NodeJS.ProcessEnv
  /** 诊断日志（默认写 stderr）；「启动完成」这类人读日志也走这里 */
  log?: (line: string) => void
  /** 推送出口：事实批次、聊天流、知会都从这里出去（HTTP 层接 SSE） */
  publish: (event: ServerEvent) => void
  /** 当前在线的事件流客户端数（`/api/info` 用） */
  clients?: () => number
}

export interface Workbench {
  readonly router: CommandRouter
  readonly store: Store
  /** `/api/info` 与设置页「服务」一栏 */
  info(): ServerInfo
  /** 对账入口暴露给测试与运维脚本（启动后已自动跑过一次） */
  readonly lark: ReturnType<typeof createLarkAdmin>
  shutdown(): Promise<void>
}

/**
 * 启动装配。
 *
 * 失败一律抛出（入口负责打印并退出 1）：数据库打不开、投影重建失败这类问题必须
 * 让进程起不来，而不是带着半套状态继续服务。
 */
export async function createWorkbench(options: WorkbenchOptions): Promise<Workbench> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const env = options.env ?? process.env
  const dataDir = path.resolve(options.dataDir)
  const startedAt = new Date().toISOString()

  // 数据目录可能还不存在（第一次部署 / 新容器卷）：先建出来，否则开库直接
  // `unable to open database file`——桌面形态里 userData 是 Electron 预建的，服务端没有这层。
  mkdirSync(dataDir, { recursive: true })

  // M36-H：把数据目录收紧到「只有本账号与 SYSTEM」（Unix 0700 / Windows icacls）。
  // 失败只记日志：改不了 ACL 也要能启动，真正的隔离靠独立账号或容器。
  secureDataDir(dataDir, { log })
  const artifactsRoot = path.join(dataDir, 'artifacts')
  // 一次性回填（幂等）：output.md 落盘晚于最早的终态归档，老 run 只有全帧流水。
  // 索引按规则给模型 output.md 路径，缺文件时每轮都会先 read 失败一次，所以启动时补齐。
  backfillRunOutputs(artifactsRoot)
  const db: DatabaseSync = openDatabase(path.join(dataDir, 'ai-workflow.db'))
  // 内核门面：decide / project / viewSpec / nextWakeAt 是纯函数，store 与 clock 只依赖这个端口。
  const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }
  const store = createStore({ db, kernel, artifactsRoot })
  // 启动顺序：先把 v2 存量导成事实导入根，再对账投影（指纹失配/seq 落后则从事实重建）。
  // 先导入更安全：空事实 + 存量投影时不会因为指纹失配把存量当投影清掉。
  importLegacyIfNeeded(db, kernel)
  store.ensureProjection()
  // M18：每个工作流补成「待办 / 已阻塞 / 已完成 / 已取消」四件套（含历史工作流按名认领）
  store.ensureBuiltinStages()
  // 执行器会话持久化放在数据目录下，聊天才能跨轮续接；目录必须先存在
  // （dsh profile 会直接在 session root 下写会话/spill 文件）。
  const sessionsDir = path.join(dataDir, 'ai-workflow', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })

  // 默认工作目录（运行时 workdir 留空时执行器用它）：WORKBENCH_WORKDIR > ~/.workbench
  const defaultWorkdir = resolveWorkdir(
    { env, home: homedir(), fallback: process.cwd() },
    prefixedLog(log, '[workdir] '),
  )
  const net = createNetCapability()
  // 知会：SSE 推给在线页面（系统通知在服务器形态下不存在）
  const notifier = createNotifier({ publish: options.publish, log })
  const sdkHost = createSdkHost({
    sessionRoot: sessionsDir,
    cwd: defaultWorkdir,
    notify: notifier,
    net,
    // 插件与执行器的诊断都走同一个日志出口（缺省即 stderr）：不给的话 sdk 会自己退回
    // console.warn，和装配根的 log 分叉，测试与运维都得看两个地方
    log,
    // 回执工具 server 默认注入（脚本找不到就退回纯文本通道）；
    // `WORKBENCH_RECEIPT_TOOL=0` 可关掉，排查协议问题时用。
    receiptTool: resolveReceiptTool({ env, mainDir: __dirname }),
  })
  // 执行器注册表：按运行时配置的 executorKey 取插件端口；未知 key 由调度器兜底终态。
  const executors = createExecutorRegistry(pluginExecutors, sdkHost)
  // 插件 secret 只存密文（本地主密钥 + AES-256-GCM）；密钥不可用时写入口拒绝，不落明文。
  const pluginCipher = createLocalCipher({
    keyFile: path.join(dataDir, KEY_FILE),
    log,
  })
  const pluginSecrets = createPluginSecrets({
    db,
    cipher: pluginCipher,
    log: sdkHost.log,
  })
  // 用户目录插件：只发现/校验，不执行安装脚本；同名（kind+id）覆盖内置。
  const discovered = await discoverExternalPlugins({
    pluginsRoot: path.join(dataDir, 'plugins'),
    builtins: [...pluginExecutors, ...pluginChannels, ...pluginSources].map((entry) => ({
      kind: entry.manifest.kind,
      id: entry.key,
    })),
  })
  // 目录合并与派生态（插件视图 / 注册项 / 命令依赖）都在 catalog.ts 里，这里只给数据源。
  const { catalog, rejections } = mergeCatalog(
    [...pluginExecutors, ...pluginChannels, ...pluginSources].map((entry) => ({
      key: entry.key,
      manifest: entry.manifest,
    })),
    discovered,
  )
  const pluginRuntimeState: PluginRuntimeState = {
    settingOf: (id): PluginSetting | null =>
      store.query('plugins.settings').settings.find((row) => row.id === id) ?? null,
    secretsOf: (id) => pluginSecrets.readSecrets(id),
    secretKeysOf: (id) => pluginSecrets.listSecretKeys(id),
  }
  const adapterDeps: AdapterDeps = {
    // 服务端进程就是 node：子进程用同一个可执行文件跑 `plugin.mjs`
    execPath: process.execPath,
    spawn: defaultSpawn,
    log: sdkHost.log,
  }
  const channelEntries = channelEntriesOf(catalog, pluginRuntimeState, adapterDeps)
  const sourceEntries = sourceEntriesOf(catalog, pluginRuntimeState, adapterDeps)
  // 启动对账（T13）：先按 process_registry 的残留 pid 终止上次崩溃留下的进程树、清登记，
  // 再 dispatch clock.tick 回收超租约（run.abandoned / executor_lost）与超时（timeout）的 run。
  // 此刻 scheduler 还没装配：直接走 store.dispatch（启动期没有订阅者），随后的
  // scheduler.wake() 会接住被重排回 queued 的 run。
  const registry = createProcessRegistry(db)
  const reconciled = reconcile({
    registry,
    ...reconcileReadsOf(store),
    dispatch: (input) => store.dispatch(input),
    killPid: killPidTree,
  })
  // 摘要只用于诊断：残留进程与回收数量非零时留一条日志（不建 UI 通道）
  for (const line of reconcileLogLines(reconciled)) log(line)
  // 事实推送（M5）：批次 + 聊天流旁路；HTTP 层把这些事件原样推给 SSE 客户端
  const feed: FactFeed = createFactFeed()
  feed.subscribe((event) => options.publish(event))
  // 写入口与提交后分发：effects.dispatch 是 HTTP / scheduler / clock / 通道的唯一写路径；
  // effects / channels / scheduler 按构造顺序互相惰性取（getter 首次调用发生在装配完成后）
  const channelsHolder: { current: Channels | null } = { current: null }
  const schedulerHolder: { current: Scheduler | null } = { current: null }
  const effects = createEffects({
    store,
    scheduler: schedulerRef(schedulerHolder),
    channels: lazyChannelHub(channelsHolder),
    onFacts: (facts) => feed.publish(facts),
    // M12：卡片之外的两类打扰（任务完成 / 运行失败）。落点是业务值（`taskId`），
    // appId 由知会层补（`NOTIFY_APP_ID`）。
    announce: announceNoticesOf(notifier),
  })
  // 通道 hub（M4 D9）：effects 之后创建、scheduler 之前 startAll；
  // 启动时先补投 `delivery='pending'` 的 open 卡（重启只补未送达的版本）。
  // M7：用户停用/未授权的通道不启动；每条通道只拿到自己的 config（含按授权解密的 secret）。
  const channels = createChannels({
    store,
    effects,
    entries: channelEntries,
    sdkHost,
    configOf: hubConfigOf(catalog, pluginRuntimeState, 'channel'),
    isEnabled: hubEnabledOf(catalog, pluginRuntimeState, 'channel'),
  })
  channelsHolder.current = channels
  await channels.startAll()
  // 来源 hub（M7 D8）：通道之后启动、scheduler 之前 startAll；退出先停 sources 再停 channels。
  const sources: Sources = createSources({
    entries: sourceEntries,
    sdkHost,
    effects,
    configOf: hubConfigOf(catalog, pluginRuntimeState, 'source'),
    isEnabled: hubEnabledOf(catalog, pluginRuntimeState, 'source'),
    log: sdkHost.log,
  })
  await sources.startAll()

  /**
   * M7 宿主视图 `plugins.all`：磁盘发现的插件目录 + 当前设置 + 运行状态。
   * secret 只回键名；`manifest_error` 行来自用户目录扫描的拒绝项。
   */
  const pluginViews = () =>
    pluginViewsOf({
      catalog,
      rejections,
      runtime: pluginRuntimeState,
      sourceStatuses: sources.statuses(),
    })
  /** 命令路由的插件编排依赖（M7）：磁盘条目 / 视图行 / secret 写入。 */
  const pluginDeps = pluginCommandDepsOf({
    catalog,
    views: pluginViews,
    writeSecrets: secretWriterOf(pluginSecrets),
  })
  // 唯一时钟先建（调度器领取/收尾时通过 rearm 重新排期），start 在首次领取之后
  const clock: Clock = createClock({
    store: {
      dispatch: passthroughDispatch(effects),
      nextWakeAt: (at) => store.nextWakeAt(at),
    },
    now: () => new Date().toISOString(),
    onTick: clockTickHook(schedulerHolder),
  })
  const scheduler: Scheduler = createScheduler({
    dispatch: passthroughDispatch(effects),
    runtimes: () => store.query('runtimes.all'),
    // 执行配置（模型 / 思考强度 / 环境变量）来自智能体：调度器按 run.agentId 取整行
    agents: () => store.query('agents.all'),
    executors,
    limits: DEFAULT_LIMITS,
    // M14：评审报告正文落 `<artifactsRoot>/threads/<threadId>/runs/<runId>/review.md`；
    // M15：同一轮正文另落 `output.md`（任务索引据此按需读）
    artifactsRoot,
    // M16 归档标签：任务标题 / 阶段名 / 智能体名（查不到就给 id，不阻断归档）
    describeRun: (run) => describeRunOf(store, run),
    // M16 终态归档的帧来源：run_events 投影（与 UI 时间线同源）
    framesOf: (runId) => store.query('run.events', { runId }),
    // 重启后重跑同一 run 时帧 seq 继续全局单调（读 run_events 投影的 MAX(seq)）
    lastFrameSeq: (runId) => store.query('run.last-event-seq', { runId }),
    registry,
    // run 领取 / 收尾 / 取消后重排唯一定时器：启动之后才出现的租约与超时靠它纳入排期
    rearmClock: () => clock.rearm(),
    // 聊天 run 的帧实时旁路（subscribe 的 stream 事件）：页面显示，入账仍走 run.frames
    ...chatStreamHooksOf(feed),
    // 续接被拒重试用完整历史 prompt（续接轮只发新消息，回退必须带上整段对话）
    chatFallbackPrompt: (run) => chatFallbackPromptOf(store, run),
    // 调度器写入口自己吞掉单次失败（一次拒收不能打断整轮调度），失败原因只能靠这里留痕：
    // 回执写不进库时 run 会悬到租约过期，界面上只剩 executor_lost，看不到真因
    log: prefixedLog(log, '[scheduler] '),
  })
  // 调度器就位后填回引用：effects 的 `scheduler` 依赖与 clock 的 tick 钩子都经 holder 取
  schedulerHolder.current = scheduler
  // 三动词的宿主实现：命令路由（校验/幂等/编排）+ 读视图（DB 视图走 store，
  // 宿主视图走插件注册表 / CLI 探测 / 执行器模型目录；只读、不写库）
  const hostView: HostViewResolver = hostViewOf({
    executors: pluginExecutors,
    forRuntime: (runtime) => executors.forRuntime(runtime),
    detect: () => detectAll(sdkHost),
    store,
    sessionsDir,
    defaultWorkdir,
    plugins: pluginViews,
  })
  const router = createCommandRouter({
    store,
    dispatch: passthroughDispatch(effects),
    executors,
    executorDefaults: (key) => executorDefaultsOf(pluginExecutors, key),
    hostView,
    plugins: pluginDeps,
    // M53：新项目落地后补一份默认 AGENTS.md（项目根没有才写）
    projectAgents: ensureProjectAgents,
    warn: log,
  })
  // M45：飞书连接面板用的本机 CLI 探测/登录（宿主 env 由它自己读，secret 只进不出）
  const lark = createLarkAdmin({ log })
  // 启动：对账已在上方完成（残留进程已清、超租约已回收），这里先领取遗留 queued run，
  // 再挂唯一定时器（周期回收走 nextWakeAt + clock.tick，不再单独轮询）
  scheduler.wake()
  clock.start()

  let closed = false
  return {
    router,
    store,
    lark,
    info: () => ({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      kernelVersion: KERNEL_VERSION,
      dataDir,
      defaultWorkdir,
      startedAt,
      clients: options.clients?.() ?? 0,
      pid: process.pid,
    }),
    shutdown: async () => {
      if (closed) return
      closed = true
      // 退出前 best-effort 取消活跃 run：立即杀进程树并写取消终态，不等待回执
      scheduler.cancelAll()
      clock.stop()
      // M7 顺序：先停来源（不再接收外部事件）再停通道（abort 投递）
      await sources.stopAll()
      await channels.stopAll()
      // 推送停表：退出后不再排批次（已入账的事实仍然完整）
      feed.stop()
      db.close()
    },
  }
}
