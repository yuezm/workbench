/**
 * 项目根 AGENTS.md 的初始生成（M53）。
 *
 * 为什么是 AGENTS.md 而不是配置文件：文档落点这件事的消费者有两个——人和 agent。
 * 人要在仓库里一眼看到"这类文档放哪"，agent 本来就每次开工先读 AGENTS.md。写一份
 * 两边都读的自然语言导航，比再引入一份 schema（`docs.layout.json` + 占位符渲染）省事：
 * 不需要教人记占位符语法，路径写错了人和 agent 都能自己发现、自己挪。
 *
 * 平台只做一件事：**没有 AGENTS.md 时补一份起点**。有就一个字都不动——那是用户的文件，
 * 覆盖它比不生成更糟。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { writeProjectDoc } from './artifacts'

/** 约定文件名（仓库根）。 */
export const AGENTS_FILE = 'AGENTS.md'

/** 一次生成的结果：`error` 非空时 `created` 必为 false，且不抛。 */
export interface ProjectAgentsInit {
  readonly path: string
  readonly created: boolean
  readonly error: string | null
}

/**
 * 默认的「文档导航」文本。
 *
 * 两组结构是刻意的：**真相源**（改动前必须读的契约类文档）与**过程与产物**（做完可归档的
 * 记录）。混成一张清单时，agent 分不清哪份是"必须遵守"、哪份是"当时怎么想的"。
 *
 * 末尾两行说明它是生成物：不写的话，人会当成平台硬约束而不敢删改，最后留下一堆空目录。
 */
export function agentsDocText(projectName: string): string {
  return [
    `# ${projectName}`,
    '',
    '## 文档导航（按需读取）',
    '',
    '真相源——改动前先读对应的一份，不要凭记忆写：',
    '',
    '- 领域词汇：`CONTEXT.md`（只收词汇，不含实现）',
    '- 架构决策：`docs/adr/`',
    '- 工程规范与踩坑：`docs/knowledge/index.md` → `standards.md`（规范）/ `pitfalls.md`（坑）',
    '- 现行契约与回归：`docs/qa`',
    '- 上下文：仓库根一份 `CONTEXT.md` + `docs/adr/`；消费方式见 `docs/agents/domain.md`',
    '',
    '过程与产物：',
    '',
    '- 版本里程碑：`docs/milestones/`',
    '- 上线清单：`docs/deploy/`',
    '- 过程记录（需求 / 调研 / 计划 / 特性文档，完成后可归档）：`docs/prds/`、`docs/research/`、`docs/plans/`、`docs/features/`、`.scratch/`',
    '- Agent 约定（本地 issue 追踪 / 分诊标签 / 领域文档消费方式）：`docs/agents/`',
    '- 离线运维脚本（导入 / 体检 / 清洗 / 版本修正）：`backend/scripts/`',
    '',
    '---',
    '',
    '这段导航由 workbench 在添加项目时生成，只是起点：按本项目实际情况增删，之后由你维护。',
    '用不上的条目删掉比留一堆空目录好——这份文件的价值是让人和 agent 知道「该读哪一份」，不是目录齐全。',
    '',
  ].join('\n')
}

/**
 * 生成 AGENTS.md：**只在文件不存在时写**。
 *
 * 三条边界：
 * - 已存在就跳过（可能是用户手写的，也可能是别的工具生成的）；
 * - 项目目录不存在时不写、也不造目录（不替用户创造仓库），返回可读诊断；
 * - 写盘失败返回诊断而不是抛：调用方在「添加项目」的中途（事实已入账），
 *   没有 AGENTS.md 时一切照旧，不该让项目创建失败。
 */
export function ensureProjectAgents(projectPath: string, projectName: string): ProjectAgentsInit {
  const target = join(projectPath, AGENTS_FILE)
  const existing = statSync(target, { throwIfNoEntry: false })
  if (existing !== undefined) {
    // 同名路径是目录时不能写，也不该静默当"已存在"
    if (existing.isDirectory()) {
      return { path: target, created: false, error: `${AGENTS_FILE} 是个目录，无法写入` }
    }
    return { path: target, created: false, error: null }
  }
  if (statSync(projectPath, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return { path: target, created: false, error: `项目目录不存在，未生成 ${AGENTS_FILE}` }
  }
  try {
    writeProjectDoc(projectPath, AGENTS_FILE, agentsDocText(projectName))
    return { path: target, created: true, error: null }
  } catch (error) {
    return {
      path: target,
      created: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
