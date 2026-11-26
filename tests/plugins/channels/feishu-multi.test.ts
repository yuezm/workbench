// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type {
  ChannelProcess,
  ChannelSpawned,
  ChannelSpawnOptions,
  ChannelStdout,
} from '@workbench/protocol/channels'
import type { Card } from '@workbench/protocol/entities'
import {
  connectionIdOf,
  feishuChannel,
  MAX_CONNECTIONS,
  parseConnectionRefs,
  parseConnections,
  programWithProfile,
  readFeishuConnections,
} from '@workbench/channel-feishu/index'
import { LARK_ENV_UNSET } from '@workbench/channel-feishu/lark'
import type { ProcessCapability } from '@workbench/capabilities/types'
import { fakeSdk } from '../support/fake-sdk'
import { cardOf, channelHarness, type ChannelHarness } from './harness'

/**
 * 飞书通道：多连接（M45）。
 *
 * 覆盖「一个通道接多个飞书应用」的三件事：连接配置怎么读、每条连接各自发到什么消息、
 * 以及点击按连接分流。全部走假 CLI，不发真消息、不连真长连接。
 */

type Listener = (chunk: unknown) => void

interface Behavior {
  stdout?: string
  stderr?: string
  code?: number | null
  error?: Error
  hang?: boolean
}

class FakeChild implements ChannelSpawned {
  readonly pid = 4_242
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

  close(code: number | null): void {
    this.closeCb?.(code, null)
  }

  emitError(error: Error): void {
    this.errorCb?.(error)
  }
}

interface FakeCli {
  process: ChannelProcess
  calls: Array<{ command: string; args: string[]; options: ChannelSpawnOptions }>
  children: FakeChild[]
}

function fakeCli(behaviors: Behavior[] = []): FakeCli {
  const queue = [...behaviors]
  const calls: FakeCli['calls'] = []
  const children: FakeChild[] = []
  const process: ChannelProcess = {
    resolve: (command) => ({ path: `/usr/local/bin/${command}`, error: null }),
    killTree: () => true,
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      const child = new FakeChild()
      children.push(child)
      const behavior = queue.shift() ?? { hang: true }
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
  return { process, calls, children }
}

const okBody = (data: Record<string, unknown>): string => JSON.stringify({ ok: true, data })

const clickEvent = (over: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    action_tag: 'button',
    action_value: { card: 'card-1', choice: 1 },
    operator_id: 'ou_me',
    message_id: 'om_a',
    ...over,
  })}\n`

const inst = (over: Partial<Card> = {}): Card => cardOf(over)

const flushDeliver = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

interface Started {
  harness: ChannelHarness
  cli: FakeCli
  logs: string[]
  dispose: () => void
}

async function startWith(
  config: Record<string, unknown>,
  behaviors: Behavior[] = [],
): Promise<Started> {
  const logs: string[] = []
  const cli = fakeCli(behaviors)
  const sdk = fakeSdk({
    config: <T = Record<string, unknown>>() => config as T,
    log: (line) => logs.push(line),
  })
  const channelSdk = { ...sdk, process: cli.process as unknown as ProcessCapability }
  const harness = channelHarness({ sdk: channelSdk })
  const dispose = await feishuChannel.start(harness.ctx)
  return { harness, cli, logs, dispose }
}

describe('飞书通道：连接配置（M45）', () => {
  it('connectionIdOf：小写、非法字符变连字符、去首尾、限长；纯中文归一为空', () => {
    expect(connectionIdOf(' Workbench ')).toBe('workbench')
    expect(connectionIdOf('my.conn')).toBe('my-conn')
    expect(connectionIdOf('工作台')).toBe('')
    expect(connectionIdOf('a/b c')).toBe('a-b-c')
    expect(connectionIdOf('x'.repeat(40)).length).toBeLessThanOrEqual(24)
  })

  it('programWithProfile：给 profile 时拼进命令；已经写了 --profile 就以配置为准', () => {
    expect(programWithProfile('lark-cli', 'wb')).toBe('lark-cli --profile wb')
    expect(programWithProfile('lark-cli', null)).toBe('lark-cli')
    expect(programWithProfile('lark-cli --profile old', 'wb')).toBe('lark-cli --profile old')
    expect(programWithProfile('lark-cli --profile=old', 'wb')).toBe('lark-cli --profile=old')
  })

  it('parseConnections：只认对象数组；坏 JSON / 非数组当没配', () => {
    expect(parseConnections(null)).toEqual([])
    expect(parseConnections('{')).toEqual([])
    expect(parseConnections('{"a":1}')).toEqual([])
    expect(parseConnections('[1, null, {"a":1}, []]')).toEqual([{ a: 1 }])
  })

  it('readFeishuConnections：JSON 列表 → 每条一个连接（profile 进命令、名单归一）', () => {
    const connections = readFeishuConnections({
      lark: 'lark-cli',
      connections: JSON.stringify([
        {
          id: 'wb',
          label: '工作台',
          profile: 'workbench',
          user: 'ou_me',
          answerers: 'ou_a, ou_b',
        },
        { label: '私人', chat: 'oc_2' },
      ]),
    })

    expect(connections).toHaveLength(2)
    expect(connections[0]).toEqual({
      id: 'wb',
      label: '工作台',
      program: 'lark-cli --profile workbench',
      profile: 'workbench',
      user: 'ou_me',
      chat: null,
      answerers: ['ou_a', 'ou_b'],
    })
    // 没有 profile：沿用 CLI 当前 profile；label 缺 id 时用 label 归一
    expect(connections[1]).toMatchObject({
      program: 'lark-cli',
      profile: null,
      chat: 'oc_2',
      answerers: [],
    })
  })

  it('readFeishuConnections：连接里没有「派给哪个智能体」（飞书不做聊天，只承载拍板卡）', () => {
    const [connection] = readFeishuConnections({
      connections: JSON.stringify([{ label: '工作台', agent: 'a1' }]),
    })
    expect(connection).not.toHaveProperty('agent')
  })

  it('readFeishuConnections：非法 profile 整条丢弃（它要进 argv）', () => {
    const connections = readFeishuConnections({
      connections: JSON.stringify([
        { profile: 'bad profile', user: 'ou_1' },
        { profile: '--evil', user: 'ou_2' },
        { profile: 'ok.profile', user: 'ou_3' },
      ]),
    })
    expect(connections.map((conn) => conn.profile)).toEqual(['ok.profile'])
  })

  it('readFeishuConnections：同名连接自动加后缀（ref 聚合键必须唯一）', () => {
    const connections = readFeishuConnections({
      connections: JSON.stringify([
        { label: 'same', user: 'ou_1' },
        { label: 'same', user: 'ou_2' },
        { label: 'same', user: 'ou_3' },
      ]),
    })
    expect(connections.map((conn) => conn.id)).toEqual(['same', 'same-2', 'same-3'])
  })

  it('readFeishuConnections：上限 MAX_CONNECTIONS；没有 id/label/profile 时兜底 cN', () => {
    const many = Array.from({ length: MAX_CONNECTIONS + 3 }, (_item, index) => ({
      label: `n${index}`,
      user: `ou_${index}`,
    }))
    expect(readFeishuConnections({ connections: JSON.stringify(many) })).toHaveLength(
      MAX_CONNECTIONS,
    )

    const unnamed = readFeishuConnections({ connections: JSON.stringify([{ user: 'ou_1' }]) })
    expect(unnamed[0]?.id).toBe('c1')
    expect(unnamed[0]?.label).toBe('连接 1')
  })

  it('readFeishuConnections：只有 name 时用 name 当 id；空白字段一律当没配', () => {
    const connections = readFeishuConnections({
      connections: JSON.stringify([
        { name: '工作台助手', user: 'ou_1' },
        { id: '   ', label: '   ', profile: null, user: 'ou_2' },
      ]),
    })
    // 中文名归一成空 slug → id 落回 c1；展示名仍用 name。第二条的 id/label 都是空白 → c2
    expect(connections.map((conn) => conn.id)).toEqual(['c1', 'c2'])
    expect(connections[0]?.label).toBe('工作台助手')
    expect(connections[1]?.label).toBe('连接 2')
  })

  it('readFeishuConnections：归一后撞名的空白 id 也会加后缀（聚合键必须唯一）', () => {
    const connections = readFeishuConnections({
      connections: JSON.stringify([
        { id: 'c2', user: 'ou_1' },
        // 归一成空 → 兜底 c2，但 c2 已被占：后缀保证唯一
        { id: '...', user: 'ou_2' },
      ]),
    })
    expect(connections.map((conn) => conn.id)).toEqual(['c2', 'c2-2'])
  })

  it('readFeishuConnections：没有 connections 时把旧字段当唯一连接（兼容旧配置）', () => {
    const connections = readFeishuConnections({
      lark: 'lark-cli --profile legacy',
      user: 'ou_me',
      chat: 'oc_1',
      answerers: 'ou_a',
    })
    expect(connections).toEqual([
      {
        id: 'default',
        label: '默认连接',
        program: 'lark-cli --profile legacy',
        profile: null,
        user: 'ou_me',
        chat: 'oc_1',
        answerers: ['ou_a'],
      },
    ])
  })

  it('parseConnectionRefs：只收字符串值；坏 JSON 当没发过', () => {
    expect(parseConnectionRefs(JSON.stringify({ a: 'om_1', b: 2, c: '' }))).toEqual({ a: 'om_1' })
    expect(parseConnectionRefs('om_1')).toEqual({})
    expect(parseConnectionRefs('[]')).toEqual({})
    expect(parseConnectionRefs(null)).toEqual({})
  })

  it('env 隔离清单包含别的 agent 留下的工作区变量', () => {
    expect([...LARK_ENV_UNSET]).toEqual(['HERMES_HOME', 'OPENCLAW_HOME', 'LARK_CHANNEL'])
  })
})

describe('飞书通道：多连接投递与分流（M45）', () => {
  const TWO = {
    connections: JSON.stringify([
      { id: 'wb', label: '工作台', profile: 'workbench', user: 'ou_me' },
      { id: 'me', label: '私人', profile: 'mine', chat: 'oc_2', answerers: ['ou_me'] },
    ]),
  }

  it('两条连接各发一条卡片：ref 按连接聚合成一个 JSON，各条都带自己的 --profile', async () => {
    const { harness, cli } = await startWith(TWO, [
      { hang: true },
      { hang: true },
      { stdout: okBody({ message_id: 'om_a' }) },
      { stdout: okBody({ message_id: 'om_b' }) },
    ])

    harness.deliver(inst())
    await flushDeliver()

    const sends = cli.calls.filter((call) => call.args.includes('+messages-send'))
    expect(sends).toHaveLength(2)
    expect(sends[0]?.args.slice(0, 3)).toEqual(['--profile', 'workbench', 'im'])
    expect(sends[0]?.args).toContain('--user-id')
    expect(sends[1]?.args.slice(0, 3)).toEqual(['--profile', 'mine', 'im'])
    expect(sends[1]?.args).toContain('--chat-id')
    expect(harness.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: JSON.stringify({ wb: 'om_a', me: 'om_b' }) },
    ])
    // 每条连接都用自己的环境（不继承 hermes 的工作区）
    expect(cli.calls[0]?.options.envPatch).toEqual({ unset: [...LARK_ENV_UNSET] })
  })

  it('一条连接失败：另一条照样送达，ref 只记成功的那条（失败的下次再发）', async () => {
    const { harness, logs } = await startWith(TWO, [
      { hang: true },
      { hang: true },
      { code: 1, stderr: 'no scope' },
      { stdout: okBody({ message_id: 'om_b' }) },
    ])

    harness.deliver(inst())
    await flushDeliver()

    expect(logs.join('\n')).toContain('连接 wb')
    expect(harness.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: JSON.stringify({ me: 'om_b' }) },
    ])
  })

  it('第二版：按聚合 ref 逐连接原地 patch（各改自己那条消息）', async () => {
    const { harness, cli } = await startWith(TWO, [
      { hang: true },
      { hang: true },
      { stdout: okBody({ message_id: 'om_a' }) },
      { stdout: okBody({ message_id: 'om_b' }) },
      { stdout: okBody({}) },
      { stdout: okBody({}) },
    ])

    harness.deliver(inst())
    await flushDeliver()
    harness.deliver(inst({ version: 2, title: '换个问题' }))
    await flushDeliver()

    const patches = cli.calls.filter((call) => call.args.includes('patch'))
    expect(patches).toHaveLength(2)
    expect(patches[0]?.args).toContain('om_a')
    expect(patches[1]?.args).toContain('om_b')
    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(2)
  })

  it('某条连接没有发送目标：它不投递（只记一次日志），另一条照常工作', async () => {
    const { harness, cli, logs } = await startWith(
      {
        connections: JSON.stringify([
          { id: 'broken', label: '没配', profile: 'bad' },
          { id: 'wb', label: '工作台', profile: 'workbench', user: 'ou_me' },
        ]),
      },
      [
        { code: 1, stderr: 'not logged in' },
        { hang: true },
        { hang: true },
        { stdout: okBody({ message_id: 'om_1' }) },
      ],
    )

    harness.deliver(inst())
    await flushDeliver()

    expect(harness.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: JSON.stringify({ wb: 'om_1' }) },
    ])
    expect(cli.calls.filter((call) => call.args.includes('+messages-send'))).toHaveLength(1)
    expect(logs.join('\n')).toContain('先在设置里填接收人或群')
  })

  it('点击按连接校验：当前版本那条消息计入，别的消息（旧版/别人的）忽略', async () => {
    const { harness, cli, logs } = await startWith(TWO, [
      { hang: true },
      { hang: true },
      { stdout: okBody({ message_id: 'om_a' }) },
      { stdout: okBody({ message_id: 'om_b' }) },
    ])

    harness.deliver(inst())
    await flushDeliver()

    // conn wb 的监听进程是第 0 个
    cli.children[0]?.emitStdout(clickEvent({ message_id: 'om_a' }))
    await flushDeliver()
    cli.children[0]?.emitStdout(clickEvent({ message_id: 'om_stale' }))
    await flushDeliver()

    expect(harness.answers).toEqual([{ cardId: 'card-1', optionIndex: 1, byRef: 'ou_me' }])
    expect(logs.join('\n')).toContain('不是当前版本的那条消息')
  })

  it('每条连接只挂一条长连接，而且只订阅卡片点击（不做入站）', async () => {
    const { cli } = await startWith(
      {
        connections: JSON.stringify([
          { id: 'a', label: 'A', user: 'ou_1' },
          { id: 'b', label: 'B', user: 'ou_2' },
        ]),
      },
      [{ hang: true }, { hang: true }],
    )

    const consumes = cli.calls.filter((call) => call.args.includes('event'))
    expect(consumes).toHaveLength(2)
    expect(consumes.every((call) => call.args.includes('card.action.trigger'))).toBe(true)
    expect(consumes.some((call) => call.args.includes('im.message.receive_v1'))).toBe(false)
  })

  it('连接之间不共享消息记录：A 的连接不会替 B 的消息作答', async () => {
    const { harness, cli } = await startWith(TWO, [
      { hang: true },
      { hang: true },
      { stdout: okBody({ message_id: 'om_a' }) },
      { stdout: okBody({ message_id: 'om_b' }) },
    ])

    harness.deliver(inst())
    await flushDeliver()

    // 用 conn wb 的监听进程去点 conn me 的消息
    cli.children[0]?.emitStdout(clickEvent({ message_id: 'om_b' }))
    await flushDeliver()

    expect(harness.answers).toEqual([])
  })
})
