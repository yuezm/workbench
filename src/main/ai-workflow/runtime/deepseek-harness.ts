import { spawn } from 'node:child_process'
import type { Runtime } from '../../../shared/ai-workflow-api'

export interface RunInput {
  prompt: string
  workdir: string
  signal: AbortSignal
  onOutput(chunk: string): void
}

export interface RuntimeAdapter {
  run(input: RunInput): Promise<{ code: number; output: string }>
}

/**
 * 由运行时配置生成实际启动参数（纯函数，便于测试）。
 * - `arg` 模式：模板里的 `{prompt}` 被替换；若模板不含占位符，prompt 追加为最后一个参数。
 * - `stdin` 模式：prompt 写入标准输入。
 */
export function buildInvocation(
  runtime: Runtime,
  prompt: string,
): { command: string; args: string[]; stdin: string | null } {
  const args = runtime.args.map((a) => a.replaceAll('{prompt}', prompt))
  if (runtime.promptMode === 'stdin') return { command: runtime.command, args, stdin: prompt }
  if (!runtime.args.some((a) => a.includes('{prompt}'))) args.push(prompt)
  return { command: runtime.command, args, stdin: null }
}

/** DeepSeek Harness（以及任何同类 CLI）的通用适配器：spawn 本机命令并捕获输出。 */
export function createDeepseekHarnessAdapter(runtime: Runtime): RuntimeAdapter {
  return {
    run({ prompt, workdir, signal, onOutput }) {
      const { command, args, stdin } = buildInvocation(runtime, prompt)
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: workdir,
          shell: process.platform === 'win32',
        })
        let output = ''
        const onData = (buf: Buffer): void => {
          const s = buf.toString()
          output += s
          onOutput(s)
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        child.on('error', reject)
        const kill = (): void => {
          child.kill()
        }
        signal.addEventListener('abort', kill, { once: true })
        child.on('close', (code) => {
          signal.removeEventListener('abort', kill)
          resolve({ code: code ?? 1, output })
        })
        if (stdin !== null && child.stdin) {
          child.stdin.write(stdin)
          child.stdin.end()
        }
      })
    },
  }
}
