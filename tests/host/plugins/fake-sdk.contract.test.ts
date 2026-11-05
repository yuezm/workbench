// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { fakeNet, fakeSdk } from '../../plugins/support/fake-sdk'

/**
 * 假能力面（tests/plugins/support/fake-sdk）的契约自检：默认 `net` 必须与宿主缺省兜底
 * 同一文案（`capability_unavailable: net`），避免来源/通道测试把「宿主没有网络原件」
 * 误当成可用能力；`fakeNet` 只覆盖显式注入的项。
 */

describe('fakeSdk 缺省 net', () => {
  it('fetch / listen 以 capability_unavailable 失败，verifyHmacSha256 抛同一错误', async () => {
    const sdk = fakeSdk()
    await expect(sdk.net.fetch('http://127.0.0.1:1/x')).rejects.toThrow(
      'capability_unavailable: net',
    )
    await expect(sdk.net.listen(0, async () => ({ status: 200 }))).rejects.toThrow(
      'capability_unavailable: net',
    )
    expect(() => sdk.net.verifyHmacSha256('secret', 'message', '0'.repeat(64))).toThrow(
      'capability_unavailable: net',
    )
  })

  it('fakeNet 只覆盖显式注入的项，其余仍不可用', async () => {
    const listen = vi.fn(async () => ({ port: 47_615, close: async () => undefined }))
    const net = fakeNet({ listen })
    await expect(net.listen(47_615, async () => ({ status: 200 }))).resolves.toMatchObject({
      port: 47_615,
    })
    await expect(net.fetch('http://127.0.0.1:1/x')).rejects.toThrow('capability_unavailable: net')
  })
})
