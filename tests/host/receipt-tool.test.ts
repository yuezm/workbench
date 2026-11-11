// @vitest-environment node
/**
 * 回执工具 server 的定位与开关（M24，宿主侧）。
 *
 * M26 起默认注入：脚本在就该有工具通道（`ask` 才能在一轮里发出来）。脚本没跟着产物走、
 * 或显式 `WORKBENCH_RECEIPT_TOOL=0` 时才退回纯文本通道——不会因为打包漏文件把 CLI 起坏。
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
  it('默认开：环境变量没写也注入（脚本在就给）', () => {
    const tool = resolveReceiptTool({
      env: {},
      mainDir: '/app/out/main',
      exists: () => true,
      command: '/app/electron',
    })
    expect(tool?.command).toBe('/app/electron')
    expect(tool?.args).toEqual([join('/app/out/main', 'receipt-mcp-server.cjs')])
  })

  it('显式 =0 才关：即便脚本就在那也不给', () => {
    expect(
      resolveReceiptTool({
        env: { [RECEIPT_TOOL_ENV_KEY]: '0' },
        mainDir: '/app/out/main',
        exists: () => true,
      }),
    ).toBeNull()
  })

  it('脚本找不到：null（打包漏文件时自动退回文本通道）', () => {
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

  it('没给 mainDir / command：只按环境变量找脚本，node 退回 process.execPath', () => {
    const tool = resolveReceiptTool({
      env: { ...ENABLED, [RECEIPT_TOOL_SERVER_ENV_KEY]: '/custom/server.cjs' },
      exists: () => true,
    })
    expect(tool?.args).toEqual(['/custom/server.cjs'])
    expect(tool?.command).toBe(process.execPath)
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
