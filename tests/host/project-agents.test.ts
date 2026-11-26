// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 写盘失败要用真实落盘失败来造吗？不必——`writeProjectDoc` 的失败形态（权限 / 磁盘满 /
 * 目标被占）在各平台上不一样，这里把它切成可注入的失败，只锁「失败不抛、返回诊断」。
 * 默认仍然走真实实现，其它用例照旧落到真文件上。
 */
const failRef = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('@workbench/host/artifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workbench/host/artifacts')>()
  return {
    ...actual,
    writeProjectDoc: (dir: string, fileName: string, text: string): string => {
      if (failRef.value !== null) throw failRef.value
      return actual.writeProjectDoc(dir, fileName, text)
    },
  }
})

const { AGENTS_FILE, agentsDocText, ensureProjectAgents } =
  await import('@workbench/host/project-agents')

const created: string[] = []

/** 每个用例一个独立临时目录：这条路径会真的写文件，串味会掩盖 bug。 */
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-agents-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  failRef.value = null
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('agentsDocText', () => {
  it('以项目名开头，并带「文档导航」标题', () => {
    const text = agentsDocText('登录服务')
    expect(text.startsWith('# 登录服务\n')).toBe(true)
    expect(text).toContain('## 文档导航（按需读取）')
  })

  it('分成「真相源」与「过程与产物」两组', () => {
    const text = agentsDocText('x')
    expect(text).toContain('真相源')
    expect(text).toContain('过程与产物')
    expect(text.indexOf('真相源')).toBeLessThan(text.indexOf('过程与产物'))
  })

  it('声明用户约定要用的落点（词汇 / 决策 / 规范 / 契约 / 过程记录）', () => {
    const text = agentsDocText('x')
    for (const item of [
      '`CONTEXT.md`',
      '`docs/adr/`',
      '`docs/knowledge/index.md`',
      '`docs/qa`',
      '`docs/milestones/`',
      '`docs/deploy/`',
      '`docs/prds/`',
      '`docs/research/`',
      '`docs/plans/`',
      '`docs/features/`',
      '`.scratch/`',
      '`docs/agents/`',
    ]) {
      expect(text).toContain(item)
    }
  })

  it('说明这段是生成物、可自行增删（否则人会以为是硬约束不敢改）', () => {
    const text = agentsDocText('x')
    expect(text).toContain('由 workbench')
    expect(text).toMatch(/增删|删掉/)
  })

  it('内容确定：两次调用逐字节相同，且以换行结尾', () => {
    const first = agentsDocText('x')
    expect(first).toBe(agentsDocText('x'))
    expect(first.endsWith('\n')).toBe(true)
  })
})

describe('ensureProjectAgents', () => {
  it('项目根没有 AGENTS.md 时写一份带默认导航的', () => {
    const dir = tmp()
    const result = ensureProjectAgents(dir, '登录服务')

    expect(result.created).toBe(true)
    expect(result.error).toBeNull()
    expect(result.path).toBe(join(dir, AGENTS_FILE))
    expect(readFileSync(result.path, 'utf8')).toBe(agentsDocText('登录服务'))
  })

  it('已有 AGENTS.md 时一个字都不改', () => {
    const dir = tmp()
    const target = join(dir, AGENTS_FILE)
    const mine = '# 我的项目\n\n本仓约定：文档都在 doc/ 下。\n'
    writeFileSync(target, mine, 'utf8')

    const result = ensureProjectAgents(dir, '登录服务')

    expect(result.created).toBe(false)
    expect(result.error).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe(mine)
  })

  it('项目目录不存在时不造目录，返回可读诊断', () => {
    const missing = join(tmp(), 'no-such-project')
    const result = ensureProjectAgents(missing, 'x')

    expect(result.created).toBe(false)
    expect(result.error).not.toBeNull()
    expect(existsSync(missing)).toBe(false)
  })

  it('同名路径是个目录时也返回诊断而不是抛', () => {
    const dir = tmp()
    mkdirSync(join(dir, AGENTS_FILE))

    const result = ensureProjectAgents(dir, 'x')

    expect(result.created).toBe(false)
    expect(result.error).not.toBeNull()
  })

  it('写盘失败：返回诊断而不是抛（项目创建不该因此失败）', () => {
    failRef.value = new Error('EACCES: permission denied')
    const dir = tmp()

    const result = ensureProjectAgents(dir, 'x')

    expect(result).toEqual({
      path: join(dir, AGENTS_FILE),
      created: false,
      error: 'EACCES: permission denied',
    })
  })

  it('写盘抛非 Error：文案走 String 兜底，仍然不抛', () => {
    failRef.value = '磁盘满了' as unknown as Error
    const dir = tmp()

    const result = ensureProjectAgents(dir, 'x')

    expect(result).toEqual({ path: join(dir, AGENTS_FILE), created: false, error: '磁盘满了' })
  })
})
