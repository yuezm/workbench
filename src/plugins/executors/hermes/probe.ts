/**
 * hermes 运行时探测（hermes 专属判据）：
 * `hermes --version` 读 CLI 版本 → 真跑一次 `hermes acp` + `initialize`，
 * `protocolVersion === 1` 才算 ready。
 *
 * 只读：不写库、不改运行时配置；结论由调用方（IPC/表单）持久化。
 * 探测结束必须杀掉子进程（SIGTERM → 宽限 → SIGKILL），不留常驻进程。
 */
import type { RuntimeProbe } from '../../../protocol/entities'
import type { ExecutorContext } from '../../../sdk/types'
import { tail, withStderr } from '../../shared/text'
import {
  ACP_PROTOCOL_VERSION,
  KILL_GRACE_MS,
  OUTPUT_TAIL_LIMIT,
  PROBE_TIMEOUT_MS,
  VERSION_TIMEOUT_MS,
} from './constants'
import { hermesManifest } from './manifest'
import { errMsg, readCliVersion, startProcess, type HermesOptions } from './process'
import { initializeAcp } from './session'
import { connect, stopLink } from './wire'

/** 探测：CLI 版本 + 一次 ACP 握手；结论由调用方写库 */
export async function probeHermesRuntime(
  ctx: ExecutorContext,
  options: HermesOptions = {},
): Promise<RuntimeProbe> {
  const { sdk, runtime } = ctx
  const command = runtime.command
  const versionTimeout = options.timeouts?.version ?? VERSION_TIMEOUT_MS
  const probeTimeout = options.timeouts?.probe ?? PROBE_TIMEOUT_MS
  const graceKill = options.grace?.kill ?? KILL_GRACE_MS

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
  const launched = startProcess(sdk, command, ['acp'], undefined, {})
  if (!launched.process) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion: null,
      pluginVersion: null,
      error: `启动探测失败：${launched.error ?? '启动失败'}`,
      output: '',
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  const link = connect(sdk, launched.process)
  let protocolVersion: number | null = null
  let agentVersion: string | null = null
  let failure: string | null = null

  try {
    const info = await initializeAcp(link.acp, hermesManifest.version, probeTimeout)
    protocolVersion = info.protocolVersion
    agentVersion = info.agentVersion
    if (info.protocolVersion !== ACP_PROTOCOL_VERSION) {
      failure = `不兼容的协议版本：${info.protocolVersion === null ? '缺失' : String(info.protocolVersion)}（需要 ${ACP_PROTOCOL_VERSION}）`
    }
  } catch (error) {
    failure = `ACP 握手失败：${errMsg(error)}`
  } finally {
    await stopLink(link, graceKill)
  }

  const diagnostic = tail(link.stderr().trim() || (agentVersion ?? ''), OUTPUT_TAIL_LIMIT)
  if (failure !== null) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion,
      pluginVersion: null,
      error: withStderr(failure, link.stderr(), 'hermes stderr'),
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  return {
    state: 'ready',
    path: resolved.path,
    // agentInfo.version 作 CLI 版本兜底（--version 读不到时仍能报一个版本）
    cliVersion: cliVersion ?? agentVersion,
    protocolVersion: ACP_PROTOCOL_VERSION,
    pluginVersion: hermesManifest.version,
    error: null,
    output: diagnostic,
    elapsedMs: elapsed(),
    checkedAt,
  }
}
