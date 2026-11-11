// @vitest-environment node
/**
 * 回执工具 server 的协议契约：真起一个 node 子进程，按 MCP stdio 一条一条说话。
 *
 * 这个 server 是独立进程，import 不到主进程代码，键集合是手写副本——这里对着
 * `RECEIPT_KEYS` 断言它的 `tools/list`，防「提示词加了键、server 没跟上」的漂移。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RECEIPT_KEYS } from '../../../src/protocol/receipt-keys'

const SERVER = fileURLToPath(
  new URL('../../../src/plugins/shared/receipt-mcp-server.cjs', import.meta.url),
)

interface RpcResult {
  id?: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

/** 起 server，按顺序发请求，收齐响应后关掉 */
const conversation = async (requests: readonly Record<string, unknown>[]): Promise<RpcResult[]> => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
  const replies: RpcResult[] = []
  const reader = createInterface({ input: child.stdout })
  const done = new Promise<void>((resolve) => {
    reader.on('line', (line) => {
      try {
        replies.push(JSON.parse(line) as RpcResult)
      } catch {
        // 非 JSON 行不该出现：留空让断言失败
        replies.push({ error: { code: 0, message: `非 JSON 行：${line}` } })
      }
    })
    child.on('close', () => resolve())
  })
  for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n')
  child.stdin.end()
  await done
  return replies
}

const request = (id: number | null, method: string, params?: unknown): Record<string, unknown> =>
  id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }

describe('receipt-mcp-server（MCP stdio）', () => {
  it('initialize → tools/list → tools/call 都能答，通知不回包', async () => {
    const replies = await conversation([
      request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
      request(null, 'notifications/initialized'),
      request(2, 'tools/list'),
      request(3, 'tools/call', { name: 'receipt', arguments: { notices: ['x'] } }),
    ])

    expect(replies).toHaveLength(3)
    const [init, list, call] = replies

    expect(init.result).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'workbench-receipt' },
    })

    const tools = (list.result?.tools ?? []) as Array<{
      name: string
      description: string
      inputSchema: { properties?: Record<string, unknown>; additionalProperties?: boolean }
    }>
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('receipt')
    // 键集合与主进程同源：少一个键，模型就永远写不出那个键的回执
    expect(Object.keys(tools[0].inputSchema.properties ?? {})).toEqual([...RECEIPT_KEYS])
    for (const key of RECEIPT_KEYS) expect(tools[0].description).toContain(`\`${key}\``)
    expect(tools[0].inputSchema.additionalProperties).toBe(true)

    expect(call.result).toMatchObject({ isError: false })
  })

  it('客户端给的协议版本原样回（不硬编码一个版本把人挡在门外）', async () => {
    const [init] = await conversation([request(1, 'initialize', { protocolVersion: '2025-06-18' })])
    expect(init.result?.protocolVersion).toBe('2025-06-18')
  })

  it('未知方法 -32601、未知工具 -32602、非法行静默丢弃', async () => {
    const replies = await conversation([
      request(1, 'resources/list'),
      request(2, 'tools/call', { name: 'nope', arguments: {} }),
      request(3, 'ping'),
    ])
    expect(replies[0].error?.code).toBe(-32601)
    expect(replies[1].error?.code).toBe(-32602)
    expect(replies[2].result).toEqual({})
  })

  it('空行与非 JSON 行不产生响应', async () => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: string[] = []
    createInterface({ input: child.stdout }).on('line', (line) => lines.push(line))
    child.stdin.write('\n')
    child.stdin.write('not json\n')
    child.stdin.write(JSON.stringify(request(1, 'ping')) + '\n')
    child.stdin.end()
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ id: 1, result: {} })
  })
})
