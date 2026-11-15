// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type {
  ChannelAnswerOutcome,
  ChannelProcess,
  ChannelSdk,
  ChannelSpawnOptions,
  ChannelSpawned,
  ChannelStdout,
} from '../../../src/protocol/channels'
import type { ProcessCapability } from '../../../src/sdk/types'
import type { Card } from '../../../src/protocol/entities'
import { readClick } from '../../../src/plugins/channels/feishu/click'
import {
  answerersOf,
  clipProgress,
  feishuChannel,
  idempotencyKeyOf,
  PROGRESS_CHARS,
  readFeishuConfig,
  targetOf,
  WATCH_RESTART_MS,
} from '../../../src/plugins/channels/feishu/index'
import { readTextMessage } from '../../../src/plugins/channels/feishu/inbound'
import {
  createLark,
  LARK_TIMEOUT_MS,
  needsShell,
  ownerOf,
  programArgs,
  STDOUT_LIMIT,
  type Lark,
} from '../../../src/plugins/channels/feishu/lark'
import { feishuManifest } from '../../../src/plugins/channels/feishu/manifest'
import {
  FEISHU_CARD_TEMPLATES,
  optionButton,
  renderCard,
  type FeishuCard,
} from '../../../src/plugins/channels/feishu/render'
import { channelById } from '../../../src/plugins/registry'
import { fakeSdk } from '../support/fake-sdk'
import { cardOf, channelHarness, type AnswerCall, type ChannelHarness } from './harness'

/**
 * 飞书通道（M42）：卡片渲染、CLI 适配、点击解析与 `start` 编排。
 *
 * 全部走假进程（`FakeChild`）：不发真消息、不连真长连接，只断言「命令怎么拼、卡片 JSON 长什么样、
 * 失败怎么记」。真实链路（`lark-cli` 登录态 + 飞书卡片回调）由人工验收覆盖，见 SPEC-plugins。
 */

const inst = (overrides: Partial<Card> = {}): Card => cardOf(overrides)

// ---------------------------------------------------------------- 假 CLI 进程

type Listener = (chunk: unknown) => void

/** 一次 CLI 调用的脚本化结果：`hang` 表示永不结束（超时/长连接用例）。 */
interface Behavior {
  stdout?: string
  stderr?: string
  code?: number | null
  error?: Error
  hang?: boolean
}

/** 假子进程：测试自己决定什么时候吐 stdout、什么时候退出。 */
class FakeChild implements ChannelSpawned {
  readonly pid: number | undefined

  constructor(pid: number | undefined) {
    this.pid = pid
  }
  readonly written: string[] = []
  readonly killed: string[] = []
  private readonly out = new Set<Listener>()
  private readonly err = new Set<Listener>()
  private errorCb: ((error: Error) => void) | null = null
  private closeCb: ((code: number | null, signal: string | null) => void) | null = null

  readonly stdin = {
    write: (chunk: string): void => {
      this.written.push(chunk)
    },
    end: (chunk?: string): void => {
      if (chunk !== undefined) this.written.push(chunk)
    },
  }

  readonly stdout: ChannelStdout = {
    on: (_event, listener) => {
      this.out.add(listener)
    },
  }

  readonly stderr: ChannelStdout = {
    on: (_event, listener) => {
      this.err.add(listener)
    },
  }

  onError(cb: (error: Error) => void): void {
    this.errorCb = cb
  }

  onClose(cb: (code: number | null, signal: string | null) => void): void {
    this.closeCb = cb
  }

  kill(signal?: string): void {
    this.killed.push(signal ?? 'SIGTERM')
    this.close(null)
  }

  emitStdout(text: string): void {
    for (const listener of [...this.out]) listener(text)
  }

  emitStderr(text: string): void {
    for (const listener of [...this.err]) listener(text)
  }

  emitError(error: Error): void {
    this.errorCb?.(error)
  }

  close(code: number | null): void {
    this.closeCb?.(code, null)
  }
}

interface FakeCli {
  process: ChannelProcess
  calls: Array<{ command: string; args: string[]; options: ChannelSpawnOptions }>
  children: FakeChild[]
  killTree: ReturnType<typeof vi.fn>
  push(behavior: Behavior): void
}

/** 假 `ChannelProcess`：按队列依次给出行为；`resolvePath` 为 null 表示命令找不到。 */
function fakeCli(
  options: {
    behaviors?: Behavior[]
    resolvePath?: string | null
    resolveError?: string | null
    /** null = 进程没有 pid（spawn 失败前的句柄） */
    pid?: number | null
  } = {},
): FakeCli {
  const behaviors = [...(options.behaviors ?? [])]
  const calls: FakeCli['calls'] = []
  const children: FakeChild[] = []
  const killTree = vi.fn(() => true)
  const resolvePath =
    options.resolvePath === undefined ? '/usr/local/bin/lark-cli' : options.resolvePath

  const proc: ChannelProcess = {
    resolve: (command) => ({
      path: resolvePath === null ? null : resolvePath.replace('lark-cli', command),
      error:
        resolvePath === null
          ? options.resolveError === undefined
            ? '未在 PATH 中'
            : options.resolveError
          : null,
    }),
    killTree,
    spawn: (command, args, opts) => {
      calls.push({ command, args, options: opts })
      const child = new FakeChild(options.pid === null ? undefined : (options.pid ?? 4_242))
      children.push(child)
      const behavior = behaviors.shift() ?? { hang: true }
      queueMicrotask(() => {
        if (behavior.error !== undefined) {
          child.emitError(behavior.error)
          return
        }
        if (behavior.stderr !== undefined) child.emitStderr(behavior.stderr)
        if (behavior.stdout !== undefined) child.emitStdout(behavior.stdout)
        if (behavior.hang !== true) child.close(behavior.code ?? 0)
      })
      return child
    },
  }

  return { process: proc, calls, children, killTree, push: (behavior) => behaviors.push(behavior) }
}

/** `createLark` 只经 `sdk.process` 拿子进程能力：这里把假 CLI 装进能力面。 */
function sdkOf(cli: FakeCli): ChannelSdk {
  return { ...fakeSdk(), process: cli.process }
}

/** 只测 `lark.ts` 时的最小 sdk：`createLark` 只要 sdk / program / log。 */
function larkOf(cli: FakeCli, timeoutMs?: number): Lark {
  return createLark({ sdk: sdkOf(cli), program: 'lark-cli', log: () => undefined, timeoutMs })
}

const okBody = (data: Record<string, unknown>): string => JSON.stringify({ ok: true, data })

// ---------------------------------------------------------------- 配置与渲染

describe('飞书通道 manifest 与注册', () => {
  it('manifest：id/kind/capabilities 符合通道契约（只声明 spawn）', () => {
    expect(feishuManifest.id).toBe('feishu')
    expect(feishuManifest.kind).toBe('channel')
    expect(feishuManifest.name).toBe('飞书')
    expect(feishuManifest.capabilities).toEqual(['spawn'])
    // M46：标量表单整体撤掉——派给谁 / 发到哪 / 谁能答都属于「一条连接」，
    // 由设置页的「飞书连接」面板独占（两边写同一个键会互相覆盖，留着只会让人以为填了也生效）。
    expect(feishuManifest.config ?? []).toEqual([])
    expect(channelById('feishu').plugin.start).toBeTypeOf('function')
  })
})

describe('飞书通道：配置归一化', () => {
  it('空配置：默认 lark-cli，接收人/群/名单都为空', () => {
    expect(readFeishuConfig({})).toEqual({
      program: 'lark-cli',
      user: null,
      chat: null,
      answerers: [],
      inbound: false,
    })
  })

  it('非字符串与空白值一律当没配（配置坏不该让通道不启动）', () => {
    expect(
      readFeishuConfig({ lark: '  ', user: 42, chat: '   ', answerers: null, agent: 7 }),
    ).toEqual({
      program: 'lark-cli',
      user: null,
      chat: null,
      answerers: [],
      inbound: false,
    })
  })

  it('answerers 支持中英文逗号/分号/空白分隔、去重并截到上限', () => {
    expect(readFeishuConfig({ answerers: ' ou_a,ou_b，ou_a; ou_c  ou_d ' }).answerers).toEqual([
      'ou_a',
      'ou_b',
      'ou_c',
      'ou_d',
    ])
    const many = Array.from({ length: 80 }, (_item, index) => `ou_${index}`).join(',')
    expect(readFeishuConfig({ answerers: many }).answerers).toHaveLength(50)
  })

  it('配了默认智能体才开入站（没配 = 只发卡片）', () => {
    expect(readFeishuConfig({}).inbound).toBe(false)
    expect(readFeishuConfig({ agent: '  ' }).inbound).toBe(false)
    expect(readFeishuConfig({ agent: ' a1 ' }).inbound).toBe(true)
  })

  it('trim 后的字符串配置项原样保留', () => {
    expect(
      readFeishuConfig({ lark: ' /opt/bin/lark-cli ', user: ' ou_u ', chat: ' oc_1 ' }),
    ).toEqual({
      program: '/opt/bin/lark-cli',
      user: 'ou_u',
      chat: 'oc_1',
      answerers: [],
      inbound: false,
    })
  })
})

describe('飞书通道：发到哪、谁能答、幂等键', () => {
  const base = readFeishuConfig({ user: 'ou_me' })

  it('targetOf：群优先 → 配置的接收人 → CLI 登录人；都没有就不投递', () => {
    expect(targetOf(readFeishuConfig({ user: 'ou_me', chat: 'oc_1' }), null)).toEqual({
      kind: 'chat',
      id: 'oc_1',
    })
    expect(targetOf(base, null)).toEqual({ kind: 'user', id: 'ou_me' })
    expect(targetOf(readFeishuConfig({}), 'ou_owner')).toEqual({ kind: 'user', id: 'ou_owner' })
    expect(targetOf(readFeishuConfig({}), null)).toBeNull()
  })

  it('answerersOf：名单优先；私聊退回接收人；群里没名单就没有合法答复人', () => {
    expect(
      answerersOf(readFeishuConfig({ answerers: 'ou_a,ou_b', user: 'ou_me' }), 'ou_owner'),
    ).toEqual(['ou_a', 'ou_b'])
    expect(answerersOf(base, null)).toEqual(['ou_me'])
    expect(answerersOf(readFeishuConfig({}), 'ou_owner')).toEqual(['ou_owner'])
    expect(answerersOf(readFeishuConfig({ chat: 'oc_1' }), 'ou_owner')).toEqual(['ou_owner'])
    expect(answerersOf(readFeishuConfig({ chat: 'oc_1' }), null)).toEqual([])
  })

  it('幂等键带卡片与版本，超长截到 50 字符', () => {
    expect(idempotencyKeyOf({ id: 'card-7', version: 3 })).toBe('wb-card-7-v3')
    const long = idempotencyKeyOf({ id: 'x'.repeat(80), version: 2 })
    expect(long).toHaveLength(50)
    expect(long.startsWith('wb-')).toBe(true)
  })
})

describe('飞书通道：卡片渲染', () => {
  it('ask 卡：蓝色标题、正文 markdown、分隔线、每个选项一个回调按钮', () => {
    const card = renderCard(inst({ options: ['方案 A', '方案 B'] }))

    expect(card.schema).toBe('2.0')
    expect(card.config).toEqual({ update_multi: true, enable_forward: false })
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: '选一个' },
      template: FEISHU_CARD_TEMPLATES.ask,
    })
    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: '用哪个方案？' },
      { tag: 'hr' },
      optionButton('card-1', '方案 A', 0),
      optionButton('card-1', '方案 B', 1),
    ])
  })

  it('按钮回传值只有卡片 id 与下标（答案由内核判定）', () => {
    expect(optionButton('card-1', '甲', 2).behaviors).toEqual([
      { type: 'callback', value: { card: 'card-1', choice: 2 } },
    ])
  })

  it('notice 卡：灰色标题、没有分隔线与按钮（只知会）', () => {
    const card = renderCard(inst({ kind: 'notice', options: [] }))

    expect(card.header.template).toBe(FEISHU_CARD_TEMPLATES.notice)
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: '用哪个方案？' }])
  })

  it('已答复：绿色标题、按钮消失、写明选了哪一项', () => {
    const card = renderCard(
      inst({ options: ['方案 A', '方案 B'], status: 'answered', optionIndex: 1 }),
    )

    expect(card.header.template).toBe(FEISHU_CARD_TEMPLATES.answered)
    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: '用哪个方案？' },
      { tag: 'hr' },
      { tag: 'markdown', content: '**已记录：方案 B**' },
    ])
  })

  it('在工作台答的：结论后标注来源（M43：同一张卡在两个地方看起来一致）', () => {
    const card = renderCard(
      inst({
        options: ['方案 A', '方案 B'],
        status: 'answered',
        optionIndex: 0,
        answeredBy: 'ui',
      }),
    )
    expect(card.body.elements.at(-1)).toEqual({
      tag: 'markdown',
      content: '**已记录：方案 A**（在工作台答复）',
    })
  })

  it('已关闭：灰色标题、按钮消失、写明不用再决定', () => {
    const card = renderCard(inst({ status: 'resolved' }))

    expect(card.header.template).toBe(FEISHU_CARD_TEMPLATES.resolved)
    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: '用哪个方案？' },
      { tag: 'hr' },
      { tag: 'markdown', content: '**已关闭，不用再决定**' },
    ])
  })

  it('已关闭的 notice 卡：文案是「已处理」（只知会的事没有「决定」）', () => {
    const card = renderCard(inst({ kind: 'notice', options: [], status: 'resolved' }))
    expect(card.body.elements.at(-1)).toEqual({ tag: 'markdown', content: '**已处理**' })
  })

  it('已答复但选项下标失效（老卡 / 越界）：给出可读的占位文案', () => {
    const card = renderCard(inst({ status: 'answered', optionIndex: 9 }))
    expect(card.body.elements.at(-1)).toEqual({
      tag: 'markdown',
      content: '**已记录：（选项已失效）**',
    })
  })

  it('没有正文时不留空 markdown 块（ask 直接给按钮，notice 给空 body）', () => {
    const ask = renderCard(inst({ text: '   ' }))
    // 正文为空就不放分隔线：第一块就是选项按钮
    expect(ask.body.elements[0]).toEqual(optionButton('card-1', 'A', 0))

    const notice = renderCard(inst({ kind: 'notice', options: [], text: '' }))
    expect(notice.body.elements).toEqual([])
  })

  it('渲染结果是可序列化对象（整串作为 CLI 参数）', () => {
    const json = JSON.stringify(renderCard(inst()))
    expect(JSON.parse(json)).toMatchObject<Partial<FeishuCard>>({ schema: '2.0' })
  })
})

// ---------------------------------------------------------------- 点击解析

describe('飞书通道：卡片点击解析', () => {
  const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    action_tag: 'button',
    action_value: { card: 'card-1', choice: 1 },
    operator_id: 'ou_a',
    message_id: 'om_1',
    ...over,
  })

  it('对象回传值与 JSON 字符串回传值都认', () => {
    expect(readClick(event())).toEqual({
      cardId: 'card-1',
      choice: 1,
      operator: 'ou_a',
      messageId: 'om_1',
    })
    expect(readClick(event({ action_value: '{"card":"card-9","choice":0}' }))).toEqual({
      cardId: 'card-9',
      choice: 0,
      operator: 'ou_a',
      messageId: 'om_1',
    })
  })

  it('缺 message_id 时 messageId 为 null（不影响计数）', () => {
    expect(readClick(event({ message_id: '' }))?.messageId).toBeNull()
  })

  it('非按钮组件、表单提交都不算答案', () => {
    expect(readClick(event({ action_tag: 'select_static' }))).toBeNull()
    expect(readClick(event({ form_value: '{"note":"x"}' }))).toBeNull()
  })

  it('空表单值（`{}` / 空串）不挡按钮回调', () => {
    expect(readClick(event({ form_value: '{}' }))).not.toBeNull()
    expect(readClick(event({ form_value: '  ' }))).not.toBeNull()
  })

  it('回传值非法（非 JSON / 缺字段 / 下标不是非负整数）一律忽略', () => {
    expect(readClick(event({ action_value: '{oops' }))).toBeNull()
    expect(readClick(event({ action_value: '' }))).toBeNull()
    expect(readClick(event({ action_value: null }))).toBeNull()
    expect(readClick(event({ action_value: { card: '', choice: 0 } }))).toBeNull()
    expect(readClick(event({ action_value: { card: 'card-1' } }))).toBeNull()
    expect(readClick(event({ action_value: { card: 'card-1', choice: 1.5 } }))).toBeNull()
    expect(readClick(event({ action_value: { card: 'card-1', choice: -1 } }))).toBeNull()
  })

  it('缺操作人时忽略（不知道是谁点的，不能计数）', () => {
    expect(readClick(event({ operator_id: undefined }))).toBeNull()
    expect(readClick(event({ operator_id: '   ' }))).toBeNull()
  })
})

// ---------------------------------------------------------------- lark-cli 适配

describe('飞书通道：lark-cli 适配', () => {
  it('ownerOf：identities.user.openId 在顶层或 data 里都认，缺则 null', () => {
    expect(ownerOf({ identities: { user: { openId: 'ou_1' } } })).toBe('ou_1')
    expect(ownerOf({ data: { identities: { user: { openId: 'ou_2' } } } })).toBe('ou_2')
    expect(ownerOf({})).toBeNull()
    expect(ownerOf({ identities: { user: {} } })).toBeNull()
    expect(ownerOf({ identities: null })).toBeNull()
    expect(ownerOf({ data: null })).toBeNull()
  })

  it('needsShell 只对 .cmd/.bat 为真（Windows shim）', () => {
    expect(needsShell('C:\\node\\lark-cli.cmd')).toBe(true)
    expect(needsShell('lark-cli.BAT')).toBe(true)
    expect(needsShell('/usr/local/bin/lark-cli')).toBe(false)
    expect(needsShell('lark-cli.ps1')).toBe(false)
  })

  it('send：argv 顺序固定、卡片 JSON 整串作参数、返回 message_id', async () => {
    const cli = fakeCli({ behaviors: [{ stdout: okBody({ message_id: 'om_9' }) }] })

    await expect(
      larkOf(cli).send({ kind: 'user', id: 'ou_a' }, '{"schema":"2.0"}', 'wb-card-1-v1'),
    ).resolves.toBe('om_9')

    expect(cli.calls[0].args).toEqual([
      'im',
      '+messages-send',
      '--user-id',
      'ou_a',
      '--as',
      'bot',
      '--msg-type',
      'interactive',
      '--idempotency-key',
      'wb-card-1-v1',
      '--content',
      '{"schema":"2.0"}',
    ])
    // env 省略 = 继承宿主环境：lark-cli 要读自己的登录态
    expect(cli.calls[0].options.env).toBeUndefined()
    expect(cli.calls[0].options.shell).toBe(false)
  })

  it('send：群目标用 --chat-id；返回体顶层给 message_id 也认', async () => {
    const cli = fakeCli({
      behaviors: [{ stdout: JSON.stringify({ ok: true, message_id: 'om_1' }) }],
    })

    await expect(larkOf(cli).send({ kind: 'chat', id: 'oc_1' }, '{}', 'k')).resolves.toBe('om_1')
    expect(cli.calls[0].args).toContain('--chat-id')
  })

  it('send：没给 message_id 视为失败（不能假定送达）', async () => {
    const cli = fakeCli({ behaviors: [{ stdout: okBody({}) }] })
    await expect(larkOf(cli).send({ kind: 'user', id: 'ou_a' }, '{}', 'k')).rejects.toThrow(
      /未返回 message_id/,
    )
  })

  it('patch：卡片 JSON 走 stdin（不进命令行）', async () => {
    const cli = fakeCli({ behaviors: [{ stdout: okBody({}) }] })

    await larkOf(cli).patch('om_1', '{"schema":"2.0"}')

    expect(cli.calls[0].args).toEqual([
      'im',
      'messages',
      'patch',
      '--message-id',
      'om_1',
      '--as',
      'bot',
      '--data',
      '-',
    ])
    expect(cli.children[0].written).toEqual(['{"content":"{\\"schema\\":\\"2.0\\"}"}'])
  })

  it('owner：读 auth status 的登录人；没登录时给出可读错误', async () => {
    const good = fakeCli({
      behaviors: [
        { stdout: JSON.stringify({ ok: true, identities: { user: { openId: 'ou_1' } } }) },
      ],
    })
    await expect(larkOf(good).owner()).resolves.toBe('ou_1')

    const bad = fakeCli({
      behaviors: [{ stdout: JSON.stringify({ ok: true, identities: { user: {} } }) }],
    })
    await expect(larkOf(bad).owner()).rejects.toThrow(/未登录/)
  })

  it('非零退出：错误里带 CLI 名与 stderr 尾部', async () => {
    const cli = fakeCli({ behaviors: [{ code: 3, stderr: 'no permission' }] })
    await expect(larkOf(cli).owner()).rejects.toThrow(/退出码 3：no permission/)
  })

  it('超时：终止进程树并按超时拒绝', async () => {
    vi.useFakeTimers()
    try {
      const cli = fakeCli({ behaviors: [{ hang: true }] })
      // 先接住结果再推进定时器：避免超时拒绝变成未处理的 rejection
      const settled = larkOf(cli)
        .owner()
        .then(
          () => 'resolved',
          (error: Error) => error.message,
        )
      await vi.advanceTimersByTimeAsync(LARK_TIMEOUT_MS)
      await expect(settled).resolves.toContain('超时')
      expect(cli.killTree).toHaveBeenCalledWith(4_242)
      // 超时之后进程才退出：迟到的 close 不再结算一次
      cli.children[0].close(0)
      await expect(settled).resolves.toContain('超时')
    } finally {
      vi.useRealTimers()
    }
  })

  it('找不到命令：不 spawn，直接给可读错误', async () => {
    const cli = fakeCli({ resolvePath: null })
    await expect(larkOf(cli).owner()).rejects.toThrow(/找不到 lark-cli/)
    expect(cli.calls).toHaveLength(0)
  })

  it('spawn 抛错：以该错误拒绝', async () => {
    const sdk = fakeSdk({
      resolve: () => ({ path: '/bin/lark-cli', error: null }),
      spawn: () => {
        throw new Error('spawn 失败')
      },
    })
    const lark = createLark({ sdk, program: 'lark-cli', log: () => undefined })
    await expect(lark.owner()).rejects.toThrow('spawn 失败')
  })

  it('输出不是 JSON / 失败帧：都拒绝', async () => {
    const notJson = fakeCli({ behaviors: [{ stdout: 'oops' }] })
    await expect(larkOf(notJson).owner()).rejects.toThrow(/输出不是 JSON/)

    const notObject = fakeCli({ behaviors: [{ stdout: '[]' }] })
    await expect(larkOf(notObject).owner()).rejects.toThrow(/输出不是对象/)

    const failed = fakeCli({
      behaviors: [{ stdout: JSON.stringify({ ok: false, error: { code: 'x' } }) }],
    })
    await expect(larkOf(failed).owner()).rejects.toThrow(/失败/)
  })

  it('watchClicks：stdout 行是事件、非 JSON 行只记日志、退出回报原因', async () => {
    const logs: string[] = []
    const events: Array<Record<string, unknown>> = []
    const exits: string[] = []
    const cli = fakeCli({ behaviors: [{ hang: true }] })
    const lark = createLark({
      sdk: sdkOf(cli),
      program: 'lark-cli',
      log: (line) => logs.push(line),
    })

    lark.watchClicks(
      (event) => events.push(event),
      (reason) => exits.push(reason),
    )
    expect(cli.calls[0].args).toEqual(['event', 'consume', 'card.action.trigger', '--as', 'bot'])

    cli.children[0].emitStdout('ready\n')
    cli.children[0].emitStdout('{"action_tag":"button"}\n{"action_tag":"button"}\n')
    cli.children[0].emitStderr(' token expired \n')
    cli.children[0].close(0)

    expect(logs.join('\n')).toContain('ready')
    expect(logs.join('\n')).toContain('token expired')
    expect(events).toEqual([{ action_tag: 'button' }, { action_tag: 'button' }])
    expect(exits).toEqual(['监听进程退出（退出码 0）'])
  })

  it('watchClicks：进程报错回报原因；找不到命令时立即回报并可安全调用 stop', () => {
    const missing: string[] = []
    const cli = fakeCli({ resolvePath: null })
    const stop = createLark({
      sdk: sdkOf(cli),
      program: 'lark-cli',
      log: () => undefined,
    }).watchClicks(
      () => undefined,
      (reason) => missing.push(reason),
    )
    expect(missing[0]).toMatch(/找不到 lark-cli/)
    expect(() => stop()).not.toThrow()
    expect(cli.calls).toHaveLength(0)

    const failing = fakeCli({ behaviors: [{ hang: true }] })
    const reasons: string[] = []
    createLark({
      sdk: sdkOf(failing),
      program: 'lark-cli',
      log: () => undefined,
    }).watchClicks(
      () => undefined,
      (reason) => reasons.push(reason),
    )
    failing.children[0].emitError(new Error('管道断了'))
    expect(reasons).toEqual(['管道断了'])
  })

  it('watchClicks：spawn 抛错时回报原因；stop 之后退出不再回报', () => {
    const reasons: string[] = []
    const stop = createLark({
      sdk: fakeSdk({
        resolve: () => ({ path: '/bin/lark-cli', error: null }),
        spawn: () => {
          throw new Error('起不来')
        },
      }),
      program: 'lark-cli',
      log: () => undefined,
    }).watchClicks(
      () => undefined,
      (reason) => reasons.push(reason),
    )
    expect(reasons).toEqual(['起不来'])
    expect(() => stop()).not.toThrow()

    const cli = fakeCli({ behaviors: [{ hang: true }] })
    const seen: string[] = []
    const stopWatch = createLark({
      sdk: sdkOf(cli),
      program: 'lark-cli',
      log: () => undefined,
    }).watchClicks(
      () => undefined,
      (reason) => seen.push(reason),
    )
    stopWatch()
    expect(cli.children[0].killed).toEqual(['SIGTERM'])
    expect(seen).toEqual([])
  })
})

// ---------------------------------------------------------------- start 编排

/** 通道回报的聚合引用（M45：`{"<连接>": "<message_id>"}`） */
const refsOf = (pairs: Record<string, string>): string => JSON.stringify(pairs)

interface Started {
  harness: ChannelHarness
  cli: FakeCli
  logs: string[]
  dispose: () => void
}

/** 起一个飞书通道：默认配置了接收人 `ou_me`（不必跑 auth status），watch 进程按需给 hang。 */
async function startFeishu(
  options: {
    config?: Record<string, unknown>
    behaviors?: Behavior[]
    resolvePath?: string | null
    answer?: (call: AnswerCall) => Promise<ChannelAnswerOutcome>
    /** 让 `sdk.config()` 返回 null（宿主没给配置时插件自己兜底） */
    nullConfig?: boolean
    /** start 之前就 abort（宿主已停用该通道） */
    abortBefore?: boolean
  } = {},
): Promise<Started> {
  const logs: string[] = []
  const cli = fakeCli({ behaviors: options.behaviors, resolvePath: options.resolvePath })
  const sdk = fakeSdk({
    config: <T = Record<string, unknown>>() =>
      (options.nullConfig === true ? null : { user: 'ou_me', ...(options.config ?? {}) }) as T,
    log: (line) => logs.push(line),
  })
  // 假 CLI 只实现通道需要的最小进程面（ChannelProcess）；sdk 的能力面类型更宽，这里替身即可
  const channelSdk = { ...sdk, process: cli.process as unknown as ProcessCapability }
  const harness = channelHarness({ sdk: channelSdk, answer: options.answer })
  if (options.abortBefore === true) harness.controller.abort()
  const dispose = await feishuChannel.start(harness.ctx)
  return { harness, cli, logs, dispose }
}

/** 等异步投递链走完：整条链都是 microtask（假进程用 queueMicrotask 回包），让出一轮宏任务即可。 */
const flushDeliver = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

describe('飞书通道：启动与投递', () => {
  it('没登录：连接照样起来等第一条私聊认人，卡片暂时不发，dispose 可重复调用', async () => {
    const { harness, cli, logs, dispose } = await startFeishu({
      config: { user: '' },
      behaviors: [{ code: 1, stderr: 'not logged in' }, { hang: true }],
    })

    // M46：拿不到登录人不该让整条连接消失——入站事件自己带着「谁发的、会话是哪个」
    expect(harness.handlers).toHaveLength(1)
    expect(logs.join('\n')).toContain('还没有登录人')

    // 还没认人：这张卡不发（也不报错），提示只记一次
    harness.deliver(inst())
    await flushDeliver()
    harness.deliver(inst({ version: 2 }))
    await flushDeliver()
    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(0)
    expect(logs.filter((line) => line.includes('还没有发送目标'))).toHaveLength(1)

    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
  })

  it('发群但没配可答复人：不订阅卡片（群里谁都能答是不可接受的默认）', async () => {
    const { harness, logs } = await startFeishu({ config: { user: '', chat: 'oc_1' } })

    expect(harness.handlers).toHaveLength(0)
    expect(logs.join('\n')).toContain('发群但没配可答复人')
  })

  it('私聊：接收人取 CLI 登录人，卡片整串作为 --content 发出并回报 delivered', async () => {
    const { harness, cli } = await startFeishu({
      config: { user: '' },
      behaviors: [
        { stdout: JSON.stringify({ ok: true, identities: { user: { openId: 'ou_owner' } } }) },
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
      ],
    })

    harness.deliver(inst())
    await flushDeliver()

    expect(cli.calls[0].args).toEqual(['auth', 'status'])
    expect(cli.calls[1].args).toEqual(['event', 'consume', 'card.action.trigger', '--as', 'bot'])
    expect(cli.calls[2].args).toContain('--user-id')
    expect(cli.calls[2].args).toContain('ou_owner')
    expect(cli.calls[2].args).toContain('--content')
    expect(JSON.parse(cli.calls[2].args.at(-1) ?? '{}')).toMatchObject({ schema: '2.0' })
    expect(harness.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: refsOf({ default: 'om_1' }) },
    ])
  })

  it('信息卡（notice）不发消息：只 ack 送达（IM 里没有通知栏，正文已经说过同一件事）', async () => {
    const { harness, cli } = await startFeishu({
      config: { user: '' },
      behaviors: [
        { stdout: JSON.stringify({ ok: true, identities: { user: { openId: 'ou_owner' } } }) },
        { hang: true },
      ],
    })

    harness.deliver(inst({ kind: 'notice', options: [], text: '', title: '已定位上上个对话' }))
    await flushDeliver()

    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(0)
    expect(cli.calls.filter((call) => call.args.includes('patch'))).toHaveLength(0)
    expect(harness.delivered).toEqual([{ cardId: 'card-1', version: 1, ref: '{}' }])
  })

  it('信息卡的终态也不落消息：本来就不在飞书里，没有要改口的那条', async () => {
    const { harness, cli } = await startFeishu({
      config: { user: '' },
      behaviors: [
        { stdout: JSON.stringify({ ok: true, identities: { user: { openId: 'ou_owner' } } }) },
        { hang: true },
      ],
    })

    harness.deliver(inst({ kind: 'notice', options: [], text: '', status: 'resolved' }))
    await flushDeliver()

    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(0)
    expect(cli.calls.filter((call) => call.args.includes('patch'))).toHaveLength(0)
    expect(harness.delivered).toEqual([{ cardId: 'card-1', version: 1, ref: '{}' }])
  })

  it('缺 kind 的老信息卡（没有选项）：按同一口径不落消息', async () => {
    const { harness, cli } = await startFeishu({
      config: { user: '' },
      behaviors: [
        { stdout: JSON.stringify({ ok: true, identities: { user: { openId: 'ou_owner' } } }) },
        { hang: true },
      ],
    })

    const legacy = inst({ options: [], text: '', title: '老库里的知会' })
    delete (legacy as { kind?: string }).kind
    harness.deliver(legacy)
    await flushDeliver()

    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(0)
    expect(harness.delivered).toEqual([{ cardId: 'card-1', version: 1, ref: '{}' }])
  })

  it('投递失败只记日志：不伪造送达（hub 会按重投曲线再来）', async () => {
    const { harness, logs } = await startFeishu({
      behaviors: [{ hang: true }, { code: 1, stderr: 'no scope' }],
    })

    harness.deliver(inst())
    await flushDeliver()

    expect(harness.delivered).toEqual([])
    expect(logs.join('\n')).toContain('飞书投递失败')
    expect(logs.join('\n')).toContain('no scope')
  })

  it('同一版本重投：原地更新同一条消息，不再发第二条', async () => {
    const { harness, cli } = await startFeishu({
      behaviors: [
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
        { stdout: okBody({}) },
      ],
    })

    const card = inst()
    harness.deliver(card)
    await flushDeliver()
    harness.deliver(card)
    await flushDeliver()

    const sends = cli.calls.filter((call) => call.args.includes('+messages-send'))
    expect(sends).toHaveLength(1)
    expect(cli.calls.filter((call) => call.args.includes('patch'))).toHaveLength(1)
    expect(harness.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: refsOf({ default: 'om_1' }) },
      { cardId: 'card-1', version: 1, ref: refsOf({ default: 'om_1' }) },
    ])
  })

  it('同一张卡的下一版本：原地 patch，不再新发', async () => {
    const { harness, cli } = await startFeishu({
      behaviors: [
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
        { stdout: okBody({}) },
      ],
    })

    harness.deliver(inst({ version: 1 }))
    await flushDeliver()
    harness.deliver(inst({ version: 2, title: '换个问题' }))
    await flushDeliver()

    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(1)
    const patch = cli.calls.find((call) => call.args.includes('patch'))
    expect(patch?.args).toContain('om_1')
    expect(harness.delivered.map((item) => item.version)).toEqual([1, 2])
  })

  it('patch 失败（超 14 天 / 不是发送者）：退回新发一条并照样 ack', async () => {
    const { harness, cli, logs } = await startFeishu({
      behaviors: [
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
        { code: 1, stderr: 'message too old' },
        { stdout: okBody({ message_id: 'om_2' }) },
      ],
    })

    harness.deliver(inst({ version: 1 }))
    await flushDeliver()
    harness.deliver(inst({ version: 2 }))
    await flushDeliver()

    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(2)
    expect(logs.join('\n')).toContain('改为新发')
    expect(harness.delivered.at(-1)).toEqual({
      cardId: 'card-1',
      version: 2,
      ref: refsOf({ default: 'om_2' }),
    })
  })
})

describe('飞书通道：点击答复', () => {
  const clickEvent = (over: Record<string, unknown> = {}): string =>
    `${JSON.stringify({
      action_tag: 'button',
      action_value: { card: 'card-1', choice: 1 },
      operator_id: 'ou_me',
      message_id: 'om_1',
      ...over,
    })}\n`

  it('白名单内点击：把答案（带回答人）交回宿主，自己不刷卡片', async () => {
    const { harness, cli, logs } = await startFeishu({
      behaviors: [
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
        { stdout: okBody({}) },
      ],
    })

    harness.deliver(inst())
    await flushDeliver()
    cli.children[0].emitStdout(clickEvent())
    await flushDeliver()

    // M45：多连接时聚合 ref 没法逐连接比对，通道自己校验「是不是当前版本那条消息」，
    // 交回宿主时不再带 ref（带的只有回答人）
    expect(harness.answers).toEqual([{ cardId: 'card-1', optionIndex: 1, byRef: 'ou_me' }])
    expect(logs.join('\n')).toContain('飞书点击已计入')
    // M43：点击不再自己 patch——宿主把内核里的最新卡片行送回来，那时才改口
    expect(cli.calls.some((call) => call.args.includes('patch'))).toBe(false)
  })

  it('宿主送回答后的终态：原地把它刷成已答复（按钮消失、写明选了什么）', async () => {
    const { harness, cli } = await startFeishu({
      behaviors: [
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
        { stdout: okBody({}) },
      ],
    })

    harness.deliver(inst())
    await flushDeliver()
    harness.deliver(
      inst({
        options: ['方案 A', '方案 B'],
        status: 'answered',
        optionIndex: 1,
        answeredBy: 'channel',
      }),
      'om_1',
    )
    await flushDeliver()

    const patch = cli.calls.find((call) => call.args.includes('patch'))
    expect(patch?.args).toContain('om_1')
    const payload = cli.children.find((child) => child.written.length > 0)?.written.join('')
    expect(payload).toContain('已记录：方案 B')
  })

  it('终态更新失败（不是发送者 / 超 14 天）：只记日志，不再新发一条', async () => {
    const { harness, cli, logs } = await startFeishu({
      behaviors: [
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
        { code: 1, stderr: 'not the sender' },
      ],
    })

    harness.deliver(inst())
    await flushDeliver()
    harness.deliver(inst({ status: 'resolved' }), 'om_1')
    await flushDeliver()

    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(1)
    expect(logs.join('\n')).toContain('终态更新失败')
  })

  it('白名单外点击：只记一条日志，不计数、不改卡片', async () => {
    const { harness, cli, logs } = await startFeishu({
      config: { answerers: 'ou_boss' },
      behaviors: [{ hang: true }, { stdout: okBody({ message_id: 'om_1' }) }],
    })

    harness.deliver(inst())
    await flushDeliver()
    cli.children[0].emitStdout(clickEvent({ operator_id: 'ou_stranger' }))
    await flushDeliver()

    expect(harness.answers).toEqual([])
    expect(logs.join('\n')).toContain('操作人不在名单')
    expect(cli.calls.some((call) => call.args.includes('patch'))).toBe(false)
  })

  it('内核里已经 settled（别处答过 / 已关闭）：记日志，不说成「已计入」', async () => {
    const { harness, cli, logs } = await startFeishu({
      behaviors: [{ hang: true }, { stdout: okBody({ message_id: 'om_1' }) }],
      answer: () => Promise.resolve({ changed: false, status: 'answered' }),
    })

    harness.deliver(inst())
    await flushDeliver()
    cli.children[0].emitStdout(clickEvent())
    await flushDeliver()

    expect(logs.join('\n')).toContain('飞书点击未计入')
    expect(cli.calls.some((call) => call.args.includes('patch'))).toBe(false)
  })

  it('宿主回调抛错：也记成「未计入」，不冒泡成未处理的 rejection', async () => {
    const { harness, cli, logs } = await startFeishu({
      behaviors: [{ hang: true }, { stdout: okBody({ message_id: 'om_1' }) }],
      answer: () => Promise.reject('boom'),
    })

    harness.deliver(inst())
    await flushDeliver()
    cli.children[0].emitStdout(clickEvent())
    await flushDeliver()

    expect(logs.join('\n')).toContain('飞书点击未计入')
  })

  it('没发过的卡被点：忽略（当前版本没有这条消息，不能替别的消息作答）', async () => {
    const { harness, cli, logs } = await startFeishu({ behaviors: [{ hang: true }] })

    cli.children[0].emitStdout(clickEvent())
    await flushDeliver()

    expect(harness.answers).toEqual([])
    expect(logs.join('\n')).toContain('不是当前版本的那条消息')
    expect(cli.calls.some((call) => call.args.includes('patch'))).toBe(false)
  })

  it('非本插件的回调 / 非法回传值：静默忽略', async () => {
    const { harness, cli } = await startFeishu({ behaviors: [{ hang: true }] })

    cli.children[0].emitStdout(`${JSON.stringify({ action_tag: 'select_static' })}\n`)
    cli.children[0].emitStdout('diagnostics from cli\n')
    cli.children[0].emitStdout('{"action_tag":"button","action_value":"{broken"}\n')
    await flushDeliver()

    expect(harness.answers).toEqual([])
  })
})

describe('飞书通道：监听进程与生命周期', () => {
  it('监听进程退出后按固定间隔重连', async () => {
    vi.useFakeTimers()
    try {
      const { cli, logs } = await startFeishu({ behaviors: [{ hang: true }] })
      expect(cli.calls.filter((call) => call.args[0] === 'event')).toHaveLength(1)

      cli.children[0].close(1)
      expect(logs.join('\n')).toContain('点击监听中断')

      cli.push({ hang: true })
      await vi.advanceTimersByTimeAsync(WATCH_RESTART_MS)
      expect(cli.calls.filter((call) => call.args[0] === 'event')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lark-cli 找不到：启动监听失败也按间隔重试（不永久哑掉）', async () => {
    vi.useFakeTimers()
    try {
      const { cli, logs } = await startFeishu({ resolvePath: null })
      expect(logs.join('\n')).toContain('找不到 lark-cli')

      await vi.advanceTimersByTimeAsync(WATCH_RESTART_MS)
      expect(logs.join('\n').match(/找不到 lark-cli/g)).toHaveLength(2)
      expect(cli.calls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose：退订、停监听、清重连，可重复调用', async () => {
    const { harness, cli, dispose } = await startFeishu({ behaviors: [{ hang: true }] })

    expect(harness.handlers).toHaveLength(1)
    dispose()
    expect(harness.handlers).toHaveLength(0)
    expect(cli.children[0].killed).toEqual(['SIGTERM'])
    expect(() => dispose()).not.toThrow()
  })

  it('signal abort 时自动 dispose（宿主停用通道）', async () => {
    const { harness } = await startFeishu({ behaviors: [{ hang: true }] })

    harness.controller.abort()
    expect(harness.handlers).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- 失败与边界补口

describe('飞书通道：失败与边界', () => {
  const click = (over: Record<string, unknown> = {}): string =>
    `${JSON.stringify({
      action_tag: 'button',
      action_value: { card: 'card-1', choice: 1 },
      operator_id: 'ou_me',
      message_id: 'om_1',
      ...over,
    })}\n`

  it('命令进程报错（onError）直接以该错误结束', async () => {
    const cli = fakeCli({ behaviors: [{ error: new Error('管道断了') }] })
    await expect(larkOf(cli).owner()).rejects.toThrow('管道断了')
  })

  it('进程报错值是字符串时按文本写进错误', async () => {
    const cli = fakeCli({ behaviors: [{ error: 'boom' as unknown as Error }] })
    await expect(larkOf(cli).owner()).rejects.toThrow('boom')
  })

  it('超时但没有 pid：按句柄 SIGKILL，不走 killTree', async () => {
    vi.useFakeTimers()
    try {
      const cli = fakeCli({ behaviors: [{ hang: true }], pid: null })
      const settled = larkOf(cli)
        .owner()
        .then(
          () => 'resolved',
          (error: Error) => error.message,
        )
      expect(cli.children[0].pid).toBeUndefined()
      await vi.advanceTimersByTimeAsync(LARK_TIMEOUT_MS)
      await expect(settled).resolves.toContain('超时')
      expect(cli.children[0].killed).toEqual(['SIGKILL'])
      expect(cli.killTree).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stdout 超过上限后不再累积（输出仍是非法 JSON）', async () => {
    const cli = fakeCli({ behaviors: [{ hang: true }] })
    const settled = larkOf(cli)
      .owner()
      .then(
        () => 'resolved',
        (error: Error) => error.message,
      )
    cli.children[0].emitStdout('x'.repeat(STDOUT_LIMIT))
    cli.children[0].emitStdout('{"ok":true}')
    cli.children[0].close(0)
    await expect(settled).resolves.toContain('输出不是 JSON')
  })

  it('ownerOf：user 不是对象时跳过该层', () => {
    expect(ownerOf({ identities: { user: 'ou_x' } })).toBeNull()
  })

  it('失败帧没有 error 字段时用整个返回体做说明', async () => {
    const cli = fakeCli({ behaviors: [{ stdout: JSON.stringify({ ok: false }) }] })
    await expect(larkOf(cli).owner()).rejects.toThrow(/失败/)
  })

  it('resolve 不给原因时用缺省文案（命令与监听两条路一致）', async () => {
    const cli = fakeCli({ resolvePath: null, resolveError: null })
    await expect(larkOf(cli).owner()).rejects.toThrow(/未在 PATH 中/)

    const reasons: string[] = []
    createLark({
      sdk: sdkOf(cli),
      program: 'lark-cli',
      log: () => undefined,
    }).watchClicks(
      () => undefined,
      (reason) => reasons.push(reason),
    )
    expect(reasons[0]).toContain('未在 PATH 中')
  })

  it('stderr 很长时只保留尾部 500 字符', async () => {
    const cli = fakeCli({ behaviors: [{ code: 2, stderr: 'y'.repeat(600) }] })
    await expect(larkOf(cli).owner()).rejects.toThrow(`…${'y'.repeat(500)}`)
  })

  it('宿主没给配置（null）：按未配置处理，连接起来等认人、卡片不发', async () => {
    const { harness, cli, logs, dispose } = await startFeishu({
      nullConfig: true,
      behaviors: [{ code: 1, stderr: 'not logged in' }, { hang: true }],
    })

    expect(harness.handlers).toHaveLength(1)
    expect(logs.join('\n')).toContain('还没有登录人')
    harness.deliver(inst())
    await flushDeliver()
    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
  })

  it('点击下标越界：照样把下标交回宿主（合法性由内核判），通道不改卡片', async () => {
    const { harness, cli } = await startFeishu({
      behaviors: [
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
        { stdout: okBody({}) },
      ],
    })

    harness.deliver(inst({ options: ['A', 'B'] }))
    await flushDeliver()
    cli.children[0].emitStdout(click({ action_value: { card: 'card-1', choice: 9 } }))
    await flushDeliver()

    expect(harness.answers).toEqual([{ cardId: 'card-1', optionIndex: 9, byRef: 'ou_me' }])
    expect(cli.calls.some((call) => call.args.includes('patch'))).toBe(false)
  })

  it('答复后宿主回送「越界下标已答」：结论里给出可读占位，不留半截文案', async () => {
    const { harness, cli } = await startFeishu({
      behaviors: [
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
        { stdout: okBody({}) },
      ],
    })

    harness.deliver(inst({ options: ['A', 'B'] }))
    await flushDeliver()
    harness.deliver(inst({ status: 'answered', optionIndex: 9 }), 'om_1')
    await flushDeliver()

    const written = cli.children.flatMap((child) => child.written).join('')
    expect(written).toContain('已记录：（选项已失效）')
  })

  it('监听中断后被 dispose：排期清掉，不再重连', async () => {
    vi.useFakeTimers()
    try {
      const { cli, dispose } = await startFeishu({ behaviors: [{ hang: true }] })
      cli.children[0].close(1)
      dispose()
      await vi.advanceTimersByTimeAsync(WATCH_RESTART_MS)
      expect(cli.calls.filter((call) => call.args[0] === 'event')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('宿主在 start 之前就 abort：立刻 dispose，不订阅卡片', async () => {
    const { harness } = await startFeishu({ behaviors: [{ hang: true }], abortBefore: true })
    expect(harness.handlers).toHaveLength(0)
  })

  it('answer 抛出的不是 Error（字符串）：日志按字符串写', async () => {
    const { harness, cli, logs } = await startFeishu({
      behaviors: [{ hang: true }, { stdout: okBody({ message_id: 'om_1' }) }],
      answer: () => Promise.reject('boom'),
    })

    harness.deliver(inst())
    await flushDeliver()
    cli.children[0].emitStdout(click())
    await flushDeliver()

    expect(logs.join('\n')).toContain('boom')
  })

  it('监听进程报错的不是 Error（字符串）：原因按字符串回报', () => {
    const cli = fakeCli({ behaviors: [{ hang: true }] })
    const reasons: string[] = []
    createLark({
      sdk: sdkOf(cli),
      program: 'lark-cli',
      log: () => undefined,
    }).watchClicks(
      () => undefined,
      (reason) => reasons.push(reason),
    )
    cli.children[0].emitError('boom' as unknown as Error)
    expect(reasons).toEqual(['boom'])
  })

  it('stderr 只有空白块时不记日志', () => {
    const cli = fakeCli({ behaviors: [{ hang: true }] })
    const logs: string[] = []
    createLark({
      sdk: sdkOf(cli),
      program: 'lark-cli',
      log: (line) => logs.push(line),
    }).watchClicks(
      () => undefined,
      () => undefined,
    )
    cli.children[0].emitStderr('   ')
    expect(logs).toEqual([])
  })

  it('stop 之后到达的进程报错不再回报（不会重拉刚停掉的监听）', () => {
    const cli = fakeCli({ behaviors: [{ hang: true }] })
    const reasons: string[] = []
    const stop = createLark({
      sdk: sdkOf(cli),
      program: 'lark-cli',
      log: () => undefined,
    }).watchClicks(
      () => undefined,
      (reason) => reasons.push(reason),
    )
    stop()
    cli.children[0].emitError(new Error('晚到的错误'))
    expect(reasons).toEqual([])
  })
})

// ---------------------------------------------------------------- 入站（M44）

/**
 * 一条 `im.message.receive_v1` 事件：**CLI 摊平成一层**（见 `lark-cli event schema`），
 * `content` 已经是渲染好的人话。
 */
const textEvent = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'im.message.receive_v1',
    message_id: 'om_in_1',
    chat_id: 'oc_p2p',
    chat_type: 'p2p',
    message_type: 'text',
    content: '今天有什么安排',
    sender_id: 'ou_me',
    sender_type: 'user',
    ...over,
  })

describe('飞书通道：入站文本解析', () => {
  it('私聊纯文本：取消息 id、会话类型、会话 id、发送人与正文', () => {
    expect(readTextMessage(JSON.parse(textEvent()))).toEqual({
      messageId: 'om_in_1',
      chatType: 'p2p',
      chatId: 'oc_p2p',
      sender: 'ou_me',
      text: '今天有什么安排',
      rootRef: null,
      threadRef: null,
      replyTo: null,
    })
  })

  it('回复链证据：root_id / thread_id / reply_to 原样带出（缺省为 null）', () => {
    const plain = readTextMessage(JSON.parse(textEvent()))
    expect(plain?.rootRef).toBeNull()
    expect(plain?.threadRef).toBeNull()
    expect(plain?.replyTo).toBeNull()

    const threaded = readTextMessage(
      JSON.parse(textEvent({ root_id: 'om_root', thread_id: 'omt_1', reply_to: 'om_bot_reply' })),
    )
    expect(threaded?.rootRef).toBe('om_root')
    expect(threaded?.threadRef).toBe('omt_1')
    expect(threaded?.replyTo).toBe('om_bot_reply')
  })

  it('@ 机器人占位符去掉（`@_user_1` 对人没意义、对模型是噪音）', () => {
    const event = JSON.parse(textEvent({ content: '@_user_1 帮我列一下待办' }))
    expect(readTextMessage(event)?.text).toBe('帮我列一下待办')
    // mentions[].key 是别的形状时也照清
    const named = JSON.parse(
      textEvent({ content: '@_u_9 总结一下', mentions: [{ key: '@_u_9', name: '小助' }] }),
    )
    expect(readTextMessage(named)?.text).toBe('总结一下')
  })

  it('机器人自己发的、非文本类型一律不认（否则会自问自答）', () => {
    expect(readTextMessage(JSON.parse(textEvent({ sender_type: 'bot' })))).toBeNull()
    expect(readTextMessage(JSON.parse(textEvent({ sender_type: 'app' })))).toBeNull()
    expect(readTextMessage(JSON.parse(textEvent({ message_type: 'image' })))).toBeNull()
    expect(readTextMessage(JSON.parse(textEvent({ content: '   ' })))).toBeNull()
  })

  it('正文是 {"text":…} 形状时也认（平台形状变过来不至于哑掉）', () => {
    const event = JSON.parse(textEvent({ content: JSON.stringify({ text: '你好' }) }))
    expect(readTextMessage(event)?.text).toBe('你好')
  })

  it('v2 信封（未经 CLI 摊平）也能解析', () => {
    const envelope = JSON.parse(
      JSON.stringify({
        schema: '2.0',
        event: {
          sender: { sender_id: { open_id: 'ou_me' }, sender_type: 'user' },
          message: {
            message_id: 'om_env_1',
            chat_id: 'oc_env',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: '信封里的正文' }),
          },
        },
      }),
    )
    expect(readTextMessage(envelope)).toEqual({
      messageId: 'om_env_1',
      chatType: 'p2p',
      chatId: 'oc_env',
      sender: 'ou_me',
      text: '信封里的正文',
      rootRef: null,
      threadRef: null,
      replyTo: null,
    })
  })

  it('群消息照常解析（只做私聊是通道策略，解析层不替它做主）', () => {
    expect(readTextMessage(JSON.parse(textEvent({ chat_type: 'group' })))?.chatType).toBe('group')
  })
})

describe('飞书通道：入站派活与进展（M44）', () => {
  it('配了默认智能体才接第一条入站长连接', async () => {
    const off = await startFeishu({ config: { agent: '' }, behaviors: [{ hang: true }] })
    expect(off.cli.calls.filter((call) => call.args[1] === 'consume')).toHaveLength(1)
    off.dispose()

    const on = await startFeishu({
      config: { agent: 'a1' },
      behaviors: [{ hang: true }, { hang: true }],
    })
    expect(on.cli.calls.filter((call) => call.args[1] === 'consume')).toHaveLength(2)
    on.dispose()
  })

  it('私聊一句话 → ctx.submit(正文, 平台消息 id)，并把回执回帖到那条消息', async () => {
    const { harness, cli } = await startFeishu({
      config: { agent: 'a1' },
      behaviors: [{ hang: true }, { hang: true }, { stdout: okBody({ message_id: 'om_reply' }) }],
    })

    cli.children[1].emitStdout(`${textEvent()}\n`)
    await flushDeliver()

    // M45：连接里配的智能体会作为第三参交给宿主（按连接派活）
    expect(harness.submits).toEqual([
      {
        text: '今天有什么安排',
        hints: {
          ref: 'default:om_in_1',
          scope: 'default',
          chatId: 'oc_p2p',
          rootRef: null,
          threadRef: null,
          replyTo: null,
        },
        agent: 'a1',
      },
    ])
    const reply = cli.calls.find((call) => call.args.includes('+messages-reply'))
    expect(reply?.args).toEqual([
      'im',
      '+messages-reply',
      '--message-id',
      'om_in_1',
      '--as',
      'bot',
      '--msg-type',
      'text',
      '--content',
      JSON.stringify({ text: '已收到' }),
    ])
  })

  it('没登录也没配接收人：第一条私聊认下发送人与会话，卡片随后发到那个会话（M46）', async () => {
    const { harness, cli, logs } = await startFeishu({
      config: { user: '', agent: 'a1' },
      behaviors: [
        { code: 1, stderr: 'not logged in' }, // auth status 失败 = 没有登录人
        { hang: true }, // card.action.trigger 长连接
        { hang: true }, // im.message.receive_v1 长连接
        { stdout: okBody({ message_id: 'om_reply' }) }, // 回执
        { stdout: okBody({ message_id: 'om_card' }) }, // 卡片
      ],
    })

    // children：0=auth status，1=card.action.trigger，2=im.message.receive_v1
    cli.children[2].emitStdout(`${textEvent()}\n`)
    await flushDeliver()

    expect(harness.submits).toEqual([
      {
        text: '今天有什么安排',
        hints: {
          ref: 'default:om_in_1',
          scope: 'default',
          chatId: 'oc_p2p',
          rootRef: null,
          threadRef: null,
          replyTo: null,
        },
        agent: 'a1',
      },
    ])
    expect(logs.join('\n')).toContain('认下第一位使用者 ou_me')

    // 认下来之后：卡片发给这条私聊的会话（`--chat-id oc_…`），不再是「没有目标」
    harness.deliver(inst())
    await flushDeliver()
    const send = cli.calls.find((call) => call.args.includes('+messages-send'))
    expect(send?.args).toContain('--chat-id')
    expect(send?.args).toContain('oc_p2p')
    expect(harness.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: refsOf({ default: 'om_card' }) },
    ])
  })

  it('认过人之后：别人再发消息一律忽略（不因为「谁先说」多放一个人进来）', async () => {
    const { harness, cli, logs } = await startFeishu({
      config: { user: '', agent: 'a1' },
      behaviors: [
        { code: 1, stderr: 'not logged in' },
        { hang: true },
        { hang: true },
        { stdout: okBody({ message_id: 'om_reply' }) },
      ],
    })

    cli.children[2].emitStdout(`${textEvent()}\n`)
    await flushDeliver()
    cli.children[2].emitStdout(`${textEvent({ message_id: 'om_in_2', sender_id: 'ou_other' })}\n`)
    await flushDeliver()

    expect(harness.submits).toHaveLength(1)
    expect(logs.join('\n')).toContain('不在名单')
  })

  it('有登录人时不认新发送人：名单之外的消息忽略（默认拒绝不动）', async () => {
    const { harness, cli, logs } = await startFeishu({
      config: { user: '', agent: 'a1' },
      behaviors: [
        { stdout: JSON.stringify({ ok: true, identities: { user: { openId: 'ou_owner' } } }) },
        { hang: true },
        { hang: true },
      ],
    })

    cli.children[2].emitStdout(`${textEvent()}\n`)
    await flushDeliver()

    expect(harness.submits).toEqual([])
    expect(logs.join('\n')).toContain('不在名单')
  })

  it('群聊不派活；名单外的人不派活（都只记一行日志）', async () => {
    const { harness, cli, logs } = await startFeishu({
      config: { agent: 'a1' },
      behaviors: [{ hang: true }, { hang: true }],
    })

    cli.children[1].emitStdout(`${textEvent({ chat_type: 'group' })}\n`)
    const stranger = JSON.parse(textEvent())
    stranger.sender_id = 'ou_stranger'
    cli.children[1].emitStdout(`${JSON.stringify(stranger)}\n`)
    await flushDeliver()

    expect(harness.submits).toEqual([])
    expect(logs.join('\n')).toContain('入站只认私聊')
    expect(logs.join('\n')).toContain('不在名单')
  })

  it('没派出去的正文也回帖（沉默是最差的反馈）', async () => {
    const logs: string[] = []
    const cli = fakeCli({ behaviors: [{ hang: true }, { hang: true }, { stdout: okBody({}) }] })
    const sdk = fakeSdk({
      config: <T = Record<string, unknown>>() => ({ user: 'ou_me', agent: 'a1' }) as T,
      log: (line) => logs.push(line),
    })
    const harness = channelHarness({
      sdk: { ...sdk, process: cli.process as unknown as ProcessCapability },
      submit: async () => ({
        accepted: false,
        conversationId: null,
        receipt: '找不到智能体「a1」',
      }),
    })
    await feishuChannel.start(harness.ctx)

    cli.children[1].emitStdout(`${textEvent()}\n`)
    await flushDeliver()

    const reply = cli.calls.find((call) => call.args.includes('+messages-reply'))
    expect(JSON.parse(reply?.args.at(-1) ?? '{}')).toEqual({ text: '找不到智能体「a1」' })
    expect(logs).toEqual([])
  })

  it('进展回帖到发起那条消息下面（按会话锚点，不串台）', async () => {
    const { harness, cli } = await startFeishu({
      config: { agent: 'a1' },
      behaviors: [
        { hang: true },
        { hang: true },
        { stdout: okBody({ message_id: 'om_reply' }) },
        { stdout: okBody({ message_id: 'om_reply2' }) },
        { stdout: okBody({ message_id: 'om_reply3' }) },
      ],
    })

    cli.children[1].emitStdout(`${textEvent()}\n`)
    await flushDeliver()

    harness.progress({ conversationId: 'conversation-1', kind: 'reply', text: '已经做完了' })
    // 别的会话（不是这个通道提交的）不该回帖
    harness.progress({ conversationId: 'conversation-other', kind: 'reply', text: '别人的活' })
    await flushDeliver()

    const replies = cli.calls.filter((call) => call.args.includes('+messages-reply'))
    expect(replies).toHaveLength(2)
    expect(replies[1].args).toContain('om_in_1')
    expect(JSON.parse(replies[1].args.at(-1) ?? '{}')).toEqual({ text: '已经做完了' })
  })

  it('超长进展按上限截断（完整内容留在工作台里看）', async () => {
    const clip = clipProgress('x'.repeat(PROGRESS_CHARS + 500))
    expect([...clip].length).toBeLessThan(PROGRESS_CHARS + 120)
    expect(clip).toContain('已截断')
  })
})

describe('飞书通道：lark 配置带前置参数（多应用换 profile，M44）', () => {
  it('programArgs：拆出命令与前缀参数，多余空白忽略', () => {
    expect(programArgs(' lark-cli  --profile  work2 ')).toEqual({
      command: 'lark-cli',
      prefix: ['--profile', 'work2'],
    })
    expect(programArgs('lark-cli')).toEqual({ command: 'lark-cli', prefix: [] })
  })

  it('发消息与监听都带上前缀参数（一个通道一套应用凭证）', async () => {
    const cli = fakeCli({ behaviors: [{ stdout: okBody({ message_id: 'om_1' }) }, { hang: true }] })
    const lark = createLark({
      sdk: sdkOf(cli),
      program: 'lark-cli --profile work2',
      log: () => undefined,
    })

    await lark.send({ kind: 'user', id: 'ou_1' }, '{}', 'wb-card-1-v1')
    expect(cli.calls[0].args.slice(0, 3)).toEqual(['--profile', 'work2', 'im'])

    lark.watchClicks(
      () => undefined,
      () => undefined,
    )
    expect(cli.calls[1].args).toEqual([
      '--profile',
      'work2',
      'event',
      'consume',
      'card.action.trigger',
      '--as',
      'bot',
    ])
  })
})
