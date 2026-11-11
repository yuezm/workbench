// @vitest-environment node
/**
 * 回执工具通道的注入形状（M24，纯函数）：这里只管「拼成 ACP / dsh 要的那一段」，
 * 开关与脚本定位在宿主侧（`host/receipt-tool.ts`）。
 */
import { describe, expect, it } from 'vitest'
import {
  acpReceiptServer,
  dshReceiptMcpServers,
  dshReceiptServer,
  receiptMcpServers,
} from '../../../src/plugins/shared/receipt-mcp-config'
import type { SdkReceiptTool } from '../../../src/sdk/types'

const TOOL: SdkReceiptTool = {
  command: '/electron',
  args: ['/fake/server.cjs'],
  env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
}

describe('注入形状', () => {
  it('ACP：type=stdio、名字 workbench、命令与 env 原样带上', () => {
    expect(acpReceiptServer(TOOL)).toEqual({
      type: 'stdio',
      name: 'workbench',
      command: '/electron',
      args: ['/fake/server.cjs'],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    })
  })

  it('dsh：transport + env 对象（真机实测形状，写错整帧被拒）', () => {
    expect(dshReceiptServer(TOOL)).toEqual({
      transport: 'stdio',
      name: 'workbench',
      command: '/electron',
      args: ['/fake/server.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('宿主没给（开关关 / 脚本缺失）：空数组，保持纯文本通道', () => {
    expect(receiptMcpServers(null)).toEqual([])
    expect(receiptMcpServers(undefined)).toEqual([])
  })

  it('宿主给了：ACP 一条、dsh 一条（两种形状各走各的）', () => {
    expect(receiptMcpServers(TOOL)).toEqual([acpReceiptServer(TOOL)])
    expect(dshReceiptMcpServers(TOOL)).toEqual([dshReceiptServer(TOOL)])
    expect(dshReceiptMcpServers(null)).toEqual([])
  })
})
