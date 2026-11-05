/**
 * 远端 Worker 契约（M7「架构位」）：拉模式 worker 的帧形状与宿主传输端口。
 *
 * **本阶段只落架构位**：不监听任何端口、不实现 daemon、不跨机通信。这里定义的是
 * 「将来远端 worker 用同一形状」的协议面，宿主侧实现由 `RemoteTransport` 端口注入
 * （测试用进程内假传输；生产环境未配置传输时执行器直接回 `runtime_missing`）。
 *
 * 形状与 SPEC-kernel「调度」一致：领取按 run 粒度、租约 + 心跳、回执原样带回
 * `leaseId` / `turn`——远端与本地走同一条回执校验链路，不引入第二套终态语义。
 */
import type { RunEvent } from './entities'
import type { ExecutorIO, Receipt, Turn } from './executor'

/** 远端 Worker 协议版本：帧形状变化时递增。 */
export const WORKER_PROTOCOL_VERSION = 1

/** 帧类型全集（`hello` / `claim` / `heartbeat` / `event` / `receipt` / `cancel`）。 */
export const WORKER_FRAME_TYPES = [
  'hello',
  'claim',
  'heartbeat',
  'event',
  'receipt',
  'cancel',
] as const

export type WorkerFrameType = (typeof WORKER_FRAME_TYPES)[number]

/** worker 自报身份：本机标识 + 支持的执行器键（`executorKey` 列表，不写死产品名）。 */
export interface WorkerDescriptor {
  id: string
  name: string
  executorKeys: string[]
}

/** 一次领取：与 `run.claimed` 的租约语义一致。 */
export interface WorkerClaim {
  runId: string
  leaseId: string
  turn: number
  /** 租约到期时刻（ISO）；worker 必须在它之前回执或续租 */
  leaseUntil: string
}

export interface WorkerHelloFrame {
  v: typeof WORKER_PROTOCOL_VERSION
  type: 'hello'
  worker: WorkerDescriptor
}

/** 宿主 → worker：把一轮执行派给远端。 */
export interface WorkerClaimFrame {
  v: typeof WORKER_PROTOCOL_VERSION
  type: 'claim'
  claim: WorkerClaim
  turn: Turn
}

/** worker → 宿主：续租（内核按 `leaseId` 匹配，迟到心跳零事实）。 */
export interface WorkerHeartbeatFrame {
  v: typeof WORKER_PROTOCOL_VERSION
  type: 'heartbeat'
  claim: WorkerClaim
}

/** worker → 宿主：执行中的增量（与本地执行器 `ExecutorIO.emit` 同形状）。 */
export interface WorkerEventFrame {
  v: typeof WORKER_PROTOCOL_VERSION
  type: 'event'
  runId: string
  event: RunEvent
}

/** worker → 宿主：终态回执（原样带回 `leaseId` / `turn`）。 */
export interface WorkerReceiptFrame {
  v: typeof WORKER_PROTOCOL_VERSION
  type: 'receipt'
  runId: string
  receipt: Receipt
}

/** 宿主 → worker：取消（终止与回执由 worker 按本地取消时序完成）。 */
export interface WorkerCancelFrame {
  v: typeof WORKER_PROTOCOL_VERSION
  type: 'cancel'
  runId: string
}

export type HostToWorkerFrame = WorkerClaimFrame | WorkerCancelFrame

export type WorkerToHostFrame =
  WorkerHelloFrame | WorkerHeartbeatFrame | WorkerEventFrame | WorkerReceiptFrame

/**
 * 宿主注入给远端执行器的传输端口（M7 只定义形状，不提供网络实现）。
 *
 * `execute` 必须像本地执行器一样遵守 `signal`：abort 后尽快回一条
 * `status='cancelled'` 的回执，并保证不再写帧。
 */
export interface RemoteTransport {
  execute(turn: Turn, io: ExecutorIO, signal: AbortSignal): Promise<Receipt>
  /** 取消正在执行的 run（幂等；不存在的 run 直接返回） */
  cancel(runId: string): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 解析一行 worker 输出帧；未知 / 非法 / 非本版本一律返回 `null`。
 * 纯函数：不碰网络与文件，测试直接喂字符串。
 */
export function parseWorkerFrame(line: string): WorkerToHostFrame | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value) || value['v'] !== WORKER_PROTOCOL_VERSION) return null
  switch (value['type']) {
    case 'hello': {
      const worker = value['worker']
      if (!isRecord(worker)) return null
      if (typeof worker['id'] !== 'string' || worker['id'].length === 0) return null
      if (typeof worker['name'] !== 'string' || worker['name'].length === 0) return null
      const keys = worker['executorKeys']
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) return null
      return {
        v: WORKER_PROTOCOL_VERSION,
        type: 'hello',
        worker: {
          id: worker['id'],
          name: worker['name'],
          executorKeys: keys as string[],
        },
      }
    }
    case 'heartbeat': {
      const claim = value['claim']
      if (!isRecord(claim)) return null
      if (typeof claim['runId'] !== 'string' || typeof claim['leaseId'] !== 'string') return null
      if (typeof claim['turn'] !== 'number' || typeof claim['leaseUntil'] !== 'string') return null
      return {
        v: WORKER_PROTOCOL_VERSION,
        type: 'heartbeat',
        claim: {
          runId: claim['runId'],
          leaseId: claim['leaseId'],
          turn: claim['turn'],
          leaseUntil: claim['leaseUntil'],
        },
      }
    }
    case 'event': {
      const event = value['event']
      if (typeof value['runId'] !== 'string' || !isRecord(event)) return null
      return {
        v: WORKER_PROTOCOL_VERSION,
        type: 'event',
        runId: value['runId'],
        event: event as unknown as RunEvent,
      }
    }
    case 'receipt': {
      const receipt = value['receipt']
      if (typeof value['runId'] !== 'string' || !isRecord(receipt)) return null
      return {
        v: WORKER_PROTOCOL_VERSION,
        type: 'receipt',
        runId: value['runId'],
        receipt: receipt as unknown as Receipt,
      }
    }
    default:
      return null
  }
}

/** 编码宿主 → worker 帧（JSONL 单行）。 */
export function encodeWorkerFrame(frame: HostToWorkerFrame): string {
  return JSON.stringify(frame) + '\n'
}
