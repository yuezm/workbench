// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const {
  createLineReader,
  applyEnvPatch,
  defaultSpawn,
  killPidTree,
  killProcessTree,
  resolveShimScript,
  tail,
} = await import('@workbench/host/process')

function fakeChild(): {
  pid: number
  stdin: { end: () => void }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
} {
  return {
    pid: 123,
    stdin: { end: () => {} },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    on: vi.fn(),
  }
}

afterEach(() => {
  spawnMock.mockReset()
  vi.restoreAllMocks()
})

describe('createLineReader', () => {
  it('按行切分，跳过空行，容忍 \\r\\n 与跨 chunk 半行', () => {
    const lines: string[] = []
    const reader = createLineReader((line) => lines.push(line))
    reader.push('a\nb\r')
    reader.push('\nc\n')
    reader.push('  \n')
    expect(lines).toEqual(['a', 'b', 'c'])
    reader.push('tail')
    reader.flush()
    expect(lines).toEqual(['a', 'b', 'c', 'tail'])
    reader.flush()
    expect(lines).toEqual(['a', 'b', 'c', 'tail'])
  })

  it('每行只回调一次（一行内多段也能拆开）', () => {
    const lines: string[] = []
    const reader = createLineReader((line) => lines.push(line))
    reader.push('1\n2\n3\n')
    expect(lines).toEqual(['1', '2', '3'])
    reader.flush()
    expect(lines).toEqual(['1', '2', '3'])
  })
})

describe('tail', () => {
  it('未超限原样返回，超限保留尾部并加省略号', () => {
    expect(tail('abc', 5)).toBe('abc')
    expect(tail('abcdef', 4)).toBe('…cdef')
  })
})

describe('applyEnvPatch', () => {
  it('先删 unset 再按 set 覆盖，其余键原样继承', () => {
    const base = { PATH: '/bin', HERMES_HOME: 'C:/hermes', KEEP: '1' }
    expect(applyEnvPatch(base, { unset: ['HERMES_HOME'], set: { LARK: '1' } })).toEqual({
      PATH: '/bin',
      KEEP: '1',
      LARK: '1',
    })
  })

  it('只给 unset / 只给 set / 都不给：都不改动原对象', () => {
    const base = { A: '1', B: '2' }
    expect(applyEnvPatch(base, { unset: ['A'] })).toEqual({ B: '2' })
    expect(applyEnvPatch(base, { set: { B: '3' } })).toEqual({ A: '1', B: '3' })
    expect(applyEnvPatch(base, {})).toEqual({ A: '1', B: '2' })
    expect(base).toEqual({ A: '1', B: '2' })
  })
})

describe('defaultSpawn', () => {
  it('包装真实子进程：转发事件与 kill', () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const wrapped = defaultSpawn('dsh.cmd', ['--profile', 'multica'], {
      cwd: 'C:/work',
      env: {},
      shell: true,
    })
    expect(spawnMock).toHaveBeenCalledWith('dsh.cmd', ['--profile', 'multica'], {
      cwd: 'C:/work',
      env: {},
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(wrapped.pid).toBe(123)
    expect(wrapped.stdout).toBe(child.stdout)
    expect(wrapped.stderr).toBe(child.stderr)
    // 事件经 child.on 注册（wrapper 在被订阅时才挂到真实子进程上）
    const onError = vi.fn()
    const onClose = vi.fn()
    wrapped.onError(onError)
    wrapped.onClose(onClose)
    const closeCb = child.on.mock.calls.find(([event]) => event === 'close')?.[1] as (
      code: number | null,
      signal: string | null,
    ) => void
    const errorCb = child.on.mock.calls.find(([event]) => event === 'error')?.[1] as (
      error: Error,
    ) => void
    errorCb(new Error('x'))
    closeCb(1, null)
    expect(onError).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledWith(1, null)
    wrapped.kill('SIGKILL')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('未指定 shell：默认 false（只有 Windows 的 .cmd/.bat 才经 shell 启动）', () => {
    spawnMock.mockReturnValue(fakeChild())

    defaultSpawn('dsh', [], { env: {} })

    expect(spawnMock).toHaveBeenCalledWith('dsh', [], expect.objectContaining({ shell: false }))
  })

  it('envPatch：在给定的 env 之上增删（剔除别的 agent 的工作区变量）', () => {
    spawnMock.mockReturnValue(fakeChild())

    defaultSpawn('lark-cli', ['whoami'], {
      env: { PATH: '/bin', HERMES_HOME: 'C:/hermes', OPENCLAW_HOME: 'C:/oc' },
      envPatch: { unset: ['HERMES_HOME', 'OPENCLAW_HOME'], set: { LARK: '1' } },
    })

    expect(spawnMock).toHaveBeenCalledWith(
      'lark-cli',
      ['whoami'],
      expect.objectContaining({ env: { PATH: '/bin', LARK: '1' } }),
    )
  })

  it('envPatch 未给 env 时以宿主环境为底（只删指定的键）', () => {
    spawnMock.mockReturnValue(fakeChild())

    defaultSpawn('lark-cli', [], { envPatch: { unset: ['DSH_TEST_SHOULD_BE_GONE'] } })

    const options = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }
    expect(options.env).not.toBe(process.env)
    expect(options.env['PATH']).toBe(process.env['PATH'])
    expect('DSH_TEST_SHOULD_BE_GONE' in options.env).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'Windows 垫片：折回 node + 脚本，参数原样进 argv（不经 cmd 吃引号）',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-shim-'))
      try {
        const script = join(dir, 'node_modules', 'pkg', 'run.js')
        mkdirSync(dirname(script), { recursive: true })
        writeFileSync(script, 'console.log(1)\n')
        const shim = join(dir, 'tool.cmd')
        // npm 垫片模板：`%_prog%` 跑 `%dp0%` 下的脚本，`%*` 转发全部参数
        writeFileSync(
          shim,
          [
            '@ECHO off',
            'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\run.js" %*',
            '',
          ].join('\r\n'),
        )
        spawnMock.mockReturnValue(fakeChild())

        defaultSpawn(shim, ['--content', '{"text":"a b & c"}'], { shell: true, env: {} })

        const [calledCommand, calledArgs, calledOptions] = spawnMock.mock.calls[0] as [
          string,
          string[],
          { shell: boolean },
        ]
        // 用 PATH 上的 node，不是宿主的 electron.exe（后者会把 Electron 运行时指纹带给子进程）
        expect(calledCommand).toBe('node')
        expect(calledArgs).toEqual([script, '--content', '{"text":"a b & c"}'])
        expect(calledOptions.shell).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'Windows 垫片：同目录有 node.exe 时直接用它的绝对路径',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-shim-'))
      try {
        const script = join(dir, 'node_modules', 'pkg', 'run.js')
        mkdirSync(dirname(script), { recursive: true })
        writeFileSync(script, 'console.log(1)\n')
        // nvm / 官方安装包把 node.exe 与 npm 垫片放在同一个目录
        writeFileSync(join(dir, 'node.exe'), '')
        const shim = join(dir, 'tool.cmd')
        writeFileSync(
          shim,
          '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || "%_prog%"  "%dp0%\\node_modules\\pkg\\run.js" %*\r\n',
        )
        spawnMock.mockReturnValue(fakeChild())

        defaultSpawn(shim, ['--version'], { shell: true, env: {} })

        expect(spawnMock.mock.calls[0]?.[0]).toBe(join(dir, 'node.exe'))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'win32')('垫片解析不出绝对脚本：回退 shell（行为不变）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-shim-'))
    try {
      const shim = join(dir, 'tool.cmd')
      writeFileSync(shim, '@ECHO off\r\necho hi\r\n')
      spawnMock.mockReturnValue(fakeChild())

      defaultSpawn(shim, ['x'], { shell: true, env: {} })

      expect(spawnMock).toHaveBeenCalledWith(shim, ['x'], expect.objectContaining({ shell: true }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveShimScript', () => {
  it('非 Windows：不折，交给调用方走 shell', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      expect(resolveShimScript('C:/npm/tool.cmd')).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', descriptor as PropertyDescriptor)
    }
  })

  it('不是 .cmd / .bat：不折（原生可执行文件直接 spawn）', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(resolveShimScript('C:/npm/tool.exe')).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', descriptor as PropertyDescriptor)
    }
  })

  it.skipIf(process.platform !== 'win32')('垫片里的脚本不是绝对路径：不折', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-shim-'))
    try {
      const shim = join(dir, 'tool.cmd')
      writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "relative\\run.js" %*\r\n')

      expect(resolveShimScript(shim)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('killPidTree', () => {
  it('对账入口：按 pid 直接清树（固定 SIGKILL 语义，Windows 走 taskkill /T /F）', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      spawnMock.mockReturnValue(fakeChild())
      expect(killPidTree(42)).toBe(true)
      expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '42', '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } finally {
      Object.defineProperty(process, 'platform', descriptor as PropertyDescriptor)
    }
  })
})

describe('killProcessTree', () => {
  it('Windows：用 taskkill /T /F 终止进程树', () => {
    spawnMock.mockReturnValue(fakeChild())
    expect(killProcessTree(42)).toBe(true)
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '42', '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  })

  it('Windows：spawn 抛错时返回 false', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('cannot spawn')
    })
    expect(killProcessTree(42)).toBe(false)
  })

  it('POSIX：优先杀进程组，失败回退单进程', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('no group')
      })
      .mockImplementationOnce(() => true)
    try {
      expect(killProcessTree(7, 'SIGTERM')).toBe(true)
      expect(kill).toHaveBeenNthCalledWith(1, -7, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 7, 'SIGTERM')
    } finally {
      Object.defineProperty(process, 'platform', descriptor as PropertyDescriptor)
    }
  })

  it('POSIX：两次 kill 都失败时返回 false', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('gone')
    })
    try {
      expect(killProcessTree(7)).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', descriptor as PropertyDescriptor)
    }
  })
})
