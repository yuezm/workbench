/**
 * dsh 运行时探测（dsh 专属判据）：
 * `v=1`、`protocol_version=1`、`runtime='dsh'` 三个条件都满足才算 ready。
 *
 * 只读：不写库、不改运行时配置；结论由调用方（IPC/表单）持久化。
 */
import type { RuntimeProbe } from '../../../protocol/entities'
import type { ExecutorContext } from '../../../sdk/types'
import { tail, withStderr } from '../../shared/text'
import {
  DSH_PROTOCOL_VERSION,
  DSH_RUNTIME_ID,
  OUTPUT_TAIL_LIMIT,
  PROBE_TIMEOUT_MS,
  VERSION_TIMEOUT_MS,
} from './constants'
import type { DshFrame } from './frames'
import { collect, errMsg, readCliVersion, type DshOptions } from './process'
import { parseFrame } from '../../shared/jsonl'

/** 探测：--probe 帧 + CLI 版本；结论由调用方写库 */
export async function probeDshRuntime(
  ctx: ExecutorContext,
  options: DshOptions = {},
): Promise<RuntimeProbe> {
  const { sdk, runtime } = ctx
  const command = runtime.command
  const profile = runtime.profile
  const versionTimeout = options.timeouts?.version ?? VERSION_TIMEOUT_MS
  const probeTimeout = options.timeouts?.probe ?? PROBE_TIMEOUT_MS

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

  const cliVersion = await readCliVersion(sdk, command, profile, versionTimeout)
  const collected = await collect(sdk, command, profile, ['--probe'], probeTimeout)
  const diagnostic = tail(collected.stderr.trim() || collected.stdout.trim(), OUTPUT_TAIL_LIMIT)

  if (collected.spawnError) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion: null,
      pluginVersion: null,
      error: withStderr(`启动探测失败：${errMsg(collected.spawnError)}`, collected.stderr),
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }
  if (collected.timedOut) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion: null,
      pluginVersion: null,
      error: withStderr(`探测超时（${probeTimeout}ms）`, collected.stderr),
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  let frame: DshFrame | null = null
  for (const line of collected.stdout.split('\n')) {
    const candidate = parseFrame<DshFrame>(line)
    if (candidate?.type === 'probe') {
      frame = candidate
      break
    }
  }

  if (!frame) {
    const reason =
      collected.code !== 0
        ? `探测退出码 ${collected.code ?? 'null'}`
        : '探测没有返回协议帧（profile 未提供 --probe？）'
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion: null,
      pluginVersion: null,
      error: withStderr(reason, collected.stderr),
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  const protocolVersion = typeof frame.protocol_version === 'number' ? frame.protocol_version : null
  if (frame.v !== DSH_PROTOCOL_VERSION || protocolVersion !== DSH_PROTOCOL_VERSION) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion,
      pluginVersion: null,
      error: `不兼容的协议版本：帧 v=${String(frame.v)}，protocol_version=${String(protocolVersion)}（需要 ${DSH_PROTOCOL_VERSION}）`,
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }
  if (frame.runtime !== DSH_RUNTIME_ID) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion,
      pluginVersion: null,
      error: `探测帧的 runtime 不是 dsh：${String(frame.runtime)}`,
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  return {
    state: 'ready',
    path: resolved.path,
    cliVersion,
    protocolVersion,
    pluginVersion: frame.plugin_version ?? null,
    error: null,
    output: diagnostic,
    elapsedMs: elapsed(),
    checkedAt,
  }
}
