/**
 * claude 执行器插件常量：帧兼容版本、超时、终止宽限、诊断截尾。
 *
 * 这些值随插件走（测试可经内部选项覆盖）；宿主不感知，也不允许硬编码。
 */

/**
 * 本插件自有的帧兼容版本（`--output-format stream-json` 的帧形状兼容口径）。
 * 不是 CLI 版本号：CLI 版本由 probe 读 `--version` 得到，两者分开。
 */
export const CLAUDE_PROTOCOL_VERSION = 1
/** 读 CLI 版本超时 */
export const VERSION_TIMEOUT_MS = 15_000
/** 能力判定（`claude --help`）超时 */
export const HELP_TIMEOUT_MS = 15_000
/** 单次运行的默认超时 */
export const RUN_TIMEOUT_MS = 30 * 60_000
/**
 * SIGTERM 后等待退出的宽限，仍未退则 SIGKILL。
 * print + stream-json 没有 cancel 帧可写，终止流程只有「杀进程树」一条路。
 */
export const KILL_GRACE_MS = 2_000
/** stderr/诊断输出保留的尾部字符数 */
export const OUTPUT_TAIL_LIMIT = 4_000
