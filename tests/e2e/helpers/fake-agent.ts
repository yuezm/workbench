/**
 * 假智能体 CLI（E2E 用）：一个只会照着提示词回话的本地脚本。
 *
 * 走 `command` 执行器插件：命令是本机可执行文件、参数模板为空 → **提示词只经 stdin 传给
 * 子进程**，不进 argv（Windows 下 `.cmd` 只能走 stdin，命令行会被 cmd.exe 重新解析）。
 *
 * 输出末尾的 ```json 围栏块是「回执块」（内核据此认闸门判定 `verdict`/`checks` 与卡片）；
 * 正文里带 `{promptChars}` 占位，脚本在收尾时替换成提示词字数——断言据此确认
 * 「提示词真的送到了子进程」，而不只是「子进程跑起来了」。
 *
 * 脚本不读时钟、不联外网、不写文件，只回固定文案。
 */
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 假智能体的回复标记：e2e 断言靠它在消息流 / run 输出里定位。 */
export const FAKE_AGENT_MARKER = 'FAKE-AGENT-REPLY'

export interface FakeAgentOptions {
  /** 回话正文（可含 `{promptChars}` 占位；缺省带标记） */
  reply?: string
  /** 回执块：原样写进 ```json 围栏（闸门判定 / 卡片等） */
  receiptBlock?: Record<string, unknown>
  /** 子进程退出码（缺省 0） */
  exitCode?: number
}

/** 假智能体脚本正文：读 stdin 的提示词，回固定答复 + 可选回执块。 */
function scriptSource(options: FakeAgentOptions): string {
  const reply = options.reply ?? `${FAKE_AGENT_MARKER}: 已收到 {promptChars} 字提示词`
  const exitCode = options.exitCode ?? 0
  const outputLines = [reply]
  if (options.receiptBlock !== undefined) {
    outputLines.push('', '```json', JSON.stringify(options.receiptBlock), '```')
  }
  return [
    '// 假智能体（E2E 用）：读 stdin 的提示词，回固定答复。',
    `const OUTPUT_LINES = ${JSON.stringify(outputLines)}`,
    `const EXIT_CODE = ${exitCode}`,
    'let input = ""',
    "process.stdin.setEncoding('utf8')",
    'process.stdin.on("data", (chunk) => { input += chunk })',
    'process.stdin.on("end", () => {',
    '  const body = OUTPUT_LINES.join("\\n").replace("{promptChars}", String(input.length))',
    '  process.stdout.write(body + "\\n")',
    '  process.exit(EXIT_CODE)',
    '})',
    '',
  ].join('\n')
}

/**
 * 在 `dir` 下写好假智能体（脚本 + 启动器），返回**启动器的绝对路径**。
 *
 * Windows 用 `.cmd`（`command` 执行器会固定包装成 `cmd.exe /c <脚本> <参数>`）；
 * POSIX 用带执行位的 `.sh`。启动器里写死本机 node 的绝对路径——子进程环境是干净的，
 * 不能指望 PATH 里能捞到 node。
 */
export function writeFakeAgent(dir: string, options: FakeAgentOptions = {}): string {
  const scriptPath = path.join(dir, 'fake-agent.mjs')
  writeFileSync(scriptPath, scriptSource(options), 'utf8')

  if (process.platform === 'win32') {
    const launcherPath = path.join(dir, 'fake-agent.cmd')
    writeFileSync(
      launcherPath,
      ['@echo off', `"${process.execPath}" "${scriptPath}" %*`, ''].join('\r\n'),
      'utf8',
    )
    return launcherPath
  }

  const launcherPath = path.join(dir, 'fake-agent.sh')
  writeFileSync(
    launcherPath,
    ['#!/bin/sh', `exec "${process.execPath}" "${scriptPath}" "$@"`, ''].join('\n'),
    'utf8',
  )
  chmodSync(launcherPath, 0o755)
  return launcherPath
}
