// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { LarkAdminAction } from '@workbench/protocol/ipc'
import type { LarkAdmin } from '@workbench/host/lark-admin'
import type { SpawnFn, Spawned, SpawnOptions } from '@workbench/capabilities/types'

vi.mock('@workbench/host/executable', () => ({
  resolveExecutable: vi.fn((command: string) => ({
    path: `/usr/local/bin/${command}`,
    error: null,
  })),
  defaultScanDirs: () => [],
  findInDirs: () => null,
}))

import { resolveExecutable } from '@workbench/host/executable'

const {
  asLarkAction,
  createLarkAdmin,
  exitReason,
  failureOf,
  parseConfigShow,
  parseLoginStart,
  parseProfiles,
  parseWhoami,
  profileArgs,
  reasonLines,
  runLarkAction,
} = await import('@workbench/host/lark-admin')

// ---------------------------------------------------------------- 假 CLI

interface Behavior {
  stdout?: string
  stderr?: string
  code?: number | null
  error?: Error
  hang?: boolean
}

class FakeChild implements Spawned {
  readonly pid = 4_242
  readonly written: string[] = []
  readonly killed: string[] = []
  private readonly out = new EventEmitter()
  private readonly err = new EventEmitter()
  private errorCb: ((error: Error) => void) | null = null
  private closeCb: ((code: number | null, signal: string | null) => void) | null = null

  readonly stdin = {
    write: (chunk: unknown): boolean => {
      this.written.push(String(chunk))
      return true
    },
    end: (): void => undefined,
  } as unknown as NodeJS.WritableStream

  get stdout(): NodeJS.ReadableStream {
    return this.out as unknown as NodeJS.ReadableStream
  }

  get stderr(): NodeJS.ReadableStream {
    return this.err as unknown as NodeJS.ReadableStream
  }

  onError(cb: (error: Error) => void): void {
    this.errorCb = cb
  }

  onClose(cb: (code: number | null, signal: string | null) => void): void {
    this.closeCb = cb
  }

  kill(signal: NodeJS.Signals): void {
    this.killed.push(signal)
    this.close(null, null)
  }

  emitStdout(text: string): void {
    this.out.emit('data', text)
  }

  emitStderr(text: string): void {
    this.err.emit('data', text)
  }

  emitError(error: Error): void {
    this.errorCb?.(error)
  }

  close(code: number | null, signal: string | null = null): void {
    this.closeCb?.(code, signal)
  }
}

interface FakeCli {
  spawn: SpawnFn
  calls: Array<{ command: string; args: string[]; options: SpawnOptions }>
  children: FakeChild[]
}

/** 假 spawn：按队列依次给行为；缺省 hang（登录轮询场景不会被用到超时路径）。 */
function fakeCli(behaviors: Behavior[] = []): FakeCli {
  const queue = [...behaviors]
  const calls: FakeCli['calls'] = []
  const children: FakeChild[] = []
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new FakeChild()
    children.push(child)
    const behavior = queue.shift() ?? { code: 0, stdout: '' }
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
  }
  return { spawn, calls, children }
}

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

const SHOW_TEXT = `{
  "appId": "cli_workbench",
  "appSecret": "****",
  "brand": "feishu",
  "workspace": "local"
}

Config file path: C:\\Users\\me\\.lark-cli\\config.json
`

const SHOW_FOREIGN = `{
  "appId": "cli_hermes",
  "workspace": "hermes"
}

Config file path: C:\\Users\\me\\.lark-cli\\hermes\\config.json
`

const WHOAMI = JSON.stringify({
  profile: 'cli_workbench',
  appId: 'cli_workbench',
  brand: 'feishu',
  identity: 'bot',
  available: true,
  tokenStatus: 'ready',
})

const PROFILES = JSON.stringify([
  {
    name: 'cli_workbench',
    appId: 'cli_workbench',
    brand: 'feishu',
    active: true,
    user: '岳智明',
    tokenStatus: 'ready',
  },
])

describe('lark-admin：输出解析', () => {
  it('parseConfigShow：从人读输出里取工作区 / 应用 / 配置文件路径', () => {
    expect(parseConfigShow(SHOW_TEXT)).toEqual({
      workspace: 'local',
      appId: 'cli_workbench',
      configPath: 'C:\\Users\\me\\.lark-cli\\config.json',
    })
  })

  it('parseConfigShow：不是 JSON 也不抛，能取到什么算什么', () => {
    expect(parseConfigShow('garbage')).toEqual({
      workspace: null,
      appId: null,
      configPath: null,
    })
    expect(parseConfigShow('{"workspace":""}')).toEqual({
      workspace: null,
      appId: null,
      configPath: null,
    })
  })

  it('parseWhoami：只认字符串字段与 available=true', () => {
    expect(parseWhoami(WHOAMI)).toEqual({
      appId: 'cli_workbench',
      identity: 'bot',
      available: true,
      tokenStatus: 'ready',
      profile: 'cli_workbench',
    })
    expect(parseWhoami('{}')).toEqual({
      appId: null,
      identity: null,
      available: false,
      tokenStatus: null,
      profile: null,
    })
    expect(parseWhoami('not json')).toMatchObject({ appId: null, available: false })
  })

  it('parseProfiles：数组里合法的行才收，缺 name 跳过', () => {
    expect(parseProfiles(PROFILES)).toEqual([
      {
        name: 'cli_workbench',
        appId: 'cli_workbench',
        brand: 'feishu',
        active: true,
        user: '岳智明',
        tokenStatus: 'ready',
      },
    ])
    expect(parseProfiles('[{"appId":"cli_x"}, 1, null, {"name":"n"}]')).toEqual([
      { name: 'n', appId: 'n', brand: 'feishu', active: false, user: null, tokenStatus: null },
    ])
    expect(parseProfiles('{}')).toEqual([])
  })

  it('failureOf：只认 ok:false / 带 error 的信封，取 message 或整体', () => {
    expect(failureOf(JSON.stringify({ ok: false, error: { message: '坏了' } }))).toBe('坏了')
    expect(failureOf(JSON.stringify({ error: '纯文本原因' }))).toBe('"纯文本原因"')
    expect(failureOf(JSON.stringify({ ok: true }))).toBeNull()
    expect(failureOf('not json')).toBeNull()
    expect(failureOf('[]')).toBeNull()
  })

  it('parseLoginStart：拿 verification_url + device_code；缺字段与失败帧都给可读错误', () => {
    const ok = JSON.stringify({
      device_code: 'dc',
      expires_in: 600,
      verification_url: 'https://accounts.feishu.cn/verify',
    })
    expect(parseLoginStart(ok)).toEqual({
      ok: true,
      deviceCode: 'dc',
      verificationUrl: 'https://accounts.feishu.cn/verify',
      expiresIn: 600,
    })
    expect(parseLoginStart(JSON.stringify({ device_code: 'dc' }))).toEqual({
      ok: false,
      error: '登录没有返回验证链接，稍后重试',
    })
    expect(parseLoginStart(JSON.stringify({ ok: false, error: { message: '无权限' } }))).toEqual({
      ok: false,
      error: '无权限',
    })
  })

  it('profileArgs：空 profile 不传 --profile', () => {
    expect(profileArgs(null)).toEqual([])
    expect(profileArgs('wb')).toEqual(['--profile', 'wb'])
  })
})

describe('lark-admin：动作校验与分发', () => {
  it('asLarkAction：合法动作原样归一，非法输入一律 null', () => {
    expect(asLarkAction({ action: 'status' })).toEqual({ action: 'status' })
    expect(asLarkAction(null)).toBeNull()
    expect(asLarkAction([])).toBeNull()
    expect(asLarkAction({ action: 'nope' })).toBeNull()
    expect(asLarkAction({ action: 'add-profile', name: 'a', appId: 'b', secret: 1 })).toBeNull()
    expect(asLarkAction({ action: 'add-profile', name: 'a', appId: 'b' })).toBeNull()
    expect(
      asLarkAction({ action: 'add-profile', name: 'a', appId: 'b', secret: 's', brand: 'lark' }),
    ).toEqual({ action: 'add-profile', name: 'a', appId: 'b', secret: 's', brand: 'lark' })
    expect(asLarkAction({ action: 'login-start', profile: 2 })).toBeNull()
    expect(asLarkAction({ action: 'login-start', domain: 'im' })).toEqual({
      action: 'login-start',
      domain: 'im',
    })
    expect(asLarkAction({ action: 'login-poll', deviceCode: 'd' })).toEqual({
      action: 'login-poll',
      deviceCode: 'd',
    })
    expect(asLarkAction({ action: 'login-poll', profile: 'p' })).toBeNull()
    expect(asLarkAction({ action: 'logout' })).toEqual({ action: 'logout' })
    expect(asLarkAction({ action: 'logout', profile: 3 })).toBeNull()
    expect(asLarkAction({ action: 'remove-profile', name: 'wb' })).toEqual({
      action: 'remove-profile',
      name: 'wb',
    })
    expect(asLarkAction({ action: 'remove-profile' })).toBeNull()
    expect(asLarkAction({ action: 'remove-profile', name: 1 })).toBeNull()
  })

  it('runLarkAction：把动作参数映射到实现上（含可选字段省略）', async () => {
    const admin = {
      status: vi.fn(async () => ({ ok: true })),
      addProfile: vi.fn(async () => ({ ok: true })),
      loginStart: vi.fn(async () => ({ ok: true })),
      loginPoll: vi.fn(async () => ({ ok: true })),
      logout: vi.fn(async () => ({ ok: true })),
      removeProfile: vi.fn(async () => ({ ok: true })),
    }
    const actions: LarkAdminAction[] = [
      { action: 'status' },
      { action: 'add-profile', name: 'a', appId: 'b', secret: 's' },
      { action: 'login-start' },
      { action: 'login-poll', deviceCode: 'd' },
      { action: 'logout' },
      { action: 'remove-profile', name: 'wb' },
    ]
    for (const action of actions) await runLarkAction(admin as unknown as LarkAdmin, action)
    expect(admin.addProfile).toHaveBeenCalledWith({ name: 'a', appId: 'b', secret: 's' })
    expect(admin.loginStart).toHaveBeenCalledWith({})
    expect(admin.loginPoll).toHaveBeenCalledWith({ deviceCode: 'd' })
    expect(admin.logout).toHaveBeenCalledWith({})
    expect(admin.removeProfile).toHaveBeenCalledWith({ name: 'wb' })
  })
})

describe('lark-admin：status 探测', () => {
  it('正常：剔除 HERMES_HOME 后看本程序的应用，并把别的 agent 的绑定比出来', async () => {
    const cli = fakeCli([
      { stdout: SHOW_TEXT },
      { stdout: WHOAMI },
      { stdout: PROFILES },
      { stdout: SHOW_FOREIGN },
    ])
    const admin = createLarkAdmin({
      spawn: cli.spawn,
      env: { HERMES_HOME: 'C:/hermes', PATH: '/bin' },
    })
    const status = await admin.status()

    expect(status).toMatchObject({
      ok: true,
      program: '/usr/local/bin/lark-cli',
      workspace: 'local',
      appId: 'cli_workbench',
      identity: 'bot',
      available: true,
      tokenStatus: 'ready',
      foreign: { workspace: 'hermes', appId: 'cli_hermes' },
      conflict: false,
    })
    expect(status.profiles).toHaveLength(1)
    expect(status.hint).toBeNull()
    // 本程序的三次调用都不带 HERMES_HOME；比对用的那次带着
    expect(cli.calls[0]?.options.env?.['HERMES_HOME']).toBeUndefined()
    expect(cli.calls[3]?.options.env?.['HERMES_HOME']).toBe('C:/hermes')
  })

  it('撞车：两边同一个 appId 时 conflict=true 并给出换应用的提示', async () => {
    const cli = fakeCli([
      { stdout: SHOW_TEXT },
      { stdout: JSON.stringify({ appId: 'cli_hermes', identity: 'bot', available: true }) },
      { stdout: PROFILES },
      { stdout: SHOW_FOREIGN },
    ])
    const status = await createLarkAdmin({
      spawn: cli.spawn,
      env: { HERMES_HOME: 'C:/hermes' },
    }).status()
    expect(status.conflict).toBe(true)
    expect(status.hint).toContain('同一个飞书应用')
  })

  it('本机没有 HERMES_HOME：不做比对（foreign=null），提示去建 profile', async () => {
    const cli = fakeCli([{ stdout: SHOW_TEXT }, { stdout: WHOAMI }, { stdout: '[]' }])
    const status = await createLarkAdmin({ spawn: cli.spawn, env: {} }).status()
    expect(status.foreign).toBeNull()
    expect(status.profiles).toEqual([])
    expect(status.hint).toContain('还没有飞书 profile')
  })

  it('找不到 CLI：不 spawn，直接给安装/登录提示', async () => {
    vi.mocked(resolveExecutable).mockReturnValueOnce({ path: null, error: '未在 PATH 中' })
    const cli = fakeCli()
    const admin = createLarkAdmin({ spawn: cli.spawn, env: {} })
    const status = await admin.status()
    expect(status.ok).toBe(false)
    expect(status.error).toContain('找不到 lark-cli')
    expect(status.hint).toContain('npm i -g')
    expect(cli.calls).toHaveLength(0)
  })

  it('CLI 非零退出：不算启动失败（error 为空），仍按现有 profile 给建议', async () => {
    const cli = fakeCli([
      { code: 1, stderr: 'boom' },
      { code: 1, stderr: 'boom' },
      { code: 1, stderr: 'boom' },
    ])
    const status = await createLarkAdmin({ spawn: cli.spawn, env: {} }).status()
    expect(status.ok).toBe(true)
    expect(status.error).toBeNull()
    expect(status.hint).toContain('还没有飞书 profile')
  })

  it('spawn/超时失败：error 落到视图上', async () => {
    const cli = fakeCli([{ error: new Error('管道断了') }])
    const status = await createLarkAdmin({ spawn: cli.spawn, env: {} }).status()
    expect(status.ok).toBe(false)
    expect(status.error).toContain('管道断了')
    expect(status.hint).toContain('auth login')
  })

  it('超时：终止子进程并给出超时原因', async () => {
    const cli = fakeCli([{ hang: true }, { hang: true }, { hang: true }])
    const admin = createLarkAdmin({ spawn: cli.spawn, env: {}, timeoutMs: 5 })
    const status = await admin.status()
    expect(status.error).toContain('超时')
    expect(cli.children[0]?.killed).toEqual(['SIGKILL'])
  })
})

describe('lark-admin：动作', () => {
  const env = { PATH: '/bin' }

  it('add-profile：成功时把 secret 从 stdin 交给 CLI，不进 argv', async () => {
    const cli = fakeCli([{ stdout: '' }])
    const result = await createLarkAdmin({ spawn: cli.spawn, env }).addProfile({
      name: 'workbench',
      appId: 'cli_abc',
      secret: 'super-secret',
    })
    expect(result).toEqual({ ok: true })
    expect(cli.calls[0]?.args).toEqual([
      'profile',
      'add',
      '--name',
      'workbench',
      '--app-id',
      'cli_abc',
      '--brand',
      'feishu',
      '--app-secret-stdin',
    ])
    expect(cli.calls[0]?.args.join(' ')).not.toContain('super-secret')
    expect(cli.children[0]?.written).toEqual(['super-secret'])
  })

  it('add-profile：非法名 / 非法 appId / 空 secret 都在本地拒绝（不跑 CLI）', async () => {
    const cli = fakeCli()
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    const badName = await admin.addProfile({ name: 'bad name', appId: 'cli_abc', secret: 's' })
    expect(badName.ok).toBe(false)
    expect(badName.error).toContain('连接标识')
    expect(await admin.addProfile({ name: 'ok', appId: 'x', secret: 's' })).toMatchObject({
      ok: false,
    })
    expect(await admin.addProfile({ name: 'ok', appId: 'cli_abc', secret: '  ' })).toMatchObject({
      ok: false,
    })
    expect(cli.calls).toHaveLength(0)
  })

  it('add-profile：CLI 失败帧 / 非零退出 / spawn 报错都折算成 ok:false', async () => {
    const failure = fakeCli([
      { stdout: JSON.stringify({ ok: false, error: { message: 'app 已存在' } }) },
    ])
    expect(
      await createLarkAdmin({ spawn: failure.spawn, env }).addProfile({
        name: 'wb',
        appId: 'cli_abc',
        secret: 's',
      }),
    ).toEqual({ ok: false, error: 'app 已存在' })

    const nonzero = fakeCli([{ code: 2, stderr: 'bad secret' }])
    expect(
      await createLarkAdmin({ spawn: nonzero.spawn, env }).addProfile({
        name: 'wb',
        appId: 'cli_abc',
        secret: 's',
      }),
    ).toEqual({ ok: false, error: 'bad secret' })

    const crashed = fakeCli([{ error: new Error('no pipe') }])
    expect(
      await createLarkAdmin({ spawn: crashed.spawn, env }).addProfile({
        name: 'wb',
        appId: 'cli_abc',
        secret: 's',
      }),
    ).toEqual({ ok: false, error: 'no pipe' })

    const stderrOnly = fakeCli([{ code: 2, stdout: JSON.stringify({ ok: false, error: 'x' }) }])
    expect(
      await createLarkAdmin({ spawn: stderrOnly.spawn, env }).addProfile({
        name: 'wb',
        appId: 'cli_abc',
        secret: 's',
      }),
    ).toMatchObject({ ok: false })
  })

  it('login-start：带 profile 与 domain，缺省 domain=im', async () => {
    const ok = JSON.stringify({
      device_code: 'dc',
      expires_in: 600,
      verification_url: 'https://accounts.feishu.cn/verify',
    })
    const cli = fakeCli([{ stdout: ok }, { stdout: ok }])
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    expect(await admin.loginStart({})).toMatchObject({ ok: true, deviceCode: 'dc' })
    expect(cli.calls[0]?.args).toEqual(['auth', 'login', '--no-wait', '--json', '--domain', 'im'])
    expect(await admin.loginStart({ profile: 'wb', domain: 'im,doc' })).toMatchObject({ ok: true })
    expect(cli.calls[1]?.args.slice(0, 3)).toEqual(['--profile', 'wb', 'auth'])
    expect(cli.calls[1]?.args).toContain('im,doc')
  })

  it('login-start：profile 非法 / CLI 报错 / 非零且没有链接都 ok:false', async () => {
    const cli = fakeCli([
      { error: new Error('x') },
      { code: 2, stderr: 'denied' },
      { stdout: JSON.stringify({ device_code: 'dc' }) },
    ])
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    expect(await admin.loginStart({ profile: 'bad name' })).toEqual({
      ok: false,
      error: 'profile 名非法',
    })
    expect(await admin.loginStart({})).toEqual({ ok: false, error: 'x' })
    expect(await admin.loginStart({})).toEqual({ ok: false, error: 'denied' })
    expect(await admin.loginStart({})).toMatchObject({ ok: false })
  })

  it('login-poll：成功 / 缺 device code / 失败帧 / 非零退出', async () => {
    const cli = fakeCli([
      { stdout: JSON.stringify({ ok: true }) },
      { stdout: JSON.stringify({ ok: false, error: { message: '还没授权' } }) },
      { code: 3, stderr: 'boom' },
    ])
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    expect(await admin.loginPoll({ deviceCode: 'd' })).toEqual({ ok: true })
    expect(cli.calls[0]?.args).toEqual(['auth', 'login', '--device-code', 'd', '--json'])
    expect(await admin.loginPoll({ deviceCode: ' ' })).toEqual({
      ok: false,
      error: '缺少 device code',
    })
    expect(await admin.loginPoll({ deviceCode: 'd' })).toEqual({ ok: false, error: '还没授权' })
    expect(await admin.loginPoll({ profile: 'wb', deviceCode: 'd' })).toEqual({
      ok: false,
      error: 'boom',
    })
    expect(await admin.loginPoll({ profile: 'bad profile', deviceCode: 'd' })).toEqual({
      ok: false,
      error: 'profile 名非法',
    })
  })

  it('login-poll：CLI 只打进度日志且退出非零时，给真实原因而不是日志行', async () => {
    const cli = fakeCli([
      {
        code: 1,
        stderr: '[lark-cli] device-flow: token response received\nThe operation was canceled.\n',
      },
      { code: 0, stdout: JSON.stringify({ available: false, tokenStatus: null }) },
    ])
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    expect(await admin.loginPoll({ deviceCode: 'd' })).toEqual({
      ok: false,
      error: 'The operation was canceled.',
    })
  })

  it('login-poll：stderr 全是进度日志时给带退出码的兜底文案（不把日志当错误）', async () => {
    const cli = fakeCli([
      { code: 1, stderr: '[lark-cli] device-flow: token response received\n' },
      { code: 0, stdout: JSON.stringify({ available: false }) },
    ])
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    const result = await admin.loginPoll({ deviceCode: 'd' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('退出码 1')
    expect(result.ok === false && result.error).not.toContain('[lark-cli]')
  })

  it('login-poll：退出码非零但 token 已经就绪时算登录成功（写存储失败别让人重复点）', async () => {
    const cli = fakeCli([
      {
        code: 1,
        stderr:
          '[lark-cli] device-flow: token response received\nfailed to acquire token storage lock for user "u"\n',
      },
      {
        code: 0,
        stdout: JSON.stringify({ appId: 'cli_x', available: true, tokenStatus: 'valid' }),
      },
    ])
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    expect(await admin.loginPoll({ profile: 'wb', deviceCode: 'd' })).toEqual({ ok: true })
    // 复查用的是同一个 profile（`--profile wb whoami`），不是「当前 profile」
    expect(cli.calls[1]?.args).toEqual(['--profile', 'wb', 'whoami'])
  })

  it('reasonLines / exitReason：剔掉 [lark-cli] 日志，失败信封优先，其余给退出码兜底', () => {
    expect(reasonLines('[lark-cli] x\n\n  boom  \n')).toEqual(['boom'])
    expect(reasonLines('')).toEqual([])
    expect(
      exitReason(1, JSON.stringify({ ok: false, error: { message: '没权限' } }), '[lark-cli] log'),
    ).toBe('没权限')
    expect(exitReason(1, '', '[lark-cli] a\nreal reason\n')).toBe('real reason')
    // 日志与 JSON 帧混在一起：整段不是 JSON，也要能认出那一帧
    expect(exitReason(1, '[lark-cli] log\n{"ok":false,"error":{"message":"帧原因"}}\n', '')).toBe(
      '帧原因',
    )
    expect(exitReason(7, '', '[lark-cli] only log\n')).toBe(
      'lark-cli 退出码 7，没有给出原因：稍后再试一次；反复失败就重新发起登录',
    )
  })
  it('logout：成功 / 失败帧 / 非零退出 / spawn 报错 / 非法 profile', async () => {
    const cli = fakeCli([
      { stdout: JSON.stringify({ ok: true }) },
      { stdout: JSON.stringify({ ok: false, error: { message: '没登录' } }) },
      { code: 4, stderr: 'still logged in' },
      { error: new Error('no pipe') },
    ])
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    expect(await admin.logout({ profile: 'wb' })).toEqual({ ok: true })
    expect(cli.calls[0]?.args).toEqual(['--profile', 'wb', 'auth', 'logout'])
    expect(await admin.logout({})).toEqual({ ok: false, error: '没登录' })
    expect(await admin.logout({})).toEqual({ ok: false, error: 'still logged in' })
    expect(await admin.logout({})).toEqual({ ok: false, error: 'no pipe' })
    expect(await admin.logout({ profile: 'bad name' })).toEqual({
      ok: false,
      error: 'profile 名非法',
    })
  })

  it('remove-profile：位置参数删 profile；失败帧 / 非零退出 / spawn 报错 / 非法名都折算成 ok:false', async () => {
    const cli = fakeCli([
      { stdout: JSON.stringify({ ok: true }) },
      { stdout: JSON.stringify({ ok: false, error: { message: 'profile "gone" not found' } }) },
      { code: 5, stderr: 'locked' },
      { code: 6, stdout: '  ' },
      { error: new Error('no pipe') },
    ])
    const logs: string[] = []
    const admin = createLarkAdmin({
      spawn: cli.spawn,
      env,
      log: (line) => logs.push(line),
    })
    expect(await admin.removeProfile({ name: ' workbench ' })).toEqual({ ok: true })
    // 名字是位置参数：不能拼到 `--profile` 上（那是「用哪个 profile 跑」）
    expect(cli.calls[0]?.args).toEqual(['profile', 'remove', 'workbench'])
    expect(logs).toEqual(['[lark-admin] 已删除 profile workbench'])
    expect(await admin.removeProfile({ name: 'gone' })).toEqual({
      ok: false,
      error: 'profile "gone" not found',
    })
    expect(await admin.removeProfile({ name: 'wb' })).toEqual({ ok: false, error: 'locked' })
    // 没有任何输出时不再回一句空文案：给退出码 + 「稍后再试 / 重新发起」
    expect(await admin.removeProfile({ name: 'wb' })).toEqual({
      ok: false,
      error: 'lark-cli 退出码 6，没有给出原因：稍后再试一次；反复失败就重新发起登录',
    })
    expect(await admin.removeProfile({ name: 'wb' })).toEqual({ ok: false, error: 'no pipe' })
    expect(await admin.removeProfile({ name: 'bad name' })).toEqual({
      ok: false,
      error: 'profile 名非法',
    })
    expect(cli.calls).toHaveLength(5)
  })

  it('after flush：进程输出收集完整（stdout 拼接）', async () => {
    const cli = fakeCli([{ stdout: WHOAMI }])
    const admin = createLarkAdmin({ spawn: cli.spawn, env })
    const pending = admin.loginStart({})
    await flush()
    expect(cli.calls).toHaveLength(1)
    await pending
  })
})
