/**
 * `lark-cli` 连接管理（M45）：给设置页的「飞书连接」面板提供**只读探测**与几个可撤销动作。
 *
 * 为什么放在宿主而不是通道插件里：
 * - 通道插件只在启动时读配置、跑长连接，不弹表单、不收用户输入；
 * - 探测要读「本机 CLI 到底连的是哪个应用」，还要把它和**别的 agent 的工作区**比一比
 *   （`HERMES_HOME` / `OPENCLAW_HOME` 会让 CLI 自动绑定过去），这属于宿主的环境知识；
 * - 建 profile / 登录是会改本机状态的动作，经 IPC 由用户显式点，才符合「外部输入不当指令」。
 *
 * 边界：
 * - 所有调用都**剔除别的 agent 的身份变量**（与通道同一份 `LARK_ENV_UNSET` 口径），
 *   于是探测结果就是工作台真实会用的那一套凭据；
 * - app secret 只能从 UI 经 stdin 进来，**不落工作台库、不进日志**：写完就交给 CLI 的
 *   keychain/配置文件，工作台只记得 profile 名；
 * - 一次调用都有超时与输出上限，失败以 `{ ok: false, error }` 表达，不抛给 IPC 层。
 */
import type {
  LarkActionResult,
  LarkAdminAction,
  LarkAdminResults,
  LarkLoginStart,
  LarkProfileView,
  LarkStatusView,
} from '@workbench/protocol/ipc'
import type { SpawnFn, Spawned } from '@workbench/capabilities/types'
import { defaultSpawn } from './process'
import { resolveExecutable } from './executable'

/** 与通道同口径：不继承别的 agent 留下的工作区变量（见 `plugins/channels/feishu/lark.ts`）。 */
export const LARK_ENV_UNSET = ['HERMES_HOME', 'OPENCLAW_HOME', 'LARK_CHANNEL'] as const

/** 单次 CLI 调用的超时（毫秒）：登录轮询会等用户在浏览器点授权，给足 60 s。 */
export const LARK_ADMIN_TIMEOUT_MS = 60_000

/** 输出上限（字节）：CLI 的 JSON 都很小，这个上限只防意外吐日志。 */
const OUTPUT_LIMIT = 262_144

/** 错误文案里保留的输出尾部（字符）。 */
const ERROR_TAIL = 400

export interface LarkAdminOptions {
  /** 子进程启动函数（测试注入假实现） */
  spawn?: SpawnFn
  /** 宿主环境（缺省 `process.env`；测试注入可控环境） */
  env?: NodeJS.ProcessEnv
  /** 诊断日志（不记 secret、不记完整输出） */
  log?: (line: string) => void
  timeoutMs?: number
}

export interface LarkAdmin {
  status(): Promise<LarkStatusView>
  /** 新建 profile（app id + secret 都来自用户；secret 只经 stdin 交给 CLI） */
  addProfile(input: {
    name: string
    appId: string
    secret: string
    brand?: string
  }): Promise<LarkActionResult>
  /** 设备码登录第一步：拿到验证链接与 device code */
  loginStart(input: { profile?: string; domain?: string }): Promise<LarkLoginStart>
  /** 设备码登录第二步：用户在浏览器授权后轮询完成 */
  loginPoll(input: { profile?: string; deviceCode: string }): Promise<LarkActionResult>
  /** 退出登录（清掉该 profile 的 token；配置保留） */
  logout(input: { profile?: string }): Promise<LarkActionResult>
  /** 删掉本机的一个 profile（CLI 会连带清掉它的 app secret 与 token，不可撤销） */
  removeProfile(input: { name: string }): Promise<LarkActionResult>
}

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const tail = (text: string, limit: number): string =>
  text.length > limit ? `…${text.slice(-limit)}` : text

/** Windows 下 `.cmd` / `.bat` 需要经 shell 启动。 */
const needsShell = (file: string): boolean => /\.(cmd|bat)$/i.test(file)

/** profile 名只允许安全字符且不能以 `-` 开头（它要进 argv，`--` 开头会被当成参数）。 */
export const LARK_PROFILE_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/

/** app id 形状（飞书自建应用 `cli_` 开头，lark 国际版同样）；只挡明显非法的输入。 */
export const LARK_APP_ID_PATTERN = /^[A-Za-z0-9_]{4,64}$/

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  error: string | null
}

/** 跑一次 CLI：收集输出，超时/启动失败都折算成 `error`（不抛）。 */
function run(
  spawn: SpawnFn,
  env: NodeJS.ProcessEnv,
  program: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<RunResult> {
  const resolved = resolveExecutable(program)
  if (resolved.path === null) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: '',
      error: `找不到 ${program}：${resolved.error ?? '未在 PATH 中'}`,
    })
  }

  let child: Spawned
  try {
    child = spawn(resolved.path, args, {
      shell: needsShell(resolved.path),
      env,
    })
  } catch (error) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', error: errMsg(error) })
  }

  const stdout: string[] = []
  const stderr: string[] = []
  let length = 0

  return new Promise<RunResult>((resolve) => {
    let settled = false
    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({
        code: null,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        error: `${program} 超时（>${timeoutMs}ms）`,
      })
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: unknown) => {
      if (length >= OUTPUT_LIMIT) return
      const text = String(chunk)
      length += text.length
      stdout.push(text)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      stderr.push(String(chunk))
    })
    child.onClose((code) => {
      finish({ code, stdout: stdout.join(''), stderr: stderr.join(''), error: null })
    })
    child.onError((error) => {
      finish({ code: null, stdout: stdout.join(''), stderr: stderr.join(''), error: errMsg(error) })
    })
    // 无论有没有 stdin 正文都关掉它：CLI 以 stdin 关闭作为「输入结束」的信号
    if (child.stdin !== null && stdin !== undefined && stdin !== '') child.stdin.write(stdin)
    child.stdin?.end()
  })
}

/** 解析一段 JSON（对象或数组）；失败返回 null。 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** CLI 的错误信封（`{ok:false,error:{message}}`）→ 一句可读文案；成功返回 null。 */
export function failureOf(text: string): string | null {
  const parsed = parseJson(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record['ok'] !== false && record['error'] === undefined) return null
  const error = record['error']
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string' && message.trim() !== '') return message.trim()
  }
  return tail(JSON.stringify(error ?? record), ERROR_TAIL)
}

/** CLI 的进度日志行（`[lark-cli] …`）不是错误：错误文本里先把它们剔掉，只留真正的原因行。 */
export function reasonLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('[lark-cli]'))
}

/** 输出里可能夹着日志与 JSON 帧：整段不是 JSON 时逐行再找一次失败信封。 */
function errorFrameOf(text: string): string | null {
  const whole = failureOf(text)
  if (whole !== null) return whole
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    const found = failureOf(trimmed)
    if (found !== null) return found
  }
  return null
}

/**
 * 非零退出的可读原因。
 *
 * 为什么不能直接贴 stderr：`lark-cli` 会把进度日志打到 stderr（设备码登录时是
 * `[lark-cli] device-flow: token response received`），直接截取开头就会把一句日志
 * 当成失败原因报给用户——既不是错误，也看不出该做什么。顺序是：
 * 失败信封 → 剔掉日志后的剩余行 → 带退出码的兜底建议。
 */
export function exitReason(code: number | null, stdout: string, stderr: string): string {
  const frame = errorFrameOf(stdout) ?? errorFrameOf(stderr)
  if (frame !== null) return frame
  const lines = [...reasonLines(stderr), ...reasonLines(stdout)]
  if (lines.length === 0) {
    return `lark-cli 退出码 ${code ?? '未知'}，没有给出原因：稍后再试一次；反复失败就重新发起登录`
  }
  return tail(lines.join('\n'), ERROR_TAIL)
}

/** `config show` 的文本输出（人读格式）→ 工作区 / 应用 / 配置文件路径。 */
export function parseConfigShow(text: string): {
  workspace: string | null
  appId: string | null
  configPath: string | null
} {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const body = start >= 0 && end > start ? parseJson(text.slice(start, end + 1)) : null
  const record =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  const pick = (key: string): string | null => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  const pathMatch = /Config file path:\s*(.+)$/mu.exec(text)
  return {
    workspace: pick('workspace'),
    appId: pick('appId'),
    configPath: pathMatch?.[1]?.trim() ?? null,
  }
}

/** `whoami` 的对象输出 → 应用与身份。 */
export function parseWhoami(text: string): {
  appId: string | null
  identity: string | null
  available: boolean
  tokenStatus: string | null
  profile: string | null
} {
  const parsed = parseJson(text)
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  const pick = (key: string): string | null => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  return {
    appId: pick('appId'),
    identity: pick('identity'),
    available: record['available'] === true,
    tokenStatus: pick('tokenStatus'),
    profile: pick('profile'),
  }
}

/** `profile list` 的数组输出 → 视图行。 */
export function parseProfiles(text: string): LarkProfileView[] {
  const parsed = parseJson(text)
  if (!Array.isArray(parsed)) return []
  const rows: LarkProfileView[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const name = typeof record['name'] === 'string' ? record['name'] : ''
    if (name === '') continue
    rows.push({
      name,
      appId: typeof record['appId'] === 'string' ? record['appId'] : name,
      brand: typeof record['brand'] === 'string' ? record['brand'] : 'feishu',
      active: record['active'] === true,
      user: typeof record['user'] === 'string' && record['user'] !== '' ? record['user'] : null,
      tokenStatus:
        typeof record['tokenStatus'] === 'string' && record['tokenStatus'] !== ''
          ? record['tokenStatus']
          : null,
    })
  }
  return rows
}

/** 设备码登录输出 → 链接与 device code（字段名取自 `auth login --no-wait --json`）。 */
export function parseLoginStart(text: string): LarkLoginStart {
  const failure = failureOf(text)
  if (failure !== null) return { ok: false, error: failure }
  const parsed = parseJson(text)
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  const url = record['verification_url']
  const code = record['device_code']
  if (typeof url !== 'string' || url === '' || typeof code !== 'string' || code === '') {
    return { ok: false, error: '登录没有返回验证链接，稍后重试' }
  }
  const expires = record['expires_in']
  return {
    ok: true,
    verificationUrl: url,
    deviceCode: code,
    ...(typeof expires === 'number' ? { expiresIn: expires } : {}),
  }
}

/** 组装 `lark-cli [--profile X] …` 的 argv 前缀。 */
export function profileArgs(profile: string | null): string[] {
  return profile === null ? [] : ['--profile', profile]
}

/** 动作名集合（IPC 边界校验用；渲染层的 action 是外部输入，不能当已校验数据）。 */
const ACTIONS = [
  'status',
  'add-profile',
  'login-start',
  'login-poll',
  'logout',
  'remove-profile',
] as const

/**
 * 动作名守卫：判定的同时把类型收窄到联合值。
 *
 * 有了它，下面的 `switch (action)` 是穷尽的（六个 case 覆盖全部取值），
 * 不需要「不可达的 default」——那条兜底以前既走不到，也让穷尽性失去了类型保证。
 */
const isActionName = (value: string): value is LarkAdminAction['action'] =>
  (ACTIONS as readonly string[]).includes(value)

/**
 * 校验一条来自 renderer 的动作：只认上表里的动作名，必要字符串字段必须是字符串。
 *
 * 非法输入返回 `null`（调用方回 `{ok:false}`），不抛给 IPC —— 一次坏请求不该让窗口看到异常栈。
 */
export function asLarkAction(value: unknown): LarkAdminAction | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const action = record['action']
  if (typeof action !== 'string' || !isActionName(action)) return null
  const text = (key: string): string | null => {
    const raw = record[key]
    if (raw === undefined) return null
    return typeof raw === 'string' ? raw : null
  }
  const malformed = (key: string): boolean =>
    record[key] !== undefined && typeof record[key] !== 'string'
  switch (action) {
    case 'status':
      return { action: 'status' }
    case 'add-profile': {
      if (malformed('name') || malformed('appId') || malformed('secret') || malformed('brand')) {
        return null
      }
      const name = text('name')
      const appId = text('appId')
      const secret = text('secret')
      if (name === null || appId === null || secret === null) return null
      const brand = text('brand')
      return {
        action: 'add-profile',
        name,
        appId,
        secret,
        ...(brand === null ? {} : { brand }),
      }
    }
    case 'login-start': {
      if (malformed('profile') || malformed('domain')) return null
      const profile = text('profile')
      const domain = text('domain')
      return {
        action: 'login-start',
        ...(profile === null ? {} : { profile }),
        ...(domain === null ? {} : { domain }),
      }
    }
    case 'login-poll': {
      if (malformed('profile') || malformed('deviceCode')) return null
      const profile = text('profile')
      const deviceCode = text('deviceCode')
      if (deviceCode === null) return null
      return { action: 'login-poll', deviceCode, ...(profile === null ? {} : { profile }) }
    }
    case 'logout': {
      if (malformed('profile')) return null
      const profile = text('profile')
      return { action: 'logout', ...(profile === null ? {} : { profile }) }
    }
    case 'remove-profile': {
      const name = text('name')
      if (name === null || malformed('name')) return null
      return { action: 'remove-profile', name }
    }
  }
}

/** 执行一条已校验的动作（IPC 与测试共用这一处分发）。 */
export async function runLarkAction<A extends LarkAdminAction>(
  admin: LarkAdmin,
  action: A,
): Promise<LarkAdminResults[A['action']]> {
  switch (action.action) {
    case 'status':
      return (await admin.status()) as LarkAdminResults[A['action']]
    case 'add-profile':
      return (await admin.addProfile({
        name: action.name,
        appId: action.appId,
        secret: action.secret,
        ...(action.brand === undefined ? {} : { brand: action.brand }),
      })) as LarkAdminResults[A['action']]
    case 'login-start':
      return (await admin.loginStart({
        ...(action.profile === undefined ? {} : { profile: action.profile }),
        ...(action.domain === undefined ? {} : { domain: action.domain }),
      })) as LarkAdminResults[A['action']]
    case 'login-poll':
      return (await admin.loginPoll({
        deviceCode: action.deviceCode,
        ...(action.profile === undefined ? {} : { profile: action.profile }),
      })) as LarkAdminResults[A['action']]
    case 'remove-profile':
      return (await admin.removeProfile({
        name: action.name,
      })) as LarkAdminResults[A['action']]
    default:
      return (await admin.logout({
        ...(action.profile === undefined ? {} : { profile: action.profile }),
      })) as LarkAdminResults[A['action']]
  }
}

/** 探测 / 动作实现。 */
export function createLarkAdmin(options: LarkAdminOptions = {}): LarkAdmin {
  const spawn = options.spawn ?? defaultSpawn
  const hostEnv = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? LARK_ADMIN_TIMEOUT_MS
  const log = options.log ?? ((line: string): void => console.warn(line))
  const program = 'lark-cli'

  /** 剔除别的 agent 身份后的环境（工作台真正会用的那套） */
  const ownEnv: NodeJS.ProcessEnv = { ...hostEnv }
  for (const key of LARK_ENV_UNSET) delete ownEnv[key]

  const call = async (args: string[], stdin?: string): Promise<RunResult> =>
    run(spawn, ownEnv, program, args, stdin, timeoutMs)

  /** 别的 agent 的绑定：把「有别的 agent 身份变量」的宿主环境也跑一次（只为比较） */
  const foreignOf = async (): Promise<{
    workspace: string | null
    appId: string | null
  } | null> => {
    const hasForeign = LARK_ENV_UNSET.some((key) => {
      const value = hostEnv[key]
      return typeof value === 'string' && value !== ''
    })
    if (!hasForeign) return null
    const result = await run(spawn, hostEnv, program, ['config', 'show'], undefined, timeoutMs)
    if (result.error !== null) return null
    const parsed = parseConfigShow(result.stdout)
    if (parsed.workspace === null && parsed.appId === null) return null
    return { workspace: parsed.workspace, appId: parsed.appId }
  }

  /** 登录后复查：设备码轮询可能「一 token 到手就写存储失败 / 抢锁超时」而非零退出 */
  const tokenReadyOf = async (profile: string | null): Promise<boolean> => {
    const probe = await call([...profileArgs(profile), 'whoami'])
    if (probe.error !== null || probe.code !== 0) return false
    const parsed = parseWhoami(probe.stdout)
    return parsed.available && parsed.tokenStatus !== null
  }

  return {
    async status() {
      const empty: LarkStatusView = {
        ok: false,
        program: null,
        error: null,
        workspace: null,
        appId: null,
        identity: null,
        available: false,
        tokenStatus: null,
        profiles: [],
        foreign: null,
        conflict: false,
        hint: null,
      }
      const resolved = resolveExecutable(program)
      if (resolved.path === null) {
        return {
          ...empty,
          error: `找不到 lark-cli：${resolved.error ?? '未在 PATH 中'}`,
          hint: '先安装 lark-cli 并执行一次登录（npm i -g @larksuite/cli && lark-cli auth login）',
        }
      }

      const [show, who, list] = await Promise.all([
        call(['config', 'show']),
        call(['whoami']),
        call(['profile', 'list']),
      ])
      const showParsed = show.error === null ? parseConfigShow(show.stdout) : null
      const whoParsed = who.error === null ? parseWhoami(who.stdout) : null
      const foreign = await foreignOf()
      const appId = whoParsed?.appId ?? showParsed?.appId ?? null
      const conflict = foreign !== null && appId !== null && foreign.appId === appId
      const profiles = list.error === null ? parseProfiles(list.stdout) : []
      const failure = show.error ?? who.error ?? list.error

      return {
        ok: failure === null,
        program: resolved.path,
        error: failure,
        workspace: showParsed?.workspace ?? null,
        appId,
        identity: whoParsed?.identity ?? null,
        available: whoParsed?.available === true,
        tokenStatus: whoParsed?.tokenStatus ?? null,
        profiles,
        foreign,
        conflict,
        hint:
          failure !== null
            ? '先执行一次 `lark-cli auth login`（或下面的登录按钮），再回来看状态'
            : conflict
              ? '工作台与别的 agent 用的是同一个飞书应用：两边会抢同一条事件长连接。给工作台换一个应用（新建连接）'
              : profiles.length === 0
                ? '本机还没有飞书 profile：先在飞书开放平台建一个自建应用，再在这里新建连接'
                : null,
      }
    },

    async addProfile(input) {
      const name = input.name.trim()
      const appId = input.appId.trim()
      if (!LARK_PROFILE_PATTERN.test(name)) {
        return { ok: false, error: '连接标识只能用字母、数字、下划线、连字符与点（≤64 字）' }
      }
      if (!LARK_APP_ID_PATTERN.test(appId)) {
        return { ok: false, error: 'App ID 形状不对（应形如 cli_xxxxxxxx）' }
      }
      if (input.secret.trim() === '') return { ok: false, error: 'App Secret 不能为空' }

      const result = await call(
        [
          'profile',
          'add',
          '--name',
          name,
          '--app-id',
          appId,
          '--brand',
          input.brand === 'lark' ? 'lark' : 'feishu',
          '--app-secret-stdin',
        ],
        input.secret.trim(),
      )
      if (result.error !== null) return { ok: false, error: result.error }
      const failure = failureOf(result.stdout) ?? failureOf(result.stderr)
      if (failure !== null) return { ok: false, error: failure }
      if (result.code !== 0) {
        return { ok: false, error: exitReason(result.code, result.stdout, result.stderr) }
      }
      log(`[lark-admin] 已新建 profile ${name}（app ${appId}）`)
      return { ok: true }
    },

    async loginStart(input) {
      const profile = input.profile?.trim() ?? ''
      if (profile !== '' && !LARK_PROFILE_PATTERN.test(profile)) {
        return { ok: false, error: 'profile 名非法' }
      }
      const domain = input.domain?.trim() ?? ''
      const args = [
        ...profileArgs(profile === '' ? null : profile),
        'auth',
        'login',
        '--no-wait',
        '--json',
        '--domain',
        domain === '' ? 'im' : domain,
      ]
      const result = await call(args, '')
      if (result.error !== null) return { ok: false, error: result.error }
      if (result.code !== 0) {
        // stdout 里可能已经带着链接（CLI 先打印再非零退出）：能解析就照样算给出链接
        const parsed = parseLoginStart(result.stdout)
        if (parsed.ok) return parsed
        return { ok: false, error: exitReason(result.code, result.stdout, result.stderr) }
      }
      return parseLoginStart(result.stdout)
    },

    async loginPoll(input) {
      const profile = input.profile?.trim() ?? ''
      if (profile !== '' && !LARK_PROFILE_PATTERN.test(profile)) {
        return { ok: false, error: 'profile 名非法' }
      }
      if (input.deviceCode.trim() === '') return { ok: false, error: '缺少 device code' }
      const result = await call(
        [
          ...profileArgs(profile === '' ? null : profile),
          'auth',
          'login',
          '--device-code',
          input.deviceCode.trim(),
          '--json',
        ],
        '',
      )
      if (result.error !== null) return { ok: false, error: result.error }
      const failure = failureOf(result.stdout) ?? failureOf(result.stderr)
      if (failure !== null) return { ok: false, error: failure }
      if (result.code !== 0) {
        // 退出码非零 ≠ 登录没成：CLI 拿到 token 之后写存储失败 / 抢锁超时也会非零退出。
        // 复查一次本机状态，token 真的在就当成功，别让人对着一个红条重复点。
        if (await tokenReadyOf(profile === '' ? null : profile)) return { ok: true }
        return { ok: false, error: exitReason(result.code, result.stdout, result.stderr) }
      }
      return { ok: true }
    },

    async logout(input) {
      const profile = input.profile?.trim() ?? ''
      if (profile !== '' && !LARK_PROFILE_PATTERN.test(profile)) {
        return { ok: false, error: 'profile 名非法' }
      }
      const result = await call(
        [...profileArgs(profile === '' ? null : profile), 'auth', 'logout'],
        '',
      )
      if (result.error !== null) return { ok: false, error: result.error }
      const failure = failureOf(result.stdout) ?? failureOf(result.stderr)
      if (failure !== null) return { ok: false, error: failure }
      if (result.code !== 0) {
        return { ok: false, error: exitReason(result.code, result.stdout, result.stderr) }
      }
      return { ok: true }
    },

    async removeProfile(input) {
      const name = input.name.trim()
      if (!LARK_PROFILE_PATTERN.test(name)) {
        return { ok: false, error: 'profile 名非法' }
      }
      // 位置参数：`lark-cli profile remove <name>`，不带 `--profile`（那是指「用哪个 profile 跑」）
      const result = await call(['profile', 'remove', name], '')
      if (result.error !== null) return { ok: false, error: result.error }
      const failure = failureOf(result.stdout) ?? failureOf(result.stderr)
      if (failure !== null) return { ok: false, error: failure }
      if (result.code !== 0) {
        return { ok: false, error: exitReason(result.code, result.stdout, result.stderr) }
      }
      log(`[lark-admin] 已删除 profile ${name}`)
      return { ok: true }
    },
  }
}
