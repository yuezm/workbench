/**
 * 执行器端口契约（M2）：宿主领取一个 run 后，按运行时的执行器调用一轮执行。
 *
 * 分层：`kernel` 只认事实；`host/scheduler` 只认本文件的 `ExecutorPort`；
 * 具体协议适配（dsh 的 stdio JSONL）在 `main/ai-workflow/runtime/**`，M3 搬进插件。
 * 端口是窄接口：**执行器不领活、不写库、不决定派给谁**（SPEC-plugins「executor」）。
 *
 * `Turn` 与 `Receipt` 是这个边界的两端：`Turn` 由宿主按模板拼好（提示词、目录、
 * 权限、超时都已确定），`Receipt` 原样带回 `leaseId` 与 `turn`（D15），
 * 内核据此拒绝迟到尝试。`Receipt` 定义在 `protocol/inputs.ts`（它同时是
 * `run.receipt` 输入的载荷），这里 re-export 保持单一真相。
 */
import type {
  Access,
  RunEvent,
  RunPurpose,
  Runtime,
  RuntimeModelOption,
  RuntimeProbe,
} from './entities'
import type { Receipt } from './inputs'

export type { Receipt } from './inputs'

/**
 * 执行器端口版本：M3 的插件 manifest 与运行时能力探测按它做兼容判断；
 * 端口形状变化时递增（M2 = 1；M3 起执行器由插件实现，宿主只做包装）。
 */
export const EXECUTOR_PORT_VERSION = 2

/**
 * 一轮执行的入参：宿主已把「派给谁、在哪跑、什么权限、多久超时」定好，
 * 执行器只负责调起进程、把帧读回、给出回执。
 */
export interface Turn {
  runId: string
  /** 本次领取凭证 `<runId>:<attempt>`，回执原样带回 */
  leaseId: string
  /** 第几轮（续接递增，1 基） */
  turn: number
  purpose: RunPurpose
  /** 宿主按模板拼好的提示词（不拼进命令行，走 stdin 或 argv 元素） */
  prompt: string
  /** 执行目录（项目文件夹 > 智能体工作目录 > 空串 = 宿主默认目录） */
  cwd: string
  /**
   * argv（M40 脚本阶段）：逐项原样传参，不展开占位符；缺省用运行时的 `argsTemplate`。
   *
   * 命令本体不在这里：连哪条连接就跑哪个可执行文件（由 `runtime.command` 唯一决定），
   * 阶段只给参数这一类执行配置。
   */
  args?: readonly string[]
  /** 访问权限（来自智能体的 `permissionMode`） */
  access: Access
  /** 模型覆盖（来自智能体配置）；null / 缺省 = CLI 默认 */
  model?: { provider: string; id: string } | null
  /** 思考强度（来自智能体配置）；null / 缺省 = 模型默认 */
  effort?: string | null
  /** 追加给子进程的环境变量（来自智能体配置；只覆盖，不清空宿主基线） */
  env?: Record<string, string>
  /** 上一轮的协议会话 id；首轮为 null */
  resumeSessionId?: string | null
  /**
   * 续接被拒后的重试提示词（聊天续接轮专用）：带完整历史的那一份。
   * 续接轮 `prompt` 只含新消息；协议会话失效时执行器用它重发一次（旧 ChatService 同口径）。
   */
  fallbackPrompt?: string | null
  /** 单轮超时（宿主按 `runTimeoutMs` 传入） */
  timeoutMs: number
  /** 资料文件路径（不是指令，执行器只读） */
  contextFile?: string | null
  /** 取消 / 超时信号：宿主 abort，执行器按自己的时序终止进程 */
  signal: AbortSignal
}

/**
 * 执行器 → 宿主的运行时通道。
 *
 * 两个方法都是旁路：数据源始终是 `run.frames` / 回执事实，宿主不把旁路当权威。
 */
export interface ExecutorIO {
  /** 发一条运行事件；宿主按批入账 `run.frames`，并转 renderer 实时显示 */
  emit(event: RunEvent): void
  /** 协议会话 id 变化；回执缺 `sessionId` 时宿主用它兜底 */
  session?(id: string): void
  /**
   * 子进程 pid（M2 T13）：执行器 spawn 后回调一次，宿主写进 `process_registry`，
   * 崩溃重启时靠它终止残留进程树。不能提供 pid 的执行器可以不调。
   */
  process?(pid: number): void
}

/**
 * 模型目录项：与 `protocol/entities` 的 `RuntimeModelOption` 同一份（M3 起唯一真相）。
 * 保留别名是因为宿主端口 (`ExecutorPort.models`) 的历史命名。
 */
export type ExecutorModelOption = RuntimeModelOption

/**
 * 执行器端口：一个运行时协议族一个实现。
 *
 * - `run` 必选：宿主领取后调用，返回回执；异常由宿主归为兜底终态。
 * - `probe` / `models` 可选：只用于运行时配置与表单，不参与调度。
 */
export interface ExecutorPort {
  probe?(runtime: Runtime): Promise<RuntimeProbe>
  models?(runtime: Runtime): Promise<ExecutorModelOption[]>
  run(turn: Turn, io: ExecutorIO): Promise<Receipt>
}
