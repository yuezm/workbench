/**
 * `lark-cli` 适配（`src/plugins/channels/feishu/lark.ts`）：出站发消息 / 原地更新 /
 * 读登录人 / 长连接收卡片回调。
 *
 * 为什么要 CLI 而不是直连 OpenAPI：卡片按钮的回调要么公网可回的 URL、要么 WebSocket 长连接，
 * 桌面工作台两者都不该自己实现；`lark-cli` 已经持有应用凭证、维护长连接、并把回调打印成
 * 一行一个 JSON。插件只负责把 `card` 交给它、把它的 stdout 行读成答案。
 *
 * 边界：
 * - 子进程只经 `ctx.sdk.process`（`resolve` / `spawn`）启动，**不 import node 内置**；
 * - 卡片 JSON 整串作为 `--content` / `--data` 的参数与 stdin，不拼进 shell 字符串；
 * - 一次性命令都有超时与输出上限；失败以 reject 表达（调用方只记日志，不伪造送达）。
 */
import type { ChannelSdk, ChannelSpawned } from '@workbench/protocol/channels'
import { createLineReader, parseFrame } from '@workbench/plugins-kit/jsonl'

/** 一次性命令的超时（毫秒）：lark-cli 发消息正常在秒级，30 s 已经是很差的网络。 */
export const LARK_TIMEOUT_MS = 30_000

/** stdout 收集上限（字节）：卡片返回体很小，这个上限只防 CLI 意外吐日志。 */
export const STDOUT_LIMIT = 1_048_576

/** 错误信息里保留的 stderr / 输出尾部长度（字符）。 */
const ERROR_TAIL = 500

/** 发消息的目标：私聊用 open_id，群聊用 chat_id。 */
export interface LarkTarget {
  kind: 'user' | 'chat'
  id: string
}

/**
 * 必须从子进程环境里剔除的「别的 agent 的身份」变量（M45）。
 *
 * `lark-cli` 会按 `HERMES_HOME` / `OPENCLAW_HOME` 自动把当前会话绑定到对方的工作区
 * （`lark-cli config bind --source hermes`）——工作台原样继承宿主环境时看到的其实是
 * hermes 的应用与登录态：两个程序争同一个飞书应用的事件长连接（后启动的一方
 * `failed_precondition`），发出去的消息也落在对方的机器人上。
 *
 * 剔除后 CLI 落回本机默认工作区（`~/.lark-cli/config.json`），再配合 `--profile` 就是
 * 一套**与别的 agent 完全分开**的应用与事件总线。
 */
export const LARK_ENV_UNSET = ['HERMES_HOME', 'OPENCLAW_HOME', 'LARK_CHANNEL'] as const

/** 子进程环境的增量修改（与 `protocol/channels` 的 `envPatch` 同形）。 */
export interface LarkEnvPatch {
  unset?: readonly string[]
  set?: Record<string, string>
}

export interface LarkOptions {
  sdk: ChannelSdk
  /** CLI 命令名或绝对路径（默认 `lark-cli`） */
  program: string
  log: (line: string) => void
  timeoutMs?: number
  /** 继承环境的增删（缺省 `{ unset: LARK_ENV_UNSET }`：不继承别的 agent 的工作区） */
  envPatch?: LarkEnvPatch
}

export interface Lark {
  /** 发一张 interactive 卡片，返回 `message_id`（`--idempotency-key` 防重复发） */
  send(target: LarkTarget, cardJson: string, idempotencyKey: string): Promise<string>
  /** 更新已发出的卡片（同一 `message_id` 原地刷新） */
  patch(messageId: string, cardJson: string): Promise<void>
  /** 当前登录人的 open_id（私聊默认接收人） */
  owner(): Promise<string>
  /** 订阅卡片点击：每行事件交给 `onEvent`；进程退出调用 `onExit`；返回停止函数 */
  watchClicks(
    onEvent: (event: Record<string, unknown>) => void,
    onExit: (reason: string) => void,
  ): () => void
}

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 取文本尾部（错误信息里只留能定位问题的那一段）。 */
const tail = (text: string, limit: number): string =>
  text.length > limit ? `…${text.slice(-limit)}` : text

/** Windows 下 `.cmd` / `.bat` 需要经 shell 启动（与宿主 `needsShell` 同判据）。 */
export const needsShell = (file: string): boolean => /\.(cmd|bat)$/i.test(file)

/**
 * 配置里的 `lark` 允许带前置参数：`lark-cli --profile work2`。
 *
 * 为什么要这个：飞书**一个应用全局只允许一处事件长连接**，要同时接多个应用就得换一个
 * profile（另一套应用凭证）。只解析出「命令 + 前置参数」，其余 argv 由插件自己拼。
 */
export function programArgs(program: string): { command: string; prefix: string[] } {
  const parts = program
    .trim()
    .split(/\s+/u)
    .filter((part) => part !== '')
  if (parts.length === 0) return { command: program, prefix: [] }
  const [command, ...prefix] = parts
  return { command, prefix }
}

/** 一次性的 CLI 调用：收集 stdout，非零退出 / 超时 / 启动失败都以 reject 表达。 */
function runOnce(
  sdk: ChannelSdk,
  program: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
  envPatch: LarkEnvPatch,
): Promise<string> {
  const resolved = sdk.process.resolve(program)
  if (resolved.path === null) {
    return Promise.reject(new Error(`找不到 ${program}：${resolved.error ?? '未在 PATH 中'}`))
  }

  let child: ChannelSpawned
  try {
    child = sdk.process.spawn(resolved.path, args, {
      shell: needsShell(resolved.path),
      envPatch,
    })
  } catch (error) {
    return Promise.reject(error)
  }

  const stdout: string[] = []
  const stderr: string[] = []
  let stdoutLength = 0

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (outcome: { ok: true } | { ok: false; error: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (outcome.ok) resolve(stdout.join(''))
      else reject(outcome.error)
    }

    const timer = setTimeout(() => {
      // 先结算「超时」再收尸：终止进程会同步触发 close，晚一步就会被写成「退出码 …」
      finish({ ok: false, error: new Error(`${program} 超时（>${timeoutMs}ms）`) })
      if (child.pid !== undefined) sdk.process.killTree(child.pid)
      else child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: unknown) => {
      if (stdoutLength >= STDOUT_LIMIT) return
      const text = String(chunk)
      stdoutLength += text.length
      stdout.push(text)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      stderr.push(String(chunk))
    })
    child.onClose((code) => {
      if (code === 0) {
        finish({ ok: true })
        return
      }
      finish({
        ok: false,
        error: new Error(
          `${program} ${args.slice(0, 2).join(' ')} 退出码 ${String(code)}：${tail(stderr.join('').trim(), ERROR_TAIL)}`,
        ),
      })
    })
    child.onError((error) => {
      finish({ ok: false, error })
    })
    // 无论有没有 stdin 正文都关掉它：CLI 以 stdin 关闭作为「输入结束」的信号
    child.stdin?.end(stdin)
  })
}

/** 解析 CLI 的 JSON 输出：`ok:false` / `error` 视为失败，`data` 由调用方取。 */
function parseOutput(program: string, args: string[], output: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(
      `${program} ${args.slice(0, 2).join(' ')} 输出不是 JSON：${tail(output.trim(), ERROR_TAIL)}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${program} 输出不是对象：${tail(output.trim(), ERROR_TAIL)}`)
  }
  const record = parsed as Record<string, unknown>
  if (record['ok'] === false || record['error'] !== undefined) {
    throw new Error(
      `${program} ${args.slice(0, 2).join(' ')} 失败：${tail(JSON.stringify(record['error'] ?? record), ERROR_TAIL)}`,
    )
  }
  return record
}

/** 从 `data`（或顶层）取一个字符串字段；没有就返回 null。 */
function stringField(record: Record<string, unknown>, key: string): string | null {
  const data = record['data']
  const nested =
    data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null
  const value = nested?.[key] ?? record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** 从 `auth status` 的输出里取登录人 open_id（`identities.user.openId`，可能在 `data` 里）。 */
export function ownerOf(status: Record<string, unknown>): string | null {
  const data = status['data']
  const roots = [
    status,
    data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null,
  ]
  for (const root of roots) {
    if (root === null) continue
    const identities = root['identities']
    if (identities === null || typeof identities !== 'object') continue
    const user = (identities as Record<string, unknown>)['user']
    if (user === null || typeof user !== 'object') continue
    const openId = (user as Record<string, unknown>)['openId']
    if (typeof openId === 'string' && openId !== '') return openId
  }
  return null
}

/** 构造 `lark-cli` 适配器（不启动任何进程：`send` / `owner` / `watchClicks` 才 spawn）。 */
export function createLark(options: LarkOptions): Lark {
  const { sdk, program, log } = options
  const timeoutMs = options.timeoutMs ?? LARK_TIMEOUT_MS
  // M45：默认不继承别的 agent 的工作区变量（否则 CLI 会切到 hermes 的应用上）
  const envPatch: LarkEnvPatch = options.envPatch ?? { unset: LARK_ENV_UNSET }
  // `lark-cli --profile work2`：命令与前置参数分开，其余 argv 由各方法自己拼
  const { command, prefix } = programArgs(program)

  const runJson = async (args: string[], stdin?: string): Promise<Record<string, unknown>> => {
    const output = await runOnce(sdk, command, [...prefix, ...args], stdin, timeoutMs, envPatch)
    return parseOutput(program, args, output)
  }

  return {
    async send(target, cardJson, idempotencyKey) {
      const to = target.kind === 'chat' ? ['--chat-id', target.id] : ['--user-id', target.id]
      const args = [
        'im',
        '+messages-send',
        ...to,
        '--as',
        'bot',
        '--msg-type',
        'interactive',
        '--idempotency-key',
        idempotencyKey,
        '--content',
        cardJson,
      ]
      const output = await runJson(args)
      const messageId = stringField(output, 'message_id')
      if (messageId === null) throw new Error(`${program} 未返回 message_id`)
      return messageId
    },

    async patch(messageId, cardJson) {
      // content 字段是「卡片 JSON 的字符串」，由 `--data -` 走 stdin（不进命令行）
      await runJson(
        ['im', 'messages', 'patch', '--message-id', messageId, '--as', 'bot', '--data', '-'],
        JSON.stringify({ content: cardJson }),
      )
    },

    async owner() {
      const status = await runJson(['auth', 'status'], '')
      const openId = ownerOf(status)
      if (openId === null) throw new Error('lark-cli 未登录（先执行 lark-cli auth login）')
      return openId
    },

    watchClicks: (onEvent, onExit) => watch(onEvent, onExit),
  }

  /**
   * 订阅卡片点击的长连接消费进程（`card.action.trigger`）。
   *
   * 一行一个 JSON：非 JSON 行是 CLI 的诊断输出，只记日志不当事件。`stop()` 之后的退出
   * 与新进程无关——不回报，否则宿主会重拉一个刚被停掉的监听。
   */
  function watch(
    onEvent: (event: Record<string, unknown>) => void,
    onExit: (reason: string) => void,
  ): () => void {
    const resolved = sdk.process.resolve(command)
    if (resolved.path === null) {
      onExit(`找不到 ${command}：${resolved.error ?? '未在 PATH 中'}`)
      return () => undefined
    }

    let child: ChannelSpawned
    try {
      child = sdk.process.spawn(
        resolved.path,
        [...prefix, 'event', 'consume', 'card.action.trigger', '--as', 'bot'],
        { shell: needsShell(resolved.path), envPatch },
      )
    } catch (error) {
      onExit(errMsg(error))
      return () => undefined
    }

    const reader = createLineReader((line) => {
      const event = parseFrame(line)
      if (event === null) {
        log(`[lark-cli] ${tail(line, ERROR_TAIL)}`)
        return
      }
      onEvent(event)
    })
    child.stdout?.on('data', (chunk: unknown) => {
      reader.push(String(chunk))
    })
    child.stderr?.on('data', (chunk: unknown) => {
      const text = String(chunk).trim()
      if (text !== '') log(`[lark-cli] ${tail(text, ERROR_TAIL)}`)
    })
    let stopped = false
    child.onError((error) => {
      if (!stopped) onExit(errMsg(error))
    })
    child.onClose((code) => {
      reader.flush()
      if (!stopped) onExit(`监听进程退出（退出码 ${String(code)}）`)
    })

    return () => {
      stopped = true
      child.kill('SIGTERM')
    }
  }
}
