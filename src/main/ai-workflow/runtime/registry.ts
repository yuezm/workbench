import type {
  RuntimeModelOption,
  RuntimeProbe,
  RuntimeProtocolFamily,
} from '../../../shared/ai-workflow-api'
import {
  executeDshRun,
  listDshModels,
  probeDshRuntime,
  type DshDeps,
  type DshRunOutcome,
  type DshRunRequest,
} from './dsh'

/** 启动参数：与具体协议族无关（命令 + profile） */
export interface BackendTarget {
  command: string
  profile: string
}

/**
 * 协议后端：一个协议族提供「探测 / 模型目录 / 执行」三件事。
 * 新增 CLI 协议 = 新增一个后端实现 + 在 createRuntimeBackend 里登记。
 */
export interface RuntimeBackend {
  probe(target: BackendTarget): Promise<RuntimeProbe>
  models(target: BackendTarget): Promise<RuntimeModelOption[]>
  execute(request: DshRunRequest): Promise<DshRunOutcome>
}

/** 按协议族构造后端；依赖统一注入（spawn/killTree/now/env/sessionRoot） */
export function createRuntimeBackend(
  family: RuntimeProtocolFamily,
  deps: DshDeps = {},
): RuntimeBackend {
  switch (family) {
    case 'dsh':
      return {
        probe: (target) => probeDshRuntime(target, deps),
        models: (target) => listDshModels(target, deps),
        execute: (request) => executeDshRun(request, deps),
      }
    default:
      // 协议族由 DB CHECK 与契约限制，走到这里说明数据被绕过写入了
      throw new Error('不支持的协议族: ' + String(family))
  }
}
