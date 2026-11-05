import type { DetectedRuntime } from '../../../shared/ai-workflow-api'
import { defaultScanDirs, findInDirs } from '../../../host/executable'

/** 候选 agent CLI：命令名 → 展示名。顺序即输出顺序。 */
export const RUNTIME_CANDIDATES: ReadonlyArray<{ command: string; label: string }> = [
  { command: 'dsh', label: 'DeepSeek Harness' },
  { command: 'claude', label: 'Claude Code' },
  { command: 'codex', label: 'Codex CLI' },
  { command: 'gemini', label: 'Gemini CLI' },
  { command: 'opencode', label: 'OpenCode' },
  { command: 'aider', label: 'Aider' },
  { command: 'cursor-agent', label: 'Cursor Agent' },
  { command: 'qwen', label: 'Qwen Code' },
  { command: 'goose', label: 'Goose' },
  { command: 'crush', label: 'Crush' },
]

/**
 * 当前已实现协议后端的命令：只有这些能被「接入为运行时」。
 * 其余 CLI 仍在检测清单里展示（让用户知道本机装了什么），但不可用。
 */
export const SUPPORTED_COMMANDS: ReadonlySet<string> = new Set(['dsh'])

/**
 * 扫描本机已安装的 agent CLI。
 *
 * 纯同步、无副作用：不 spawn 进程、不读版本号，只读文件系统。
 * 探测（--probe / 版本号）由 runtime.probe 在用户显式操作时执行。
 *
 * @param dirs 扫描目录；默认取 PATH + 常见全局目录（传入时以注入值为准）
 * @param platform 目标平台；默认取当前平台
 */
export function detectInstalledRuntimes(
  dirs?: string[],
  platform: NodeJS.Platform = process.platform,
): DetectedRuntime[] {
  const scanDirs = dirs ?? defaultScanDirs(platform)
  const found = new Map<string, DetectedRuntime>()

  for (const { command, label } of RUNTIME_CANDIDATES) {
    const hit = findInDirs(command, scanDirs, platform)
    if (hit)
      found.set(command, {
        command,
        label,
        path: hit,
        executorKey: SUPPORTED_COMMANDS.has(command) ? command : '',
        supported: SUPPORTED_COMMANDS.has(command),
      })
  }

  // 按候选清单顺序稳定输出
  return RUNTIME_CANDIDATES.filter((c) => found.has(c.command)).map(
    (c) => found.get(c.command) as DetectedRuntime,
  )
}
