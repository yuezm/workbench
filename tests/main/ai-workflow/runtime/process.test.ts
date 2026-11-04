// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { createLineReader, defaultSpawn, killProcessTree, tail } =
  await import('../../../../src/main/ai-workflow/runtime/process')

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
