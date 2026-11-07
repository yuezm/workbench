/**
 * hermes 执行器插件清单（`src/plugins/executors/hermes/manifest.ts`）。
 *
 * `config` 是运行时表单的字段来源：hermes 专属字段（command/profile/permissionMode/
 * model/reasoningEffort/workdir）由宿主写入 `Runtime` 行，插件执行时只读该行。
 */
import type { PluginManifest } from '../../../protocol/manifest'
import { PERMISSION_MODES } from '../../../protocol/entities'

export const hermesManifest: PluginManifest = {
  id: 'hermes',
  kind: 'executor',
  name: 'Hermes Agent',
  version: '1.0.0',
  description: 'Hermes Agent ACP（JSON-RPC over stdio）：探测 / 模型目录 / 执行 / 终止',
  // 插件只经 `sdk.process.*` 拿子进程与杀进程树能力；没有 fs/net 用法，不声明死能力
  capabilities: ['spawn'],
  config: [
    { key: 'command', label: '命令', type: 'text', required: true, default: 'hermes' },
    {
      key: 'profile',
      label: 'Profile',
      type: 'text',
      default: '',
      help: 'Hermes Agent 不使用 profile，可留空',
    },
    {
      key: 'permissionMode',
      label: '权限模式',
      type: 'select',
      options: PERMISSION_MODES,
      default: 'workspace-write',
      help: '映射到 ACP session mode（read-only→default / workspace-write→accept_edits / danger-full-access→dont_ask）',
    },
    {
      key: 'model',
      label: '模型',
      type: 'text',
      help: 'provider/model 形式；留空用 hermes 配置的默认模型',
    },
    { key: 'reasoningEffort', label: '推理强度', type: 'text', help: 'ACP 暂不支持，留空' },
    {
      key: 'workdir',
      label: '工作目录',
      type: 'text',
      help: '留空用宿主默认目录（WORKBENCH_WORKDIR，缺省 ~/.workbench）',
    },
  ],
}
