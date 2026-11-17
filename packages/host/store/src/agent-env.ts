/**
 * `agents.env_json` → 环境变量对象（宿主 store 内部共用：视图读取与 v2 存量导入）。
 *
 * 空串与坏 JSON 都按「没有环境变量」归一：投影写入始终是合法 JSON，这里只保证一条
 * 脏行（手改库 / 旧导入）不会把 `agents.all` 整张视图读挂。
 */
export function parseAgentEnv(text: string | null | undefined): Record<string, string> {
  if (text === null || text === undefined || text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}
