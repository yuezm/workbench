/**
 * claude 执行器插件清单（`src/plugins/executors/claude/manifest.ts`）。
 *
 * `config` 是运行时表单的字段来源：command / profile / permissionMode / model /
 * reasoningEffort / workdir 由宿主写入 `Runtime` 行，插件执行时只读该行。
 * `profile` 是运行时表的公共列，Claude Code 没有对应概念，默认空串且不拼进 argv。
 */
import type { PluginManifest } from '../../../protocol/manifest'
import { PERMISSION_MODES } from '../../../protocol/entities'

export const claudeManifest: PluginManifest = {
  id: 'claude',
  kind: 'executor',
  name: 'Claude Code',
  version: '1.0.0',
  description: 'claude --print --output-format stream-json：探测 / 执行 / 终止',
  // spawn = 子进程 + 杀进程树 + 可执行文件解析（resolve 的 stat 语义归在 process 能力下）
  capabilities: ['spawn'],
  config: [
    { key: 'command', label: '命令', type: 'text', required: true, default: 'claude' },
    {
      key: 'profile',
      label: 'Profile',
      type: 'text',
      default: '',
      help: 'Claude Code 不使用 profile，可留空',
    },
    {
      key: 'permissionMode',
      label: '权限模式',
      type: 'select',
      options: PERMISSION_MODES,
      default: 'workspace-write',
    },
    {
      key: 'model',
      label: '模型',
      type: 'text',
      help: 'provider/model 形式；只取斜杠后的模型名交给 --model；留空用 CLI 默认模型',
    },
    {
      key: 'reasoningEffort',
      label: '推理强度',
      type: 'text',
      help: '透传给 --effort（claude 支持 low/medium/high/xhigh/max）；留空用模型默认强度',
    },
    {
      key: 'workdir',
      label: '工作目录',
      type: 'text',
      help: '留空用宿主默认目录（WORKBENCH_WORKDIR，缺省 ~/.workbench）',
    },
  ],
}
