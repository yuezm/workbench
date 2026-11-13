// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEvent } from '../../src/protocol/entities'
import type { Receipt } from '../../src/protocol/inputs'
import {
  RUN_ARCHIVE_SCHEMA_VERSION,
  archiveRunTerminal,
  backfillRunOutputs,
  buildRunMeta,
  readRunMetas,
  renderThreadIndex,
  renderTranscript,
  reviewArtifactPath,
  runDirPath,
  runMetaPath,
  runOutputPath,
  runPromptPath,
  runTranscriptPath,
  summarizeFrames,
  threadIndexPath,
  withReviewArtifact,
  withRunArtifacts,
  writeProjectDoc,
  writeReviewArtifact,
  writeRunOutput,
  writeRunPrompt,
  writeThreadIndex,
  type ArchiveRun,
  type RunArchiveLabels,
  type RunArchiveMeta,
} from '../../src/host/artifacts'

let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wb-artifacts-'))
})

afterEach(() => {
  // 临时目录随系统清理：单测只断言落盘结果，不做额外回收动作
})

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: 'run-1:1',
  turn: 1,
  output: '## 评审报告\n\nVerdict: REQUEST CHANGES\n',
  ...over,
})

describe('host/artifacts 评审报告落盘（M14）', () => {
  it('路径只用 id：<root>/threads/<threadId>/runs/<runId>/review.md', () => {
    expect(reviewArtifactPath('R', 'th-1', 'run-1')).toBe(
      path.join('R', 'threads', 'th-1', 'runs', 'run-1', 'review.md'),
    )
  })

  it('写入返回路径 / sha256 / 字节数，内容原样落盘', () => {
    const text = '## 评审\n\n- R1 BOM\n'
    const artifact = writeReviewArtifact(root, 'th-1', 'run-1', text)
    expect(artifact).not.toBeNull()
    const target = reviewArtifactPath(root, 'th-1', 'run-1')
    expect(artifact?.path).toBe(target)
    expect(artifact?.bytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(artifact?.sha256).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    expect(readFileSync(target, 'utf8')).toBe(text)
    // 原子写：临时文件不留下
    expect(existsSync(`${target}.tmp`)).toBe(false)
  })

  it('重复写入覆盖上一版（同一 run 只有一份正文）', () => {
    writeReviewArtifact(root, 'th-1', 'run-1', '旧正文')
    const second = writeReviewArtifact(root, 'th-1', 'run-1', '新正文')
    expect(readFileSync(second?.path as string, 'utf8')).toBe('新正文')
  })

  it('目录不可建（父路径是文件）：返回 null 并清掉临时文件，不抛错', () => {
    const blocker = path.join(root, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const nested = path.join(blocker, 'threads')
    expect(writeReviewArtifact(nested, 'th-1', 'run-1', '正文')).toBeNull()
  })

  it('withReviewArtifact：只对带 verdict / findings 且挂线程的回执落盘', () => {
    const run = { id: 'run-1', threadId: 'th-1' }
    const plain = withReviewArtifact(root, run, receipt())
    expect(plain.artifact).toBeUndefined()

    const withVerdict = withReviewArtifact(root, run, receipt({ verdict: 'fail' }))
    expect(withVerdict.artifact?.path).toBe(reviewArtifactPath(root, 'th-1', 'run-1'))

    const withFindings = withReviewArtifact(
      root,
      { id: 'run-2', threadId: 'th-1' },
      receipt({
        findings: [{ key: 'R1', severity: 'high', claim: '断言', requiredAction: '复跑' }],
      }),
    )
    expect(withFindings.artifact?.path).toBe(reviewArtifactPath(root, 'th-1', 'run-2'))

    // 没挂线程 / 没配 root：不落盘，回执原样返回
    const noThread = withReviewArtifact(
      root,
      { id: 'run-3', threadId: null },
      receipt({ verdict: 'fail' }),
    )
    expect(noThread.artifact).toBeUndefined()
    const noRoot = withReviewArtifact(undefined, run, receipt({ verdict: 'fail' }))
    expect(noRoot.artifact).toBeUndefined()
  })

  it('落盘失败时回执照常返回（正文缺失只影响引用，不影响推进）', () => {
    const blocker = path.join(root, 'file-blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const failed = withReviewArtifact(
      blocker,
      { id: 'run-1', threadId: 'th-1' },
      receipt({ verdict: 'fail' }),
    )
    expect(failed.artifact).toBeUndefined()
    expect(failed.verdict).toBe('fail')
  })

  it('评审回执没有 output 字段：照样落一份空正文，引用指向它', () => {
    const noOutput: Receipt = { status: 'failed', leaseId: 'run-1:1', turn: 1, verdict: 'fail' }
    const result = withReviewArtifact(root, { id: 'run-1', threadId: 'th-1' }, noOutput)
    expect(result.artifact?.bytes).toBe(0)
    expect(readFileSync(result.artifact?.path as string, 'utf8')).toBe('')
  })

  it('空正文也落盘（0 字节合法），sha256 是空串的摘要', () => {
    const artifact = writeReviewArtifact(root, 'th-1', 'run-9', '')
    expect(artifact?.bytes).toBe(0)
    expect(artifact?.sha256).toBe(createHash('sha256').update('', 'utf8').digest('hex'))
    mkdirSync(path.dirname(artifact?.path as string), { recursive: true })
  })
})

describe('host/artifacts 本轮正文落盘（M15）', () => {
  const run = (
    over: { id?: string; threadId?: string | null; purpose?: 'stage' | 'chat' } = {},
  ) => ({
    id: 'run-1',
    threadId: 'th-1',
    purpose: 'stage' as const,
    ...over,
  })

  it('路径只用 id：<root>/threads/<threadId>/runs/<runId>/output.md', () => {
    expect(runOutputPath('R', 'th-1', 'run-1')).toBe(
      path.join('R', 'threads', 'th-1', 'runs', 'run-1', 'output.md'),
    )
  })

  it('挂线程的 stage run：正文原样落盘，临时文件不残留', () => {
    const result = withRunArtifacts(root, run(), receipt({ output: '实现完成' }))
    const target = runOutputPath(root, 'th-1', 'run-1')
    expect(result.output).toBe('实现完成')
    expect(readFileSync(target, 'utf8')).toBe('实现完成')
    expect(existsSync(`${target}.tmp`)).toBe(false)
  })

  it('没有正文但失败：写错误说明，索引指过去仍有东西可读', () => {
    const result = withRunArtifacts(
      root,
      run(),
      receipt({ status: 'failed', output: '', error: '编译失败' }),
    )
    expect(result.status).toBe('failed')
    expect(readFileSync(runOutputPath(root, 'th-1', 'run-1'), 'utf8')).toContain('编译失败')
  })

  it('stage run 的回执没有 output 字段：按「没有正文」处理，不写文件', () => {
    const noOutput: Receipt = { status: 'succeeded', leaseId: 'run-1:1', turn: 1 }
    expect(withRunArtifacts(root, run(), noOutput)).toBe(noOutput)
    expect(existsSync(runOutputPath(root, 'th-1', 'run-1'))).toBe(false)
  })

  it('正文为空且没有错误：不写空文件', () => {
    withRunArtifacts(root, run(), receipt({ output: '' }))
    expect(existsSync(runOutputPath(root, 'th-1', 'run-1'))).toBe(false)
  })

  it('只有 errorCode 没有错误正文：退到 errorCode，不留读不到的路径', () => {
    withRunArtifacts(root, run(), receipt({ status: 'failed', output: '', errorCode: 'timeout' }))
    expect(readFileSync(runOutputPath(root, 'th-1', 'run-1'), 'utf8')).toBe('# 错误\n\ntimeout\n')
  })

  it('评审 run 同时落 output.md 与 review.md', () => {
    withRunArtifacts(root, run(), receipt({ verdict: 'fail' }))
    expect(existsSync(runOutputPath(root, 'th-1', 'run-1'))).toBe(true)
    expect(existsSync(reviewArtifactPath(root, 'th-1', 'run-1'))).toBe(true)
  })

  it('不挂线程 / 聊天 run / 没配 root：都不落盘，回执原样返回', () => {
    const source = receipt({ output: '聊天回复' })
    expect(withRunArtifacts(root, run({ threadId: null }), source)).toBe(source)
    expect(withRunArtifacts(root, run({ purpose: 'chat' }), source)).toBe(source)
    expect(withRunArtifacts(undefined, run(), source)).toBe(source)
    expect(existsSync(path.join(root, 'threads'))).toBe(false)
  })
})

// ---------- 执行归档（M16） ----------

const labels = (over: Partial<RunArchiveLabels> = {}): RunArchiveLabels => ({
  taskId: 'task-1',
  taskTitle: '协议导出加 HASH',
  stageId: 'stage-1',
  stageName: '需求澄清',
  agentId: 'agent-1',
  agentName: 'coder',
  ...over,
})

const archiveRun = (over: Partial<ArchiveRun> = {}): ArchiveRun => ({
  id: 'run-1',
  threadId: 'th-1',
  taskId: 'task-1',
  stageId: 'stage-1',
  agentId: 'agent-1',
  purpose: 'stage',
  turn: 2,
  status: 'running',
  executorKey: 'dsh',
  startedAt: '2026-11-10T08:07:00.000Z',
  endedAt: null,
  createdAt: '2026-11-10T08:06:59.000Z',
  durationMs: null,
  exitCode: null,
  errorCode: null,
  error: null,
  sessionId: null,
  usage: null,
  ...over,
})

const frames = (
  items: Array<Partial<RunEvent> & { seq: number; type: RunEvent['type'] }>,
): RunEvent[] => items.map((item) => ({ ...item }) as RunEvent)

describe('host/artifacts 执行归档路径（M16）', () => {
  it('全部只用 id：runs/<runId>/<file> 与线程 index.md', () => {
    expect(runDirPath('R', 'th-1', 'run-1')).toBe(
      path.join('R', 'threads', 'th-1', 'runs', 'run-1'),
    )
    expect(runPromptPath('R', 'th-1', 'run-1')).toBe(
      path.join('R', 'threads', 'th-1', 'runs', 'run-1', 'prompt.md'),
    )
    expect(runTranscriptPath('R', 'th-1', 'run-1')).toBe(
      path.join('R', 'threads', 'th-1', 'runs', 'run-1', 'transcript.jsonl'),
    )
    expect(runMetaPath('R', 'th-1', 'run-1')).toBe(
      path.join('R', 'threads', 'th-1', 'runs', 'run-1', 'meta.json'),
    )
    expect(threadIndexPath('R', 'th-1')).toBe(path.join('R', 'threads', 'th-1', 'index.md'))
  })
})

describe('host/artifacts 派发提示词（M16）', () => {
  it('写表头 + 原文；原文缺尾换行时补齐', () => {
    const wrote = writeRunPrompt(
      root,
      archiveRun(),
      labels(),
      '你负责需求澄清',
      '2026-11-10T08:07:00.000Z',
    )
    expect(wrote).toBe(true)
    const text = readFileSync(runPromptPath(root, 'th-1', 'run-1'), 'utf8')
    expect(text.startsWith('<!-- 本轮派发信息')).toBe(true)
    expect(text).toContain('runId: run-1')
    expect(text).toContain('turn: 2')
    expect(text).toContain('任务: 协议导出加 HASH <task-1>')
    expect(text).toContain('阶段: 需求澄清 <stage-1>')
    expect(text).toContain('智能体: coder <agent-1>')
    expect(text.endsWith('你负责需求澄清\n')).toBe(true)
    expect(existsSync(`${runPromptPath(root, 'th-1', 'run-1')}.tmp`)).toBe(false)
  })

  it('已有尾换行不重复补', () => {
    writeRunPrompt(root, archiveRun(), labels(), '提示词\n', '2026-11-10T08:07:00.000Z')
    expect(readFileSync(runPromptPath(root, 'th-1', 'run-1'), 'utf8').endsWith('提示词\n\n')).toBe(
      false,
    )
  })

  it('标签缺失时写「-」而不是 undefined', () => {
    writeRunPrompt(
      root,
      archiveRun(),
      labels({ taskTitle: null, stageName: null, agentName: null }),
      'x',
      '2026-11-10T08:07:00.000Z',
    )
    const text = readFileSync(runPromptPath(root, 'th-1', 'run-1'), 'utf8')
    expect(text).toContain('任务: - <task-1>')
    expect(text).toContain('阶段: - <stage-1>')
    expect(text).not.toContain('undefined')
  })

  it('任务 / 阶段 / 智能体全查不到（脏投影）：表头全写「-」', () => {
    writeRunPrompt(
      root,
      archiveRun(),
      labels({
        taskId: null,
        taskTitle: null,
        stageId: null,
        stageName: null,
        agentId: null,
        agentName: null,
      }),
      'x',
      '2026-11-10T08:07:00.000Z',
    )
    const text = readFileSync(runPromptPath(root, 'th-1', 'run-1'), 'utf8')
    expect(text).toContain('任务: - <->')
    expect(text).toContain('阶段: - <->')
    expect(text).toContain('智能体: - <->')
    expect(text).not.toContain('null')
  })

  it('空提示词 / 聊天 run / 不挂线程 / 没配 root：都不写', () => {
    expect(writeRunPrompt(root, archiveRun(), labels(), '   ', 'now')).toBe(false)
    expect(writeRunPrompt(root, archiveRun({ purpose: 'chat' }), labels(), 'x', 'now')).toBe(false)
    expect(writeRunPrompt(root, archiveRun({ threadId: null }), labels(), 'x', 'now')).toBe(false)
    expect(writeRunPrompt(undefined, archiveRun(), labels(), 'x', 'now')).toBe(false)
    expect(existsSync(path.join(root, 'threads'))).toBe(false)
  })
})

describe('host/artifacts 帧流水与元数据（M16）', () => {
  it('transcript：一行一帧，空帧返回空串', () => {
    const text = renderTranscript(
      frames([
        { seq: 1, type: 'thinking', text: 'a' },
        { seq: 2, type: 'tool_result', tool: 'grep', output: 'hit' },
      ]),
    )
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toEqual({ seq: 1, type: 'thinking', text: 'a' })
    expect(renderTranscript([])).toBe('')
  })

  it('帧统计：thinking / text / tool_call / tool_result 分别计数', () => {
    expect(
      summarizeFrames(
        frames([
          { seq: 1, type: 'thinking', text: 'a' },
          { seq: 2, type: 'text', text: 'b' },
          { seq: 3, type: 'tool_call', tool: 'grep' },
          { seq: 4, type: 'tool_result', tool: 'grep' },
          { seq: 5, type: 'status', status: 'running' },
        ]),
      ),
    ).toEqual({ total: 5, thinking: 1, text: 1, toolCall: 1, toolResult: 1 })
  })

  it('meta：回执字段优先，缺失回落投影行；endedAt 用落盘时刻兜底', () => {
    const meta = buildRunMeta(
      archiveRun({ durationMs: 100, exitCode: 1, sessionId: 'old', error: '旧错误' }),
      labels(),
      frames([{ seq: 1, type: 'thinking', text: 'a' }]),
      { status: 'failed', durationMs: 42, exitCode: 2, sessionId: 'sess-9', error: '超时' },
      '2026-11-10T08:09:00.000Z',
      ['prompt.md'],
    )
    expect(meta.schemaVersion).toBe(RUN_ARCHIVE_SCHEMA_VERSION)
    expect(meta.runId).toBe('run-1')
    expect(meta.threadId).toBe('th-1')
    expect(meta.status).toBe('failed')
    expect(meta.durationMs).toBe(42)
    expect(meta.exitCode).toBe(2)
    expect(meta.sessionId).toBe('sess-9')
    expect(meta.error).toBe('超时')
    expect(meta.endedAt).toBe('2026-11-10T08:09:00.000Z')
    expect(meta.files).toEqual(['prompt.md'])
  })

  it('meta：run 没挂线程时 threadId 归空串（不写 null）', () => {
    const meta = buildRunMeta(
      archiveRun({ threadId: null }),
      labels(),
      [],
      { status: 'succeeded' },
      '2026-11-10T08:09:00.000Z',
      [],
    )
    expect(meta.threadId).toBe('')
  })

  it('meta：回执没给的字段回落投影行（含 usage / startedAt）', () => {
    const meta = buildRunMeta(
      archiveRun({
        durationMs: 100,
        exitCode: 0,
        sessionId: 'sess-1',
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      labels(),
      [],
      { status: 'succeeded' },
      '2026-11-10T08:09:00.000Z',
      [],
    )
    expect(meta.durationMs).toBe(100)
    expect(meta.exitCode).toBe(0)
    expect(meta.sessionId).toBe('sess-1')
    expect(meta.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })
})

describe('host/artifacts 终态归档与索引（M16）', () => {
  it('写 transcript / meta，并把已有文件列进 meta.files', () => {
    writeReviewArtifact(root, 'th-1', 'run-1', '## 评审\n')
    writeRunOutput(root, 'th-1', 'run-1', '本轮产出')
    writeRunPrompt(root, archiveRun(), labels(), '提示词', '2026-11-10T08:07:00.000Z')

    archiveRunTerminal(root, {
      run: archiveRun(),
      labels: labels(),
      frames: frames([
        { seq: 1, type: 'thinking', text: 'a' },
        { seq: 2, type: 'text', text: 'b' },
      ]),
      receipt: receipt({ status: 'succeeded', durationMs: 12 }),
      at: '2026-11-10T08:09:00.000Z',
    })

    const meta = JSON.parse(
      readFileSync(runMetaPath(root, 'th-1', 'run-1'), 'utf8'),
    ) as RunArchiveMeta
    expect(meta.status).toBe('succeeded')
    expect(meta.files).toEqual(['prompt.md', 'transcript.jsonl', 'output.md', 'review.md'])
    expect(
      readFileSync(runTranscriptPath(root, 'th-1', 'run-1'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(2)
  })

  it('没有帧：只写 meta（不产生空 transcript）', () => {
    archiveRunTerminal(root, {
      run: archiveRun(),
      labels: labels(),
      frames: [],
      receipt: receipt(),
      at: '2026-11-10T08:09:00.000Z',
    })
    expect(existsSync(runTranscriptPath(root, 'th-1', 'run-1'))).toBe(false)
    const meta = JSON.parse(
      readFileSync(runMetaPath(root, 'th-1', 'run-1'), 'utf8'),
    ) as RunArchiveMeta
    expect(meta.files).toEqual([])
  })

  it('聊天 run / 不挂线程 / 没配 root：一律不落盘', () => {
    const base = { labels: labels(), frames: [], receipt: receipt(), at: 'now' }
    archiveRunTerminal(root, { ...base, run: archiveRun({ purpose: 'chat' }) })
    archiveRunTerminal(root, { ...base, run: archiveRun({ threadId: null }) })
    archiveRunTerminal(undefined, { ...base, run: archiveRun() })
    expect(existsSync(path.join(root, 'threads'))).toBe(false)
  })

  it('索引：按开始时间排序，编号从 1 起，含阶段名与正文链接', () => {
    // 走生产顺序：先落正文（withRunArtifacts），再终态归档（archiveRunTerminal）
    const archive = (runId: string, startedAt: string, stageName: string): void => {
      const run = archiveRun({ id: runId, startedAt })
      const source = receipt()
      withRunArtifacts(root, run, source)
      archiveRunTerminal(root, {
        run,
        labels: labels({ stageName }),
        frames: frames([{ seq: 1, type: 'thinking', text: 'x' }]),
        receipt: source,
        at: '2026-11-10T09:30:00.000Z',
      })
    }
    archive('run-b', '2026-11-10T09:00:00.000Z', '实现')
    archive('run-a', '2026-11-10T08:00:00.000Z', '需求澄清')

    const index = readFileSync(threadIndexPath(root, 'th-1'), 'utf8')
    expect(index.indexOf('需求澄清')).toBeLessThan(index.indexOf('实现'))
    expect(index).toContain('| 1 |')
    expect(index).toContain('| 2 |')
    expect(index).toContain('[`output.md`](runs/run-a/output.md)')
    expect(index).toContain('run-b')
  })

  it('索引只链 output.md：prompt / transcript / meta 不出链接，评审报告只留 ·review 标记', () => {
    // 有评审内容（verdict）→ 同时落 output.md 与 review.md
    const run = archiveRun({ id: 'run-review' })
    const source = receipt({ verdict: 'fail' })
    withRunArtifacts(root, run, source)
    archiveRunTerminal(root, {
      run,
      labels: labels(),
      frames: frames([{ seq: 1, type: 'thinking', text: 'x' }]),
      receipt: source,
      at: '2026-11-10T09:30:00.000Z',
    })
    const index = readFileSync(threadIndexPath(root, 'th-1'), 'utf8')
    const row = index.split('\n').find((line) => line.includes('run-review')) as string
    expect(row).toContain('[`output.md`](runs/run-review/output.md)')
    expect(row).toContain('·review')
    expect(row).not.toContain('review.md)')
    for (const file of ['prompt.md', 'transcript.jsonl', 'meta.json']) {
      expect(index).not.toContain(`](runs/run-review/${file})`)
    }
  })

  it('没有 output.md 的 run：产出列不留死链接，评审标记照样出现', () => {
    const meta = buildRunMeta(
      archiveRun({ id: 'run-empty' }),
      labels(),
      [],
      { status: 'succeeded' },
      '2026-11-10T08:09:00.000Z',
      ['prompt.md', 'review.md'],
    )
    const index = renderThreadIndex('th-1', [meta])
    const row = index.split('\n').find((line) => line.includes('run-empty')) as string
    expect(row).not.toContain('output.md)')
    expect(row).toContain('·review')

    // 一个 body 文件都没有：产出列为「-」
    const bare = renderThreadIndex('th-1', [
      buildRunMeta(
        archiveRun({ id: 'run-bare' }),
        labels(),
        [],
        { status: 'failed' },
        '2026-11-10T08:09:00.000Z',
        ['meta.json'],
      ),
    ])
    const bareRow = bare.split('\n').find((line) => line.includes('run-bare')) as string
    expect(bareRow).toContain('| - |')
  })

  it('标题里的竖线与换行不会破坏表格', () => {
    archiveRunTerminal(root, {
      run: archiveRun(),
      labels: labels({ taskTitle: 'A|B\nC' }),
      frames: [],
      receipt: receipt(),
      at: '2026-11-10T08:09:00.000Z',
    })
    const index = readFileSync(threadIndexPath(root, 'th-1'), 'utf8')
    expect(index).toContain('A\\|B C')
  })

  it('空线程也写一份索引（占位行），readRunMetas 对缺失目录返回空', () => {
    expect(readRunMetas(root, 'th-empty')).toEqual([])
    expect(writeThreadIndex(root, 'th-empty')).toBe(true)
    const index = readFileSync(threadIndexPath(root, 'th-empty'), 'utf8')
    expect(index).toContain('还没有终态 run')
    expect(renderThreadIndex('th-empty', [])).toContain('还没有终态 run')
  })

  it('坏 meta.json 跳过，不影响同目录其他 run 进索引', () => {
    writeRunMetaPlaceholder('run-bad')
    archiveRunTerminal(root, {
      run: archiveRun({ id: 'run-good' }),
      labels: labels(),
      frames: [],
      receipt: receipt(),
      at: '2026-11-10T08:09:00.000Z',
    })
    expect(readRunMetas(root, 'th-1').map((meta) => meta.runId)).toEqual(['run-good'])
    const index = readFileSync(threadIndexPath(root, 'th-1'), 'utf8')
    expect(index).toContain('run-good')
  })

  it('索引按开始时间排序：缺 startedAt 的行用 createdAt 兜底参与比较', () => {
    // 老归档里 startedAt 可能是 null（run 没真正跑起来就落了终态）：排序退回 createdAt
    const archive = (runId: string, startedAt: string | null, createdAt: string): void => {
      archiveRunTerminal(root, {
        run: archiveRun({ id: runId, startedAt, createdAt }),
        labels: labels(),
        frames: [],
        receipt: receipt(),
        at: '2026-11-10T12:00:00.000Z',
      })
    }
    archive('run-late', null, '2026-11-10T10:00:00.000Z')
    archive('run-later', null, '2026-11-10T11:00:00.000Z')
    archive('run-early', '2026-11-10T09:00:00.000Z', '2026-11-10T08:59:00.000Z')
    expect(readRunMetas(root, 'th-1').map((meta) => meta.runId)).toEqual([
      'run-early',
      'run-late',
      'run-later',
    ])
  })

  it('没有 meta.json 的目录不进索引', () => {
    mkdirSync(path.join(root, 'threads', 'th-1', 'runs', 'run-orphan'), { recursive: true })
    writeThreadIndex(root, 'th-1')
    expect(readRunMetas(root, 'th-1')).toEqual([])
  })
})

/** 坏 meta（内容不是 JSON 对象）：索引必须跳过它而不是整体失败。 */
function writeRunMetaPlaceholder(runId: string): void {
  const file = runMetaPath(root, 'th-1', runId)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'not json', 'utf8')
}

describe('host/artifacts 索引列格式（M16）', () => {
  const metaWith = (over: {
    id: string
    startedAt: string | null
    createdAt: string
    durationMs: number | null
  }): RunArchiveMeta =>
    buildRunMeta(
      archiveRun({
        id: over.id,
        startedAt: over.startedAt,
        createdAt: over.createdAt,
        durationMs: null,
      }),
      labels(),
      [],
      { status: 'succeeded', durationMs: over.durationMs ?? undefined },
      '2026-11-10T08:09:00.000Z',
      [],
    )

  it('时间缺失写「-」；用时按毫秒 / 秒 / 分秒三档渲染', () => {
    const index = renderThreadIndex('th-1', [
      metaWith({ id: 'run-a', startedAt: null, createdAt: '2026', durationMs: null }),
      metaWith({
        id: 'run-b',
        startedAt: '2026-11-10T08:07:00.000Z',
        createdAt: '2026-11-10T08:06:00.000Z',
        durationMs: 1234,
      }),
      metaWith({
        id: 'run-c',
        startedAt: '2026-11-10T09:07:00.000Z',
        createdAt: '2026-11-10T09:06:00.000Z',
        durationMs: 125_000,
      }),
      metaWith({
        id: 'run-d',
        startedAt: '2026-11-10T10:07:00.000Z',
        createdAt: '2026-11-10T10:06:00.000Z',
        durationMs: 7,
      }),
    ])
    expect(index).toContain('| 1 | - |')
    expect(index).toContain('11-10 08:07')
    expect(index).toContain('| 1.2s |')
    expect(index).toContain('| 2m05s |')
    expect(index).toContain('| 7ms |')
  })
})

describe('host/artifacts 历史 run 回填 output.md（M16）', () => {
  /** 造一个「只有流水、没有正文」的老 run 目录（M15 之前的归档形态）。 */
  const legacyRun = (
    runId: string,
    frames: string[],
    meta: Partial<RunArchiveMeta> = {},
  ): string => {
    const dir = path.join(root, 'threads', 'th-1', 'runs', runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'transcript.jsonl'), `${frames.join('\n')}\n`, 'utf8')
    writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        schemaVersion: RUN_ARCHIVE_SCHEMA_VERSION,
        runId,
        threadId: 'th-1',
        taskId: 'task-1',
        taskTitle: '协议导出加 HASH',
        stageId: 'stage-1',
        stageName: '实现',
        agentId: 'agent-1',
        agentName: 'coder',
        purpose: 'stage',
        turn: 1,
        status: 'succeeded',
        executorKey: 'dsh',
        createdAt: '2026-11-08T00:00:00.000Z',
        startedAt: '2026-11-08T00:00:00.000Z',
        endedAt: '2026-11-08T00:01:00.000Z',
        durationMs: 60_000,
        exitCode: 0,
        errorCode: null,
        error: null,
        sessionId: null,
        usage: null,
        frames: { total: frames.length, thinking: 0, text: 0, toolCall: 0, toolResult: 0 },
        files: ['prompt.md', 'transcript.jsonl'],
        ...meta,
      }),
      'utf8',
    )
    return dir
  }

  it('只有 text 帧进正文：thinking / 工具帧不混进去，分片按顺序拼接', () => {
    const dir = legacyRun('run-legacy', [
      '{"seq":1,"type":"thinking","text":"先想"}',
      '{"seq":2,"type":"text","text":"改好了"}',
      '{"seq":3,"type":"tool_call","tool":"grep","input":"x"}',
      '{"seq":4,"type":"tool_result","tool":"grep","output":"hit"}',
      '{"seq":5,"type":"text","text":"，测过"}',
    ])
    expect(backfillRunOutputs(root)).toBe(1)
    expect(readFileSync(path.join(dir, 'output.md'), 'utf8')).toBe('改好了，测过')
  })

  it('已有 output.md 一律不动（幂等，重复调用返回 0）', () => {
    const dir = legacyRun('run-legacy', ['{"seq":1,"type":"text","text":"流水果"}'])
    writeFileSync(path.join(dir, 'output.md'), '有人写过的正文', 'utf8')
    expect(backfillRunOutputs(root)).toBe(0)
    expect(readFileSync(path.join(dir, 'output.md'), 'utf8')).toBe('有人写过的正文')
  })

  it('没有 text 帧：有 error 写「# 错误」段，只有 errorCode 也写，两者都没有就跳过', () => {
    const failed = legacyRun('run-failed', ['{"seq":1,"type":"status","status":"failed"}'], {
      status: 'failed',
      error: '超时',
    })
    const coded = legacyRun('run-coded', [], { status: 'failed', errorCode: 'timeout' })
    const empty = legacyRun('run-empty', [])
    expect(backfillRunOutputs(root)).toBe(2)
    expect(readFileSync(path.join(failed, 'output.md'), 'utf8')).toBe('# 错误\n\n超时\n')
    expect(readFileSync(path.join(coded, 'output.md'), 'utf8')).toBe('# 错误\n\ntimeout\n')
    expect(existsSync(path.join(empty, 'output.md'))).toBe(false)
  })

  it('坏流水行只跳过那一行，不废掉整轮', () => {
    const dir = legacyRun('run-legacy', [
      'not json',
      '{"seq":1,"type":"text","text":"正文"}',
      '{"seq":2,"type":"text"',
    ])
    expect(backfillRunOutputs(root)).toBe(1)
    expect(readFileSync(path.join(dir, 'output.md'), 'utf8')).toBe('正文')
  })

  it('补写后重算 meta.files 并重建索引，链接写进表里', () => {
    const dir = legacyRun('run-legacy', ['{"seq":1,"type":"text","text":"正文"}'])
    writeFileSync(path.join(dir, 'prompt.md'), '提示词', 'utf8')
    writeFileSync(path.join(dir, 'review.md'), '评审', 'utf8')

    backfillRunOutputs(root)

    const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RunArchiveMeta
    expect(meta.files).toEqual(['prompt.md', 'transcript.jsonl', 'output.md', 'review.md'])
    const index = readFileSync(threadIndexPath(root, 'th-1'), 'utf8')
    expect(index).toContain('[`output.md`](runs/run-legacy/output.md)')
  })

  it('已下线的产物类型不再被索引列出（meta.files 与磁盘对齐）', () => {
    const dir = legacyRun('run-legacy', ['{"seq":1,"type":"text","text":"正文"}'], {
      files: ['prompt.md', 'thinking.md', 'transcript.jsonl'],
    })
    writeFileSync(path.join(dir, 'prompt.md'), '提示词', 'utf8')
    writeFileSync(path.join(dir, 'thinking.md'), '旧思考流', 'utf8')

    backfillRunOutputs(root)

    const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RunArchiveMeta
    expect(meta.files).toEqual(['prompt.md', 'transcript.jsonl', 'output.md'])
    const index = readFileSync(threadIndexPath(root, 'th-1'), 'utf8')
    expect(index).not.toContain('thinking.md')
  })

  it('根目录不存在 / 未配置：返回 0，不建目录也不抛错', () => {
    expect(backfillRunOutputs(undefined)).toBe(0)
    expect(backfillRunOutputs(path.join(root, 'nope'))).toBe(0)
    expect(existsSync(path.join(root, 'nope'))).toBe(false)
  })

  it('脏目录逐条跳过：缺 runs 子目录 / 缺 meta.json / 坏 meta / runId 不是字符串 / 缺流水', () => {
    const threads = path.join(root, 'threads')
    // ① 线程目录下没有 runs 子目录（老版本 / 手工清理过）
    mkdirSync(path.join(threads, 'th-no-runs'), { recursive: true })
    // ② run 目录里什么都没有：缺 meta.json、缺 transcript.jsonl、缺 output.md
    mkdirSync(path.join(threads, 'th-1', 'runs', 'run-bare'), { recursive: true })
    // ③ meta.json 不是 JSON
    const brokenDir = path.join(threads, 'th-1', 'runs', 'run-broken')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(path.join(brokenDir, 'meta.json'), 'not json', 'utf8')
    // ④ meta.json 是 JSON 但 runId 不是字符串（脏投影）
    const dirtyDir = path.join(threads, 'th-1', 'runs', 'run-dirty')
    mkdirSync(dirtyDir, { recursive: true })
    writeFileSync(path.join(dirtyDir, 'meta.json'), '{"runId":5}', 'utf8')

    // 一条也补不出来：没有流水就没有正文，没有 meta 就没有错误兜底
    expect(backfillRunOutputs(root)).toBe(0)
    for (const dir of [brokenDir, dirtyDir]) {
      expect(existsSync(path.join(dir, 'output.md'))).toBe(false)
    }
    // 坏 meta 不进索引，其余 run 目录也不产生行
    expect(readRunMetas(root, 'th-1')).toEqual([])
    expect(readFileSync(threadIndexPath(root, 'th-1'), 'utf8')).toContain('还没有终态 run')
  })

  it('索引口径自愈：磁盘上的旧格式 / 手工编辑过的 index.md 会被重建成当前渲染结果', () => {
    legacyRun('run-legacy', ['{"seq":1,"type":"text","text":"正文"}'])
    const indexFile = threadIndexPath(root, 'th-1')
    // 模拟改版前的旧表格：文件列还链着 transcript
    writeFileSync(
      indexFile,
      '| # | 时间 | 阶段 | 任务 | 轮次 | 状态 | 用时 | runId | 文件 |\n' +
        '| - | ---- | ---- | ---- | ---- | ---- | ---- | ----- | ---- |\n' +
        '| 1 | 11-08 00:00 | 实现 | x | 1 | succeeded | 1m00s | `run-legacy` | ' +
        '[`transcript.jsonl`](runs/run-legacy/transcript.jsonl) |\n',
      'utf8',
    )

    expect(backfillRunOutputs(root)).toBe(1)

    const index = readFileSync(indexFile, 'utf8')
    expect(index).toContain('| # | 时间 | 阶段 | 任务 | 轮次 | 状态 | 用时 | runId | 产出 |')
    expect(index).toContain('[`output.md`](runs/run-legacy/output.md)')
    expect(index).not.toContain('](runs/run-legacy/transcript.jsonl)')
    // 与当前渲染结果逐字一致（自愈后不会再被重写）
    expect(index).toBe(renderThreadIndex('th-1', readRunMetas(root, 'th-1')))

    // 索引被删：下次启动补回来（没有内容可比对时也要重建）
    rmSync(indexFile)
    expect(backfillRunOutputs(root)).toBe(0)
    expect(readFileSync(indexFile, 'utf8')).toBe(index)

    // 内容已经一致：重复启动不再改写（幂等）
    const before = statSync(indexFile).mtimeMs
    expect(backfillRunOutputs(root)).toBe(0)
    expect(statSync(indexFile).mtimeMs).toBe(before)
  })
})

describe('host/artifacts 提升为项目文档（writeProjectDoc）', () => {
  it('成功：递归建目录、原子写，返回目标绝对路径', () => {
    const dir = path.join(root, 'docs', 'reviews')
    const target = writeProjectDoc(dir, '报告.md', '# 评审\n')
    expect(target).toBe(path.join(dir, '报告.md'))
    expect(readFileSync(target, 'utf8')).toBe('# 评审\n')
    expect(existsSync(`${target}.tmp`)).toBe(false)
  })

  it('失败：清掉临时文件并把错误上抛（用户显式点的动作不能悄悄失败）', () => {
    const blocker = path.join(root, 'doc-blocker')
    writeFileSync(blocker, 'x', 'utf8')
    expect(() => writeProjectDoc(blocker, 'a.md', '正文')).toThrow()
    expect(existsSync(`${path.join(blocker, 'a.md')}.tmp`)).toBe(false)
    // 失败不留半截文件，目录也没被改成别的形态
    expect(readFileSync(blocker, 'utf8')).toBe('x')
  })
})
