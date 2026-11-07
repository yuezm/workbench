/**
 * hermes 执行器插件常量：ACP 协议版本、超时、取消宽限、诊断截尾。
 *
 * 这些值随插件走（测试可经内部选项覆盖）；宿主不感知，也不允许硬编码。
 */

/** ACP（Agent Client Protocol）协议版本：initialize 的 protocolVersion，必须逐字匹配 */
export const ACP_PROTOCOL_VERSION = 1
/** 探测超时：`hermes acp` 冷启动要拉起 agent 运行时，实测可达 10s 级 */
export const PROBE_TIMEOUT_MS = 60_000
/** 读 CLI 版本（`hermes --version`）超时 */
export const VERSION_TIMEOUT_MS = 15_000
/** 模型目录超时（initialize + 一次性 session/new） */
export const MODELS_TIMEOUT_MS = 120_000
/** 单次运行的默认超时 */
export const RUN_TIMEOUT_MS = 30 * 60_000
/** 普通 JSON-RPC 请求（set_mode / set_model 等）等待回帧的超时 */
export const REQUEST_TIMEOUT_MS = 30_000
/** 已发 session/cancel 通知后等待优雅退出的宽限 */
export const CANCEL_GRACE_MS = 3_000
/** SIGTERM 后等待退出的宽限，仍未退则 SIGKILL */
export const KILL_GRACE_MS = 2_000
/** stderr/诊断输出保留的尾部字符数 */
export const OUTPUT_TAIL_LIMIT = 4_000
