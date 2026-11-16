// @vitest-environment node
/**
 * 回执工具 server 的定位与开关（M24，宿主侧）。
 *
 * M26 起默认注入：脚本在就该有工具通道（`ask` 才能在一轮里发出来）。脚本没跟着产物走、
 * 或显式 `WORKBENCH_RECEIPT_TOOL=0` 时才退回纯文本通道——不会因为构建漏文件把 CLI 起坏。
 *
 * 服务器形态下子进程命令就是本机 node（`process.execPath`），不再有
 * `ELECTRON_RUN_AS_NODE` 这类桌面时代的开关。
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
      mainDir: '/app/out/server',
      exists: () => true,
      command: '/usr/bin/node',
    })
    expect(tool?.command).toBe('/usr/bin/node')
    expect(tool?.args).toEqual([join('/app/out/server', 'receipt-mcp-server.cjs')])
    expect(tool?.env).toEqual([])
  })

  it('显式 =0 才关：即便脚本就在那也不给', () => {
    expect(
      resolveReceiptTool({
        env: { [RECEIPT_TOOL_ENV_KEY]: '0' },
        mainDir: '/app/out/server',
        exists: () => true,
      }),
    ).toBeNull()
  })

  it('脚本找不到：null（构建漏文件时自动退回文本通道）', () => {
    expect(
      resolveReceiptTool({ env: ENABLED, mainDir: '/app/out/server', exists: () => false }),
    ).toBeNull()
  })

  it('产物目录：脚本与服务端入口同级', () => {
    const tool = resolveReceiptTool({
      env: ENABLED,
      mainDir: '/app/out/server',
      exists: (path) => path === join('/app/out/server', 'receipt-mcp-server.cjs'),
      command: '/usr/bin/node',
    })
    expect(tool).toEqual({
      command: '/usr/bin/node',
      args: [join('/app/out/server', 'receipt-mcp-server.cjs')],
      env: [],
    })
  })

  it('没给 mainDir / command：只按环境变量找脚本，命令退回 process.execPath', () => {
    const tool = resolveReceiptTool({
      env: { ...ENABLED, [RECEIPT_TOOL_SERVER_ENV_KEY]: '/custom/server.cjs' },
      exists: () => true,
    })
    expect(tool?.args).toEqual(['/custom/server.cjs'])
    expect(tool?.command).toBe(process.execPath)
  })

  it('环境变量指定的路径优先于默认候选', () => {
    const tool = resolveReceiptTool({
      env: { ...ENABLED, [RECEIPT_TOOL_SERVER_ENV_KEY]: '/custom/server.cjs' },
      mainDir: '/app/out/server',
      exists: () => true,
      command: '/usr/bin/node',
    })
    expect(tool?.args).toEqual(['/custom/server.cjs'])
  })
})
