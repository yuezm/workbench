/**
 * claude 运行时探测（claude 专属判据）：
 * 可执行文件可解析 + `claude --version` 有 semver + `claude --help` 同时列出
 * `--print` 与 `--output-format`（本插件调用的两个必需参数）。
 *
 * 只读：不写库、不改运行时配置、不 spawn 长驻进程（`collect` 超时/结束时杀进程树）；
 * 结论由调用方（IPC/表单）持久化。
 */
import type { RuntimeProbe } from '../../../protocol/entities'
import type { ExecutorContext } from '../../../sdk/types'
import { tail, withStderr } from '../../shared/text'
import {
  CLAUDE_PROTOCOL_VERSION,
  HELP_TIMEOUT_MS,
  OUTPUT_TAIL_LIMIT,
  VERSION_TIMEOUT_MS,
} from './constants'
import { claudeManifest } from './manifest'
import { collect, errMsg, readCliVersion, type ClaudeOptions } from './process'

/** 能力判定要求的两个 flag（缺任一即判定为不可用 CLI） */
const REQUIRED_FLAGS = ['--print', '--output-format'] as const

/** 探测：CLI 版本 + `--help` 能力判定；结论由调用方写库 */
export async function probeClaudeRuntime(
  ctx: ExecutorContext,
  options: ClaudeOptions = {},
): Promise<RuntimeProbe> {
  const { sdk, runtime } = ctx
  const command = runtime.command
  const versionTimeout = options.timeouts?.version ?? VERSION_TIMEOUT_MS
  const helpTimeout = options.timeouts?.help ?? HELP_TIMEOUT_MS

  const started = sdk.now()
  const checkedAt = new Date(sdk.now()).toISOString()
  const elapsed = (): number => sdk.now() - started

  const resolved = sdk.process.resolve(command)
  if (!resolved.path) {
    return {
      state: 'unavailable',
      path: null,
      cliVersion: null,
      protocolVersion: null,
      pluginVersion: null,
      error: resolved.error ?? `找不到可执行文件：${command}`,
      output: '',
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  const cliVersion = await readCliVersion(sdk, command, versionTimeout)
  const collected = await collect(sdk, command, ['--help'], helpTimeout)
  const diagnostic = tail(collected.stderr.trim() || collected.stdout.trim(), OUTPUT_TAIL_LIMIT)

  const unavailable = (error: string): RuntimeProbe => ({
    state: 'unavailable',
    path: resolved.path,
    cliVersion,
    protocolVersion: null,
    pluginVersion: null,
    error,
    output: diagnostic,
    elapsedMs: elapsed(),
    checkedAt,
  })

  if (collected.spawnError) {
    return unavailable(
      withStderr(`启动探测失败：${errMsg(collected.spawnError)}`, collected.stderr),
    )
  }
  if (collected.timedOut) {
    return unavailable(withStderr(`探测超时（${helpTimeout}ms）`, collected.stderr))
  }

  const missing = REQUIRED_FLAGS.filter((flag) => !collected.stdout.includes(flag))
  if (missing.length > 0) {
    return unavailable(
      withStderr(
        `claude --help 未列出必需参数：${missing.join(' ')}（CLI 过旧或不是 Claude Code？）`,
        collected.stderr,
      ),
    )
  }

  return {
    state: 'ready',
    path: resolved.path,
    cliVersion,
    // 本插件自有的帧兼容版本（claude 的 stream-json 帧不带版本字段）
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    pluginVersion: claudeManifest.version,
    error: null,
    output: diagnostic,
    elapsedMs: elapsed(),
    checkedAt,
  }
}
