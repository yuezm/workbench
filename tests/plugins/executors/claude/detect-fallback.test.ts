// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { detectClaude } from '../../../../src/plugins/executors/claude/detect'
import { fakeSdk } from '../../support/fake-sdk'

/**
 * claude detect 的「候选清单缺席」回退（覆盖率补口）。
 *
 * 生产里候选清单来自 `plugins/shared/cli-catalog`，其中一定有 claude；插件对清单只做一次
 * 查找，查不到时按命令名约定回退（`detect.ts` 的 `?? { command, label }`）。本文件整体
 * 替换清单来模拟「清单缺席」——不改变插件行为，只验证它的独立可测性。
 */
vi.mock('../../../../src/plugins/shared/cli-catalog', () => ({
  CLI_CANDIDATES: [{ command: 'dsh', label: 'DeepSeek Harness' }],
}))

describe('claude 插件 detect：候选清单缺席时按约定回退', () => {
  it('清单里没有 claude：仍按命令名约定报出命中，展示名用内置回退', () => {
    const sdk = fakeSdk({
      scanDirs: () => ['C:/bin'],
      findInDirs: (command) => (command === 'claude' ? 'C:/bin/claude.cmd' : null),
    })

    expect(detectClaude({ sdk })).toEqual([
      {
        command: 'claude',
        label: 'Claude Code',
        path: 'C:/bin/claude.cmd',
        executorKey: '',
        supported: false,
      },
    ])
  })

  it('清单缺席且本机没有该命令：仍然返回空数组', () => {
    expect(detectClaude({ sdk: fakeSdk() })).toEqual([])
  })
})
