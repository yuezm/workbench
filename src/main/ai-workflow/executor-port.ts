/**
 * 执行器端口的装配（M2 T9）：把 `RuntimeBackend`（dsh 的 stdio 适配层）接到
 * `host/executor` 的通用适配器上，产出「运行时 → `ExecutorPort`」的工厂。
 *
 * T10 的 scheduler 注入 `RuntimeExecutors`：领取到 run 后按 `run.runtimeId` 找到运行时行，
 * 再 `forRuntime(runtime)` 拿端口调用 `run(turn, io)`。调度只认执行器端口，不认 dsh——
 * M3 换成插件注册表时，本文件就是注册表装配代码（`RuntimeBackend` 随之消失）。
 *
 * 这里是 main 侧唯一直接依赖具体执行器实现的地方（`main/ai-workflow/runtime/**`）；
 * `host/**` 只依赖 `protocol/**`（ESLint 强制）。
 */
import type { Runtime } from '../../protocol/entities'
import type { ExecutorPort } from '../../protocol/executor'
import {
  createExecutorPort,
  type ExecutorBackend,
  type ExecutorPortOptions,
} from '../../host/executor'
import type { DshDeps } from './runtime/dsh'
import { createRuntimeBackend, type RuntimeBackend } from './runtime/registry'

export interface RuntimeExecutorOptions extends DshDeps {
  /** 续接被拒时换新会话重试一次（默认 true，见 SPEC-plugins「executor」） */
  retryOnResumeRejected?: boolean
  /** 一轮的协议 request_id 覆盖；缺省用 host 适配器的 `<runId>:<turn>:<n>` */
  requestId?: ExecutorPortOptions['requestId']
}

/** 运行时 → 执行器端口（调度器每个 run 取一次） */
export interface RuntimeExecutors {
  /**
   * 某条运行时配置对应的执行器端口。
   *
   * 每次按当前配置构造（改名/换命令/换模型后立即生效）；同一协议族的后端实现按族缓存。
   * 未知协议族会在 `createRuntimeBackend` 里抛错（数据被绕过写入的信号）。
   */
  forRuntime(runtime: Runtime): ExecutorPort
}

/** 把 `RuntimeBackend.execute` 绑到一条运行时配置上（Turn → dsh 的 DshRunRequest） */
function bindBackend(runtime: Runtime, backend: RuntimeBackend): ExecutorBackend {
  return {
    execute: (request) =>
      backend.execute({
        runtime: {
          command: runtime.command,
          profile: runtime.profile,
          permissionMode: runtime.permissionMode,
          model: runtime.model,
          reasoningEffort: runtime.reasoningEffort,
          workdir: runtime.workdir,
        },
        requestId: request.requestId,
        prompt: request.turn.prompt,
        resumeSessionId: request.turn.resumeSessionId ?? null,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        onEvent: request.onEvent,
        // 子进程 pid 透传给宿主（T13：写 process_registry，崩溃重启按 pid 清树）
        onSpawn: request.onSpawn,
      }),
  }
}

/**
 * 装配运行时执行器工厂。
 *
 * @param options dsh 后端依赖（spawn / killTree / now / 会话根 / 超时与宽限覆盖）+ 适配器选项
 */
export function createRuntimeExecutors(options: RuntimeExecutorOptions = {}): RuntimeExecutors {
  const { retryOnResumeRejected, requestId, ...deps } = options
  const backends = new Map<string, RuntimeBackend>()
  const backendFor = (key: string): RuntimeBackend => {
    const cached = backends.get(key)
    if (cached) return cached
    const backend = createRuntimeBackend(key, deps)
    backends.set(key, backend)
    return backend
  }

  return {
    forRuntime(runtime: Runtime): ExecutorPort {
      const backend = backendFor(runtime.executorKey)
      const port = createExecutorPort(bindBackend(runtime, backend), {
        retryOnResumeRejected,
        requestId,
      })
      return {
        probe: (target) => backend.probe({ command: target.command, profile: target.profile }),
        models: (target) => backend.models({ command: target.command, profile: target.profile }),
        run: (turn, io) => port.run(turn, io),
      }
    },
  }
}
