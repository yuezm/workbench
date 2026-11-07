/**
 * claude 执行器插件：本机 CLI 检测（`src/plugins/executors/claude/detect.ts`）。
 *
 * 只报 claude 自己能接入的命中；候选清单与命令名来自 `plugins/shared/cli-catalog`，
 * 扫描目录与文件命中判定全部经 `ctx.sdk.process`（宿主能力面），插件不 import
 * node 内置、不 spawn、不写库、不发 changed —— detect 仍保持零副作用。
 *
 * `executorKey` / `supported` 由注册表汇总时填（插件不自报），因此这里返回空串与 false。
 */
import type { DetectedRuntime } from '../../../protocol/entities'
import type { DetectContext } from '../../../sdk/types'
import { CLI_CANDIDATES } from '../../shared/cli-catalog'

/** claude 的候选命令名（清单缺席时按约定回退，保持插件可独立测试） */
const CLAUDE_COMMAND = 'claude'
const CLAUDE_LABEL = 'Claude Code'

/** 扫描本机是否安装了 claude；命中返回一条候选，未命中返回空数组。 */
export function detectClaude(ctx: DetectContext): DetectedRuntime[] {
  const candidate = CLI_CANDIDATES.find((item) => item.command === CLAUDE_COMMAND) ?? {
    command: CLAUDE_COMMAND,
    label: CLAUDE_LABEL,
  }
  const dirs = ctx.sdk.process.scanDirs()
  const path = ctx.sdk.process.findInDirs(candidate.command, dirs)
  if (path === null) return []
  return [
    {
      command: candidate.command,
      label: candidate.label,
      path,
      // 由 registry 按 entry.key 回填；插件只报「本机有这个命令」
      executorKey: '',
      supported: false,
    },
  ]
}
