/**
 * 「先失败、后成功」的假智能体 CLI（E2E 用）：失败 → 原地重跑 → 成功这条核心流程
 * 需要同一条命令在不同轮次给出不同结果。
 *
 * 计次落在 `<dir>/attempts.txt`（每次启动自增）：第 1..failTimes 次退出码 1（失败），
 * 之后的轮次退出码 0，并在输出末尾附回执块（闸门判定用）。
 *
 * 与 `fake-agent.ts` 一样走 `command` 执行器插件：命令是本机可执行文件、参数模板为空，
 * 提示词只经 stdin 传给子进程，不进 argv（Windows 下 `.cmd` 只能走 stdin）。
 * 脚本不读时钟、不联外网，只读写自己的计次文件。
 */
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 失败轮的固定标记（断言用：库里的 run 输出应含它）。 */
export const FLAKY_FAIL_MARKER = 'FLAKY-FAIL'
/** 成功轮的固定标记。 */
export const FLAKY_OK_MARKER = 'FLAKY-OK'

export interface FlakyAgentOptions {
  /** 前几次失败（1 基，缺省 1） */
  failTimes?: number
  /** 成功轮附带的回执块（原样写进 ```json 围栏） */
  receiptBlock?: Record<string, unknown>
}

/** 脚本正文：计次 → 读 stdin → 按轮次给失败/成功输出与退出码。 */
function scriptSource(stateDir: string, options: FlakyAgentOptions): string {
  const failTimes = options.failTimes ?? 1
  const failLines = [`${FLAKY_FAIL_MARKER}: 第 {attempt} 轮执行失败（模拟执行器崩溃）`]
  const okLines = [`${FLAKY_OK_MARKER}: 第 {attempt} 轮执行成功，收到 {promptChars} 字提示词`]
  if (options.receiptBlock !== undefined) {
    okLines.push('', '```json', JSON.stringify(options.receiptBlock), '```')
  }
  return [
    '// 先失败后成功的假智能体（E2E 用）：轮次计在 attempts.txt。',
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "import path from 'node:path'",
    `const STATE = path.join(${JSON.stringify(stateDir)}, 'attempts.txt')`,
    'let attempt = 0',
    'try {',
    '  attempt = Number(readFileSync(STATE, "utf8").trim() || "0")',
    '} catch {',
    '  attempt = 0',
    '}',
    'attempt += 1',
    'writeFileSync(STATE, String(attempt), "utf8")',
    `const FAIL_TIMES = ${failTimes}`,
    `const FAIL_LINES = ${JSON.stringify(failLines)}`,
    `const OK_LINES = ${JSON.stringify(okLines)}`,
    'let input = ""',
    "process.stdin.setEncoding('utf8')",
    'process.stdin.on("data", (chunk) => { input += chunk })',
    'process.stdin.on("end", () => {',
    '  const failed = attempt <= FAIL_TIMES',
    '  const body = (failed ? FAIL_LINES : OK_LINES)',
    '    .join("\\n")',
    '    .replace("{attempt}", String(attempt))',
    '    .replace("{promptChars}", String(input.length))',
    '  process.stdout.write(body + "\\n")',
    '  process.exit(failed ? 1 : 0)',
    '})',
    '',
  ].join('\n')
}

/**
 * 在 `dir` 下写好「先失败后成功」的假智能体，返回**启动器绝对路径**。
 *
 * Windows 用 `.cmd`（`command` 执行器固定包装成 `cmd.exe /c <脚本> <参数>`），
 * POSIX 用带执行位的 `.sh`；启动器写死本机 node 绝对路径（子进程环境是干净的）。
 */
export function writeFlakyAgent(dir: string, options: FlakyAgentOptions = {}): string {
  const scriptPath = path.join(dir, 'flaky-agent.mjs')
  writeFileSync(scriptPath, scriptSource(dir, options), 'utf8')

  if (process.platform === 'win32') {
    const launcherPath = path.join(dir, 'flaky-agent.cmd')
    writeFileSync(
      launcherPath,
      ['@echo off', `"${process.execPath}" "${scriptPath}" %*`, ''].join('\r\n'),
      'utf8',
    )
    return launcherPath
  }

  const launcherPath = path.join(dir, 'flaky-agent.sh')
  writeFileSync(
    launcherPath,
    ['#!/bin/sh', `exec "${process.execPath}" "${scriptPath}" "$@"`, ''].join('\n'),
    'utf8',
  )
  chmodSync(launcherPath, 0o755)
  return launcherPath
}
