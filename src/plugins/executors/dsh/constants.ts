/**
 * dsh 执行器插件常量：协议版本、超时、取消宽限、诊断截尾。
 *
 * 这些值随插件走（测试可经内部选项覆盖）；宿主不感知，也不允许硬编码。
 */

/** dsh profile 暴露的 stdio 协议版本（与 Multica 的 DshProtocolVersion 一致） */
export const DSH_PROTOCOL_VERSION = 1
/** --probe 帧里的 runtime 标识 */
export const DSH_RUNTIME_ID = 'dsh'
/** 探测超时：冷启动要加载 profile 插件，实测可达 10s 级 */
export const PROBE_TIMEOUT_MS = 60_000
/** 读 CLI 版本超时 */
export const VERSION_TIMEOUT_MS = 15_000
/** 模型目录超时 */
export const MODELS_TIMEOUT_MS = 120_000
/** 单次运行的默认超时 */
export const RUN_TIMEOUT_MS = 30 * 60_000
/** 已发 cancel 帧后等待优雅退出的宽限 */
export const CANCEL_GRACE_MS = 3_000
/** SIGTERM 后等待退出的宽限，仍未退则 SIGKILL */
export const KILL_GRACE_MS = 2_000
/** stderr/诊断输出保留的尾部字符数 */
export const OUTPUT_TAIL_LIMIT = 4_000
