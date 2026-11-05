/**
 * 本机 agent CLI 候选清单（`src/plugins/shared/cli-catalog.ts`）。
 *
 * 纯数据、零副作用：宿主与执行器插件只按它扫描本机命令。**顺序即 detect 的输出顺序**
 * （已注册插件的命中在前，未注册的 CLI 以 `supported:false` 补在后面，同清单顺序）。
 *
 * 新增可接入的 CLI 不改本清单：写一个执行器插件、在 registry 加一行即可；
 * 清单只决定「哪些命令值得扫」与展示名。
 */

export interface CliCandidate {
  /** CLI 命令名（不含后缀；Windows 由宿主能力面按 .exe/.cmd/.bat/.ps1 解析） */
  command: string
  /** 展示名（运行时检测清单 / 表单预填） */
  label: string
}

/** 候选 agent CLI：顺序即输出顺序（D8） */
export const CLI_CANDIDATES: ReadonlyArray<CliCandidate> = [
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
