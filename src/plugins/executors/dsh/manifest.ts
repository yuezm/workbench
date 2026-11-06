/**
 * dsh 执行器插件清单（`src/plugins/executors/dsh/manifest.ts`）。
 *
 * `config` 是运行时表单的字段来源：dsh 专属字段（command/profile/permissionMode/
 * model/reasoningEffort/workdir）由宿主写入 `Runtime` 行，插件执行时只读该行。
 */
import type { PluginManifest } from '../../../protocol/manifest'
import { PERMISSION_MODES } from '../../../protocol/entities'

export const dshManifest: PluginManifest = {
  id: 'dsh',
  kind: 'executor',
  name: 'DeepSeek Harness',
  version: '1.0.0',
  description: 'dsh --stdio JSONL 协议：探测 / 模型目录 / 执行 / 终止',
  // spawn = 子进程 + 杀进程树 + 可执行文件解析（resolve 的 stat 语义归在 process 能力下）；
  // sdk 没有 fs 能力面，因此不再声明 fs.read（死声明会被 boundary 门禁拦下）
  capabilities: ['spawn'],
  config: [
    { key: 'command', label: '命令', type: 'text', required: true, default: 'dsh' },
    { key: 'profile', label: 'Profile', type: 'text', required: true, default: 'multica' },
    {
      key: 'permissionMode',
      label: '权限模式',
      type: 'select',
      options: PERMISSION_MODES,
      default: 'workspace-write',
    },
    { key: 'model', label: '模型', type: 'text', help: 'provider/model 形式；留空用 CLI 默认模型' },
    { key: 'reasoningEffort', label: '推理强度', type: 'text', help: '留空用模型默认强度' },
    {
      key: 'workdir',
      label: '工作目录',
      type: 'text',
      help: '留空用宿主默认目录（WORKBENCH_WORKDIR，缺省 ~/.workbench）',
    },
  ],
}
