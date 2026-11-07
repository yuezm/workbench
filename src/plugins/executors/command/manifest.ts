/**
 * `command` 执行器插件清单（D12）：通用命令 + 参数模板。
 *
 * `config` 是运行时表单的字段来源与默认值：`command` / `profile` / `argsTemplate`
 * 默认都为空串（空模板 = 无参数）。`command` 不给 `detect()`，避免与 dsh 抢同名命令。
 */
import type { PluginManifest } from '../../../protocol/manifest'

export const commandManifest: PluginManifest = {
  id: 'command',
  kind: 'executor',
  name: '命令',
  version: '1.0.0',
  description: '通用命令执行：按参数模板调起本机命令，提示词只作为独立 argv 元素或走 stdin',
  // spawn = 子进程 + 杀进程树 + 可执行文件解析（sdk 没有 fs/net 能力面）
  capabilities: ['spawn'],
  config: [
    {
      key: 'command',
      label: '命令',
      type: 'text',
      required: true,
      default: '',
      help: '命令名或绝对路径（如 claude、my-agent）；按本机 PATH 解析',
    },
    {
      key: 'profile',
      label: 'Profile',
      type: 'text',
      default: '',
      help: '启动 profile；命令插件不传该参数，留空即可',
    },
    {
      key: 'argsTemplate',
      label: '参数模板',
      type: 'text',
      default: '',
      help: 'JSON 数组文本，每项一个 argv 元素，如 ["--print","{prompt}"]；可用占位符 {model}/{effort}/{cwd}/{context}/{prompt}；不含 {prompt} 时提示词走 stdin；Windows .cmd/.bat 不支持 {prompt}（命令行会被 cmd.exe 重新解析），提示词只能走 stdin',
    },
  ],
}
