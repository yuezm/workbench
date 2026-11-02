// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Runtime } from '../../../shared/ai-workflow-api'
import { buildInvocation, createDeepseekHarnessAdapter } from './deepseek-harness'

function rt(over: Partial<Runtime>): Runtime {
  return {
    id: 'r',
    name: 'r',
    kind: 'deepseek-harness',
    command: 'dsh',
    args: [],
    promptMode: 'arg',
    workdir: null,
    createdAt: 't',
    ...over,
  }
}

describe('buildInvocation', () => {
  it('arg 模式替换 {prompt}', () => {
    const inv = buildInvocation(rt({ args: ['-p', '{prompt}'] }), '你好')
    expect(inv).toEqual({ command: 'dsh', args: ['-p', '你好'], stdin: null })
  })
  it('arg 模式无占位符则追加 prompt', () => {
    const inv = buildInvocation(rt({ args: ['--go'] }), 'hi')
    expect(inv.args).toEqual(['--go', 'hi'])
    expect(inv.stdin).toBeNull()
  })
  it('stdin 模式把 prompt 写入 stdin', () => {
    const inv = buildInvocation(rt({ args: ['--go'], promptMode: 'stdin' }), 'hi')
    expect(inv).toEqual({ command: 'dsh', args: ['--go'], stdin: 'hi' })
  })
})

describe('createDeepseekHarnessAdapter（spawn 真实进程）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-adapter-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('执行脚本、捕获输出并返回退出码 0', async () => {
    const script = join(dir, 'ok.mjs')
    writeFileSync(script, 'process.stdout.write("OK-OUT")')
    const adapter = createDeepseekHarnessAdapter(rt({ command: process.execPath, args: [script] }))
    let streamed = ''
    const res = await adapter.run({
      prompt: '',
      workdir: dir,
      signal: new AbortController().signal,
      onOutput: (c) => {
        streamed += c
      },
    })
    expect(res.code).toBe(0)
    expect(res.output).toContain('OK-OUT')
    expect(streamed).toContain('OK-OUT')
  })

  it('stdin 模式：把 prompt 通过标准输入传给进程', async () => {
    const script = join(dir, 'echo.mjs')
    writeFileSync(script, 'process.stdin.on("data", (d) => process.stdout.write(d))')
    const adapter = createDeepseekHarnessAdapter(
      rt({ command: process.execPath, args: [script], promptMode: 'stdin' }),
    )
    const res = await adapter.run({
      prompt: 'PING',
      workdir: dir,
      signal: new AbortController().signal,
      onOutput: () => {},
    })
    expect(res.output).toContain('PING')
  })

  it('命令不存在时返回非零退出码', async () => {
    const adapter = createDeepseekHarnessAdapter(
      rt({ command: 'definitely-not-a-real-cmd-xyz-123' }),
    )
    const res = await adapter.run({
      prompt: '',
      workdir: dir,
      signal: new AbortController().signal,
      onOutput: () => {},
    })
    expect(res.code).not.toBe(0)
  })
})
