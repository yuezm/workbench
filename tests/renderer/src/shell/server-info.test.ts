import { describe, expect, it, beforeEach } from 'vitest'
import {
  getServerInfo,
  resetServerInfoForTest,
  setServerInfo,
  useServerInfo,
} from '@workbench/client-shell/server-info'

/** 服务信息 store：页面启动时写一次、所有组件读同一份 */
describe('shell/server-info', () => {
  const info = {
    name: 'workbench',
    version: '2.0.0',
    kernelVersion: 'M47.0.0',
    dataDir: '/data',
    defaultWorkdir: '/work',
    startedAt: 't',
    clients: 2,
    pid: 9,
  }

  beforeEach(() => {
    resetServerInfoForTest()
  })

  it('未写入时是 null；写入后可读回同一份', () => {
    expect(getServerInfo()).toBeNull()
    expect(typeof useServerInfo).toBe('function')
    setServerInfo(info)
    expect(getServerInfo()).toEqual(info)
  })

  it('重复写入以最后一次为准', () => {
    setServerInfo(info)
    setServerInfo({ ...info, version: '2.0.1' })
    expect(getServerInfo()?.version).toBe('2.0.1')
  })

  it('重置后回到 null（测试之间不互相带状态）', () => {
    setServerInfo(info)
    resetServerInfoForTest()
    expect(getServerInfo()).toBeNull()
  })
})
