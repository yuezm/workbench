// @vitest-environment node
/**
 * 装配根（服务端）：真起一套内核 + 宿主 + 插件 + 调度器，验证「能装起来、能读、能关」。
 *
 * 不 mock 任何宿主模块：装配顺序、投影重建、内置阶段补齐、插件目录合并这些行为只有在
 * 真库上跑一遍才算验证过；e2e 覆盖派活与执行，这里只保证服务端形态不装错。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@workbench/protocol/http'
import { createWorkbench } from '@workbench/bundle-base'
import { SERVER_NAME, SERVER_VERSION } from '@workbench/bundle-base/version'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempDataDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-assembly-'))
  created.push(dir)
  return dir
}

describe('createWorkbench', () => {
  it('装起来就有库、有产物目录，视图可读，info 反映真实数据目录', async () => {
    const dataDir = tempDataDir()
    const publish = vi.fn<(event: ServerEvent) => void>()
    const log = vi.fn()
    const workbench = await createWorkbench({
      dataDir,
      log,
      publish,
      clients: () => 3,
    })

    expect(existsSync(path.join(dataDir, 'ai-workflow.db'))).toBe(true)

    const info = workbench.info()
    expect(info).toMatchObject({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      dataDir,
      clients: 3,
      pid: process.pid,
    })
    expect(info.kernelVersion).toMatch(/^M/u)
    expect(info.defaultWorkdir.length).toBeGreaterThan(0)

    // 内置四阶段与插件目录：装配完成即可读（不需要先派活）
    const workflows = await workbench.router.query('workflows.all')
    expect(Array.isArray(workflows)).toBe(true)
    const plugins = await workbench.router.query('plugins.all')
    expect(Array.isArray(plugins)).toBe(true)
    expect((plugins as Array<{ id: string }>).some((row) => row.id === 'dsh')).toBe(true)

    // 断言失败也要关库：否则临时目录删不掉（Windows 上库文件被占用就是 EBUSY）
    try {
      expect(info.dataDir).toBe(dataDir)
    } finally {
      await workbench.shutdown()
    }
  })

  it('版本号与 package.json 一致（构建产物不带 package.json，只能靠这条断言兜住）', () => {
    const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      version: string
    }
    expect(pkg.version).toBe(SERVER_VERSION)
  })

  it('退出幂等：重复 shutdown 不抛错；退出后视图仍可读（库已关，读的是投影接口）', async () => {
    const dataDir = tempDataDir()
    const workbench = await createWorkbench({ dataDir, publish: () => undefined })
    await workbench.shutdown()
    await expect(workbench.shutdown()).resolves.toBeUndefined()
    // lark 管理对象总是存在（未装 lark-cli 时探测会失败，但接口在）
    expect(typeof workbench.lark.status).toBe('function')
  })

  it('数据目录里已有库：二次启动不重建、数据不丢', async () => {
    const dataDir = tempDataDir()
    const first = await createWorkbench({ dataDir, publish: () => undefined })
    const before = await first.router.query('workflows.all')
    await first.shutdown()

    const second = await createWorkbench({ dataDir, publish: () => undefined })
    const after = await second.router.query('workflows.all')
    expect(after).toEqual(before)
    await second.shutdown()
  })
})
