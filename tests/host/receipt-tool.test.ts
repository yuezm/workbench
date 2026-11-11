// @vitest-environment node
/**
 * 回执工具 server 的定位与开关（M24，宿主侧）。
 *
 * 断言的核心是「默认等于不存在」：没开开关、或者脚本没跟着产物走，执行器拿到的就是
 * null → 注入空数组 → 行为与 M4 的纯文本通道逐字一致，不会因为打包漏文件把 CLI 起坏。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RECEIPT_TOOL_ENV_KEY,
  RECEIPT_TOOL_SERVER_ENV_KEY,
  resolveReceiptTool,
} from '../../src/host/receipt-tool'

const ENABLED = { [RECEIPT_TOOL_ENV_KEY]: '1' }

describe('resolveReceiptTool', () => {
  it('默认关：开关没开时，即便脚本就在那也不给', () => {
    expect(resolveReceiptTool({ env: {}, mainDir: '/app/out/main', exists: () => true })).toBeNull()
    expect(
      resolveReceiptTool({
        env: { [RECEIPT_TOOL_ENV_KEY]: 'true' },
        mainDir: '/app/out/main',
        exists: () => true,
      }),
    ).toBeNull()
  })

  it('开关开了但找不到脚本：null（打包漏文件时自动退回文本通道）', () => {
    expect(
      resolveReceiptTool({ env: ENABLED, mainDir: '/app/out/main', exists: () => false }),
    ).toBeNull()
  })

  it('开发态：脚本与主进程产物同级', () => {
    const tool = resolveReceiptTool({
      env: ENABLED,
      mainDir: '/app/out/main',
      exists: (path) => path === join('/app/out/main', 'receipt-mcp-server.cjs'),
      command: '/app/electron',
    })
    expect(tool).toEqual({
      command: '/app/electron',
      args: [join('/app/out/main', 'receipt-mcp-server.cjs')],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    })
  })

  it('打包态：回落到 resources/plugins 下', () => {
    const tool = resolveReceiptTool({
      env: ENABLED,
      mainDir: '/app/out/main',
      resourcesDir: '/app/resources',
      exists: (path) => path === join('/app/resources/plugins', 'receipt-mcp-server.cjs'),
      command: '/app/electron',
    })
    expect(tool?.args).toEqual([join('/app/resources/plugins', 'receipt-mcp-server.cjs')])
  })

  it('环境变量指定的路径优先于两个默认候选', () => {
    const tool = resolveReceiptTool({
      env: { ...ENABLED, [RECEIPT_TOOL_SERVER_ENV_KEY]: '/custom/server.cjs' },
      mainDir: '/app/out/main',
      resourcesDir: '/app/resources',
      exists: () => true,
      command: '/app/electron',
    })
    expect(tool?.args).toEqual(['/custom/server.cjs'])
  })
})
