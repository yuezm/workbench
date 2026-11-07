// @vitest-environment node
/**
 * `readRunApprovals` 的降级分支：定位到日志文件后、读取/解压阶段抛错时，审计缺失
 * 不该拖垮任务详情。这里通过局部 mock `node:fs` 让 `readFileSync` 抛错来触达 catch，
 * 其余 fs 能力（readdir/stat）保留真实实现，先正常定位到文件。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw new Error('read EIO')
    }),
  }
})

import { readRunApprovals } from '../../src/main/run-approvals'

describe('main/run-approvals · 读取失败降级', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('日志文件存在但读取抛错：返回空数组（降级，不抛）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wb-approvals-readerr-'))
    dirs.push(root)
    const dir = path.join(root, '--D-Codes-workbench--', 'sess-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'anything')

    expect(readRunApprovals(root, 'sess-1')).toEqual([])
  })
})
