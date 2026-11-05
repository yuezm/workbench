/**
 * `remote` 执行器插件清单（D12）：远端 Worker 的架构位。
 *
 * 该执行器没有本机命令、也不自己连网络：传输由宿主注入（`RemoteTransport`），
 * M7 只落协议形状与端口，生产传输由后续里程碑实现。因此不声明任何能力，
 * `config` 也为空——运行时表单没有可填字段。
 */
import type { PluginManifest } from '../../../protocol/manifest'

export const remoteManifest: PluginManifest = {
  id: 'remote',
  kind: 'executor',
  name: '远端 Worker',
  version: '1.0.0',
  description: '远端 Worker 执行器架构位：需宿主注入传输，M7 不监听端口、不实现 daemon',
  capabilities: [],
  config: [],
}
