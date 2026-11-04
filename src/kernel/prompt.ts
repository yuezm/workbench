/**
 * 阶段任务提示词（纯函数）：与迁移前 `host/task-effects.buildTaskPrompt` 逐字一致。
 *
 * 顺序：智能体能力（`systemPrompt`）→ 任务标题 → 任务描述 → 阶段名；
 * 空段过滤后两两以空行分隔。提示词只由宿主/内核按模板拼装，事件正文不进指令段。
 */
import type { Agent, Task } from '../protocol/entities'

export const taskPrompt = (agent: Agent, task: Task, stageName: string | null): string =>
  [
    agent.systemPrompt,
    `# 任务：${task.title}`,
    task.description,
    stageName ? `# 阶段：${stageName}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
