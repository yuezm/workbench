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
  'deliverables',
  'findings',
  'addresses',
]

/**
 * 枚举镜像（R3）：与 `protocol` 的 `GATE_VERDICTS` / `REVIEW_SEVERITIES` /
 * `FINDING_DISPOSITIONS` 同源，由 `tests/plugins/shared/receipt-mcp-server.test.ts` 断言。
 * 手写副本的原因：这是独立子进程，import 不到主进程的 TS 模块。
 */
const VERDICTS = ['pass', 'fail']
const SEVERITIES = ['blocker', 'high', 'medium', 'low']
const DISPOSITIONS = ['fixed', 'rejected', 'deferred']

const listOf = (item) => ({ type: 'array', items: item })
const obj = (properties, required) => ({ type: 'object', properties, required })

/** 嵌套 schema：把枚举与必需字段写到模型看得见的地方（同 `receipt-tool.ts` 的 SCHEMA_OF）。 */
const SCHEMA_OF = {
  ask: listOf(
    obj(
      {
        title: { type: 'string' },
        text: { type: 'string' },
        options: listOf({ type: 'string' }),
        key: { type: 'string' },
      },
      ['title', 'options'],
    ),
  ),
  notices: listOf({ type: 'string' }),
  resolves: listOf({ type: 'string' }),
  later: { type: 'string' },
  events: listOf(
    obj(
      {
        source: { type: 'string' },
        type: { type: 'string' },
        subject: { type: 'string' },
        summary: { type: 'string' },
      },
      ['source', 'type', 'subject'],
    ),
  ),
  spawn: listOf(
    obj(
      {
        subject: { type: 'string' },
        summary: { type: 'string' },
        stageId: { type: 'string' },
        key: { type: 'string' },
      },
      ['subject'],
    ),
  ),
  notes: listOf({ type: 'string' }),
  verdict: { type: 'string', enum: VERDICTS },
  checks: listOf(
    obj(
      { cmd: { type: 'string' }, exitCode: { type: 'integer' }, acceptance: { type: 'integer' } },
      ['cmd', 'exitCode'],
    ),
  ),
  deliverables: {
    type: 'object',
    properties: {
      branch: { type: 'string' },
      base: { type: 'string' },
      commits: listOf({ type: 'string' }),
      files: listOf({ type: 'string' }),
      gates: listOf(
        obj({ cmd: { type: 'string' }, exitCode: { type: 'integer' } }, ['cmd', 'exitCode']),
      ),
    },
  },
  findings: listOf(
    obj(
      {
        key: { type: 'string', maxLength: 32 },
        severity: { type: 'string', enum: SEVERITIES },
        location: { type: 'string', maxLength: 300 },
        claim: { type: 'string', maxLength: 500 },
        evidence: { type: 'string', maxLength: 2000 },
        requiredAction: { type: 'string', maxLength: 500 },
      },
      ['key', 'severity', 'claim', 'requiredAction'],
    ),
  ),
  addresses: listOf(
    obj(
      {
        findingId: { type: 'string' },
        disposition: { type: 'string', enum: DISPOSITIONS },
        checkRef: { type: 'string' },
        note: { type: 'string' },
      },
      ['findingId', 'disposition'],
    ),
  ),
}

const TOOL = {
  name: 'receipt',
  description:
    '向工作台提交本轮回执：要人拍板、知会、闸门判定、评审清单。' +
    '与在回复末尾写 ```json 回执块等价，用哪个键写哪个。键：' +
    RECEIPT_KEYS.map((key) => `\`${key}\``).join(' / '),
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    properties: Object.fromEntries(RECEIPT_KEYS.map((key) => [key, SCHEMA_OF[key]])),
  },
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 最小校验（R2）：只查协议枚举与必需形状——完整校验仍在内核侧（receipt-fields）。
 *
 * 为什么这里也要查：模型拿不到内核的判定结果，server 若照旧回「回执已收到」，
 * 它会确信自己交上去了（实测正文里宣称「已发卡」而事实里没有）。
 *
 * @returns {string[]} 问题清单；空数组表示通过
 */
const problemsOf = (args) => {
  const problems = []
  const checkList = (key, value, each) => {
    if (value === undefined || value === null) return
    if (!Array.isArray(value)) {
      problems.push(`${key} 必须是数组`)
      return
    }
    value.forEach((entry, index) => each(entry, `${key}[${index}]`))
  }

  if (args.verdict !== undefined && args.verdict !== null && !VERDICTS.includes(args.verdict)) {
    problems.push(`verdict 只能是 ${VERDICTS.join(' / ')}（收到 ${JSON.stringify(args.verdict)}）`)
  }
  checkList('findings', args.findings, (entry, at) => {
    if (!isObject(entry)) return problems.push(`${at} 必须是对象`)
    if (!SEVERITIES.includes(entry.severity)) {
      problems.push(
        `${at}.severity 只能是 ${SEVERITIES.join(' / ')}（收到 ${JSON.stringify(entry.severity)}）`,
      )
    }
    for (const field of ['key', 'claim', 'requiredAction']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        problems.push(`${at}.${field} 必填`)
      }
    }
  })
  checkList('checks', args.checks, (entry, at) => {
    if (!isObject(entry)) return problems.push(`${at} 必须是对象`)
    if (typeof entry.cmd !== 'string' || entry.cmd.trim() === '') problems.push(`${at}.cmd 必填`)
    if (!Number.isInteger(entry.exitCode)) problems.push(`${at}.exitCode 必须是整数`)
  })
  checkList('ask', args.ask, (entry, at) => {
    if (!isObject(entry)) return problems.push(`${at} 必须是对象`)
    if (!Array.isArray(entry.options) || entry.options.length === 0) {
      problems.push(`${at}.options 需要非空数组`)
    }
  })
  checkList('addresses', args.addresses, (entry, at) => {
    if (!isObject(entry)) return problems.push(`${at} 必须是对象`)
    if (!DISPOSITIONS.includes(entry.disposition)) {
      problems.push(`${at}.disposition 只能是 ${DISPOSITIONS.join(' / ')}`)
    }
  })
  return problems
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
      // R2：验不过就回 isError + 可读原因，让模型在同一轮里改；不再一律「已收到」
      const args = params && params.arguments === undefined ? {} : params && params.arguments
      const problems = isObject(args) ? problemsOf(args) : ['参数必须是对象（键见 tools/list）']
      if (problems.length > 0) {
        result(id, {
          content: [
            {
              type: 'text',
              text:
                '回执没有全部被接受，原因：\n- ' +
                problems.join('\n- ') +
                '\n修好后请把完整回执重发一次（不要只发修正的那部分）。',
            },
          ],
          isError: true,
        })
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
