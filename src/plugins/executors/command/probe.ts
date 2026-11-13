/**
 * `command` 运行时探测：只回答「这条连接起不起得来」。
 *
 * 判据只有两条——命令能否解析成本机可执行文件、参数模板能否解析：
 * - **不 spawn**：通用命令没有统一的版本 / 能力旗标，猜一个（`--version`）等于把
 *   「这条命令没实现 --version」误报成「不可用」，比不探测更糟。
 * - 空命令直接算不可用：`runtime.create` 要求探测通过才落库，空命令落库只会得到
 *   一条永远 `spawn_failed` 的连接。
 *
 * 只读：不写库、不改运行时配置、不 spawn 长驻进程；结论由调用方（IPC / 表单）持久化。
 */
import type { RuntimeProbe } from '../../../protocol/entities'
import type { ExecutorContext } from '../../../sdk/types'
import { parseArgsTemplate } from '../../shared/argv'
import { commandManifest } from './manifest'

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 探测：解析可执行文件 + 解析参数模板；结论由调用方写库 */
export async function probeCommandRuntime(ctx: ExecutorContext): Promise<RuntimeProbe> {
  const { sdk, runtime } = ctx
  const started = sdk.now()
  const settle = (probe: Omit<RuntimeProbe, 'elapsedMs' | 'checkedAt'>): RuntimeProbe => ({
    ...probe,
    elapsedMs: sdk.now() - started,
    checkedAt: new Date(started).toISOString(),
  })

  const command = runtime.command.trim()
  if (command === '') {
    return settle({
      state: 'unavailable',
      path: null,
      cliVersion: null,
      protocolVersion: null,
      pluginVersion: null,
      error: '命令必填：填命令名或绝对路径（如 pnpm）',
      output: '',
    })
  }

  const resolved = sdk.process.resolve(command)
  if (resolved.path === null) {
    return settle({
      state: 'unavailable',
      path: null,
      cliVersion: null,
      protocolVersion: null,
      pluginVersion: null,
      error: resolved.error ?? `找不到可执行文件：${command}`,
      output: '',
    })
  }

  // 模板非法 → 每一轮都在展开前失败，与执行器的失败面一致，算这条连接不可用
  try {
    parseArgsTemplate(runtime.argsTemplate)
  } catch (error) {
    return settle({
      state: 'unavailable',
      path: resolved.path,
      cliVersion: null,
      protocolVersion: null,
      pluginVersion: commandManifest.version,
      error: `参数模板非法：${errMsg(error)}`,
      output: '',
    })
  }

  return settle({
    state: 'ready',
    path: resolved.path,
    // 通用命令没有可读的版本 / 协议版本；`pluginVersion` 记本插件的版本，便于对照
    cliVersion: null,
    protocolVersion: null,
    pluginVersion: commandManifest.version,
    error: null,
    output: '',
  })
}
