// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createSdk } from '../../../../src/sdk'
import { detectDsh } from '../../../../src/plugins/executors/dsh/detect'
import { dshManifest } from '../../../../src/plugins/executors/dsh/manifest'
import type { SdkHost } from '../../../../src/sdk/types'

/**
 * dsh detect 的「候选清单缺席」回退（覆盖率补口）。
 *
 * 生产里候选清单来自 `plugins/shared/cli-catalog`；插件对清单只做一次查找，
 * 查不到时按命令名约定回退（`detect.ts` 的 `?? { command, label }`）。本文件整体替换
 * 清单来模拟「清单缺席」——这不改变插件行为，只验证它的独立可测性。
 */
vi.mock('../../../../src/plugins/shared/cli-catalog', () => ({
  CLI_CANDIDATES: [{ command: 'claude', label: 'Claude Code' }],
}))

/** 能力面：扫描目录与命中判定全部可控，不碰真实文件系统 */
const host = (): SdkHost => ({
  log: () => undefined,
  now: () => 0,
  paths: { sessionRoot: null },
  config: <T = Record<string, unknown>>() => ({}) as T,
  process: {
    spawn: () => {
      throw new Error('detect 不允许启动子进程')
    },
    resolve: (command) => ({ path: null, error: `detect 不解析命令：${command}` }),
    killTree: () => false,
    scanDirs: () => ['/bin'],
    findInDirs: (command) => (command === 'dsh' ? '/bin/dsh' : null),
  },
})

describe('dsh 插件 detect：候选清单缺席时按约定回退', () => {
  it('清单里没有 dsh：仍按命令名约定报出命中，展示名用内置回退', () => {
    const result = detectDsh({ sdk: createSdk(host(), dshManifest) })

    expect(result).toEqual([
      {
        command: 'dsh',
        label: 'DeepSeek Harness',
        path: '/bin/dsh',
        executorKey: '',
        supported: false,
      },
    ])
  })
})
