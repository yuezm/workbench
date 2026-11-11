/**
 * dsh `--stdio` 协议探针（M24 真机收尾用，一次性诊断脚本）。
 *
 * 目的：确认 dsh 的 execute 帧认不认 `mcp_servers` 字段、元素形状是什么。
 * 步骤命中一次就够，结论抄进 docs/specs/SPEC-plugins.md 的「工具通道」段。
 *
 * 用法（在仓库根目录）：
 *   node scripts/dsh-stdio-probe.mjs                 # 只起进程，看 ready 帧（不花 token）
 *   node scripts/dsh-stdio-probe.mjs --full          # 再发一帧 execute（会真的调一次模型，短提示）
 *   node scripts/dsh-stdio-probe.mjs --full --profile multica
 *
 * 读法：
 *   - 出现 `mcp_servers` 相关 `protocol_error` / `STARTUP_FAILED` → 形状不认，改元素字段再试；
 *   - 只有 `ready` / `session` / `text` / `result`，没有报错 → 字段被接受（或忽略），
 *     再把 `mcp_servers` 换成一个真实 server 跑一轮工具调用（见 SPEC「工具通道」第 5 条）。
 */
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const profile = flag('profile', 'multica')
const seconds = Number(flag('seconds', argv.includes('--full') ? '90' : '15'))
const full = argv.includes('--full')

const args = ['--profile', profile, '--stdio']
// Windows：dsh 是 .cmd 启动器，必须经 cmd.exe 才能起来（与 workbench 的 command 执行器同口径）
const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', 'dsh', ...args], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let seq = 0
const log = (stream, line) => {
  if (line.trim() === '') return
  seq += 1
  console.log(`[${stream} ${String(seq).padStart(2, '0')}] ${line}`)
}

const splitter = (stream) => {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) log(stream === child.stdout ? 'out' : 'err', line)
  })
}
splitter(child.stdout)
splitter(child.stderr)

const requestId = 'probe-1'
const send = (frame) => {
  const text = JSON.stringify(frame)
  console.log(`[ >>>> ] ${text}`)
  child.stdin.write(text + '\n')
}

if (full) {
  // 与 dsh 执行器实际发出去的帧同形（plugins/executors/dsh/run.ts 的 executeFrame）
  const mcpJson = flag('mcp', null)
  const mcpServers =
    mcpJson === null
      ? [
          {
            transport: 'stdio',
            name: 'workbench',
            command: process.execPath,
            args: ['D:/Codes/workbench/src/plugins/shared/receipt-mcp-server.cjs'],
            env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
          },
        ]
      : JSON.parse(mcpJson)
  send({
    v: 1,
    type: 'execute',
    request_id: requestId,
    prompt: '只回复 OK 两个字母，不要做别的事。',
    cwd: process.cwd(),
    mcp_servers: mcpServers,
  })
}

child.on('close', (code) => {
  console.log(`[exit] ${code}`)
  process.exit(0)
})

setTimeout(() => {
  console.log(`[timeout] ${seconds}s 到，结束进程`)
  child.stdin.end()
  child.kill('SIGKILL')
}, seconds * 1000)
