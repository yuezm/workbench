// @vitest-environment node
/**
 * `command` 运行时探测（M40 补口）：只验「命令能解析 + 参数模板能解析」，不 spawn。
 *
 * 这条 probe 的存在意义是让 `runtime.create` 走通——脚本阶段的连接必须是
 * `executorKey='command'` 的运行时，没有 probe 就一个都建不出来。
 */
import { describe, expect, it } from 'vitest'
import type { Runtime } from '../../../../src/protocol/entities'
import type { ExecutorContext, ResolvedExecutable } from '../../../../src/sdk/types'
import { commandPlugin } from '../../../../src/plugins/executors/command/index'
import { commandManifest } from '../../../../src/plugins/executors/command/manifest'
import { probeCommandRuntime } from '../../../../src/plugins/executors/command/probe'
import { fakeSdk } from '../../support/fake-sdk'

const FIXED_NOW = 1_760_000_000_000

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-command',
  name: '本机命令',
  executorKey: 'command',
  command: 'pnpm',
  profile: '',
  argsTemplate: '',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...over,
})

const found = (path: string) => (): ResolvedExecutable => ({ path, error: null })

const ctxOf = (
  resolve: (command: string) => ResolvedExecutable,
  over: Partial<Runtime> = {},
): ExecutorContext => ({
  runtime: runtime(over),
  sdk: fakeSdk({ resolve, now: () => FIXED_NOW }),
})

describe('probeCommandRuntime', () => {
  it('命令留空：unavailable 且给出必填文案，不调 resolve', async () => {
    let resolved = 0
    const probe = await probeCommandRuntime(
      ctxOf(
        () => {
          resolved += 1
          return { path: 'C:/tools/pnpm.exe', error: null }
        },
        { command: '   ' },
      ),
    )

    expect(resolved).toBe(0)
    expect(probe).toMatchObject({
      state: 'unavailable',
      path: null,
      cliVersion: null,
      pluginVersion: null,
      error: '命令必填：填命令名或绝对路径（如 pnpm）',
    })
  })

  it('解析不到可执行文件：unavailable 并原样用 resolve 的错误文案', async () => {
    const probe = await probeCommandRuntime(
      ctxOf(() => ({ path: null, error: '在 PATH 中找不到命令：pnpm' })),
    )

    expect(probe).toMatchObject({
      state: 'unavailable',
      path: null,
      error: '在 PATH 中找不到命令：pnpm',
    })
  })

  it('解析失败但 resolve 没给原因：按命令名补一条可读兜底', async () => {
    const probe = await probeCommandRuntime(ctxOf(() => ({ path: null, error: null })))

    expect(probe.error).toBe('找不到可执行文件：pnpm')
  })

  it('参数模板非法：unavailable，但保留已解析到的路径（连接本身找得到）', async () => {
    const probe = await probeCommandRuntime(
      ctxOf(found('C:/tools/pnpm.exe'), { argsTemplate: '["--silent"' }),
    )

    expect(probe.state).toBe('unavailable')
    expect(probe.path).toBe('C:/tools/pnpm.exe')
    expect(probe.pluginVersion).toBe(commandManifest.version)
    expect(probe.error).toBe('参数模板非法：argsTemplate 不是合法的 JSON 文本')
  })

  it('正常连接：ready，带路径与插件版本，不猜 CLI / 协议版本', async () => {
    const probe = await probeCommandRuntime(
      ctxOf(found('C:/tools/pnpm.exe'), { argsTemplate: '["run","check"]' }),
    )

    expect(probe).toEqual({
      state: 'ready',
      path: 'C:/tools/pnpm.exe',
      cliVersion: null,
      protocolVersion: null,
      pluginVersion: commandManifest.version,
      error: null,
      output: '',
      elapsedMs: 0,
      checkedAt: new Date(FIXED_NOW).toISOString(),
    })
  })

  it('插件装配：commandPlugin.probe 走同一实现（runtime.create 因此能落库）', async () => {
    const sdk = fakeSdk({ resolve: found('C:/tools/node.exe'), now: () => FIXED_NOW })
    const probe = await commandPlugin.probe?.({ runtime: runtime({ command: 'node' }), sdk })

    expect(probe).toMatchObject({ state: 'ready', path: 'C:/tools/node.exe' })
  })
})
