// @vitest-environment node
/**
 * 目录浏览（Web 端的项目文件夹选择）：只列目录、跳过不可读子项、错误给可读文案。
 *
 * 注入 `readdir` / `isDirectory`，因此不依赖真实盘；另有一组真 fs 用例验证
 * 「隐藏目录不出现、排序稳定、parent 到根为 null」。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowseError, expandHome, listDirectories, listRoots } from '@workbench/api-http/fs-browse'

const HOME = path.resolve(path.join(path.sep, 'home', 'me'))
const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fake = (opts: {
  dirs: string[]
  isDirectory?: (dir: string) => boolean
  throwOn?: 'readdir' | 'stat'
}) => ({
  home: HOME,
  isDirectory: () => {
    if (opts.throwOn === 'stat') throw Object.assign(new Error('nope'), { code: 'EACCES' })
    return true
  },
  readdir: () => {
    if (opts.throwOn === 'readdir') throw Object.assign(new Error('nope'), { code: 'EACCES' })
    return opts.dirs.map((name) => ({ name, isDirectory: () => true }))
  },
})

describe('expandHome', () => {
  it('展开 ~ 与 ~/x，其余原样', () => {
    expect(expandHome('~', HOME)).toBe(HOME)
    expect(expandHome('~/work', HOME)).toBe(path.join(HOME, 'work'))
    expect(expandHome('/abs', HOME)).toBe('/abs')
  })
})

describe('listRoots', () => {
  it('Windows 只列存在的盘符（不存在的 A:/B: 不出现）', () => {
    const roots = listRoots({
      platform: 'win32',
      exists: (target) => target === 'C:\\' || target === 'D:\\',
    })
    expect(roots).toEqual(['C:\\', 'D:\\'])
  })

  it('POSIX 的根只有 /', () => {
    expect(listRoots({ platform: 'linux' })).toEqual(['/'])
  })
})

describe('listDirectories（注入）', () => {
  it('空路径落在主目录；相对路径按主目录解析', () => {
    expect(listDirectories(undefined, fake({ dirs: [] })).path).toBe(HOME)
    expect(listDirectories('~/work', fake({ dirs: [] })).path).toBe(path.join(HOME, 'work'))
  })

  it('只回目录、跳过隐藏项，并按名称（大小写不敏感）排序', () => {
    const listing = listDirectories(HOME, fake({ dirs: ['zeta', 'Alpha', '.hidden', 'beta'] }))
    expect(listing.entries.map((entry) => entry.name)).toEqual(['Alpha', 'beta', 'zeta'])
    expect(listing.parent).toBe(path.dirname(HOME))
  })

  it('结果里带上可跳转的根（盘根没有上一级，跨盘靠它）', () => {
    const listing = listDirectories(HOME, { ...fake({ dirs: [] }), roots: () => ['C:\\', 'D:\\'] })
    expect(listing.roots).toEqual(['C:\\', 'D:\\'])
  })

  it('isDirectory 抛错的子项跳过（坏软链不该让整个目录不可选）', () => {
    const dirs = ['ok', 'broken']
    const listing = listDirectories(HOME, {
      home: HOME,
      isDirectory: () => true,
      readdir: () =>
        dirs.map((name) => ({
          name,
          isDirectory: () => {
            if (name === 'broken') throw new Error('ELOOP')
            return true
          },
        })),
    })
    expect(listing.entries.map((entry) => entry.name)).toEqual(['ok'])
  })

  it('不是目录 / 无权限 / 读不出来都给可读错误', () => {
    expect(() =>
      listDirectories(HOME, { home: HOME, isDirectory: () => false, readdir: () => [] }),
    ).toThrow(/不是目录/u)
    expect(() => listDirectories(HOME, fake({ dirs: [], throwOn: 'stat' }))).toThrow(/没有权限/u)
    expect(() => listDirectories(HOME, fake({ dirs: [], throwOn: 'readdir' }))).toThrow(BrowseError)
  })

  it('目录不存在：错误说清哪个路径', () => {
    expect(() =>
      listDirectories('/missing', {
        home: HOME,
        isDirectory: () => {
          throw Object.assign(new Error('nope'), { code: 'ENOENT' })
        },
        readdir: () => [],
      }),
    ).toThrow(`目录不存在：${path.resolve('/missing')}`)
  })

  it('其它 errno：归到「无法读取」而不是把 errno 丢给浏览器', () => {
    expect(() =>
      listDirectories('/x', {
        home: HOME,
        isDirectory: () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' })
        },
        readdir: () => [],
      }),
    ).toThrow(/无法读取目录/u)
  })
})

describe('listDirectories（真 fs）', () => {
  it('根目录 parent 为 null；隐藏目录不出现；文件不出现', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wb-browse-'))
    created.push(dir)
    mkdirSync(path.join(dir, '项目A'))
    mkdirSync(path.join(dir, '.git'))
    writeFileSync(path.join(dir, 'readme.md'), 'x')

    const listing = listDirectories(dir)
    expect(listing.path).toBe(dir)
    expect(listing.entries.map((entry) => entry.name)).toEqual(['项目A'])

    const rootListing = listDirectories(path.parse(dir).root)
    expect(rootListing.parent).toBeNull()
  })

  it('真的不存在时抛 BrowseError', () => {
    expect(() => listDirectories(path.join(tmpdir(), 'wb-not-exist-xyz'))).toThrow(BrowseError)
  })
})
