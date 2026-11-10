import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Receipt } from '../../src/protocol/inputs'
import {
  reviewArtifactPath,
  withReviewArtifact,
  writeReviewArtifact,
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

  it('空正文也落盘（0 字节合法），sha256 是空串的摘要', () => {
    const artifact = writeReviewArtifact(root, 'th-1', 'run-9', '')
    expect(artifact?.bytes).toBe(0)
    expect(artifact?.sha256).toBe(createHash('sha256').update('', 'utf8').digest('hex'))
    mkdirSync(path.dirname(artifact?.path as string), { recursive: true })
  })
})
