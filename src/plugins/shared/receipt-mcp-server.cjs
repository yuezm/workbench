#!/usr/bin/env node
/**
 * 回执工具 server（M24）：只暴露一个工具 `receipt` 的 stdio MCP server。
 *
 * 为什么要有它：回执原本只能靠模型「在回复末尾写 ```json 围栏块」表达，执行器再从文本里
 * 切最后一块——多块、截断、写坏都退化成「没有回执」且不报错。挂上这个 server 后，模型
 * 调一次工具就把结构化回执交上来，垫在 `tool_call` 帧的 `arguments` 里。
 *
 * 协议：MCP stdio 传输 = 每行一条 JSON-RPC 2.0 消息（换行分帧，无 Content-Length 头）。
 * 只实现最小面：`initialize` / `tools/list` / `tools/call` / `ping`，
 * 其余方法回 -32601。不读文件、不联网、不落盘——工具调用只把参数回一份「收到」。
 *
 * 独立进程（宿主用 ELECTRON_RUN_AS_NODE 起它），因此这里不 import 主进程代码；
 * 键集合与类型是手写副本，由 `tests/plugins/shared/receipt-mcp-server.test.ts`
 * 对着 `RECEIPT_KEYS` 断言，防漂移。
 */
'use strict'

const readline = require('node:readline')

/** 协议版本：客户端给什么回什么，缺省用这个 */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'workbench-receipt', version: '1.0.0' }

/** 与 `protocol/receipt-keys.ts` 的 RECEIPT_KEYS 一致（测试对着它断言） */
const RECEIPT_KEYS = [
  'ask',
  'notices',
  'resolves',
  'later',
  'events',
  'spawn',
  'notes',
  'verdict',
  'checks',
  'findings',
  'addresses',
  'acceptance',
]

const TYPE_OF = {
  ask: 'array',
  notices: 'array',
  resolves: 'array',
  later: 'string',
  events: 'array',
  spawn: 'array',
  notes: 'array',
  verdict: 'string',
  checks: 'array',
  findings: 'array',
  addresses: 'array',
  acceptance: 'array',
}

const TOOL = {
  name: 'receipt',
  description:
    '向工作台提交本轮回执：要人拍板、知会、闸门判定、评审清单、验收自评。' +
    '与在回复末尾写 ```json 回执块等价，用哪个键写哪个。键：' +
    RECEIPT_KEYS.map((key) => `\`${key}\``).join(' / '),
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    properties: Object.fromEntries(RECEIPT_KEYS.map((key) => [key, { type: TYPE_OF[key] }])),
  },
}

const send = (message) => {
  try {
    process.stdout.write(JSON.stringify(message) + '\n')
  } catch {
    // stdout 关了：对端已退出，静默收场
  }
}

const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

/** 一条请求 → 一条响应（通知没有 id，不回） */
const handle = (message) => {
  if (message === null || typeof message !== 'object') return
  const { id, method, params } = message
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize': {
      const version =
        params && typeof params.protocolVersion === 'string'
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION
      if (!isNotification) {
        result(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
      }
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      if (!isNotification) result(id, {})
      return
    case 'tools/list':
      if (!isNotification) result(id, { tools: [TOOL] })
      return
    case 'tools/call': {
      if (isNotification) return
      const name = params && params.name
      if (name !== TOOL.name) {
        failure(id, -32602, `未知工具：${String(name)}`)
        return
      }
      // 参数不做业务校验：校验在内核侧（receipt-fields），这里只确认收到
      result(id, {
        content: [{ type: 'text', text: '回执已收到' }],
        isError: false,
      })
      return
    }
    default:
      if (!isNotification) failure(id, -32601, `未实现的方法：${String(method)}`)
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    // 非法 JSON 整行丢弃：不猜、不回半截响应
    return
  }
  try {
    handle(message)
  } catch (error) {
    const id = message && message.id
    if (id !== undefined && id !== null) {
      failure(id, -32603, error instanceof Error ? error.message : '内部错误')
    }
  }
})
rl.on('close', () => process.exit(0))
