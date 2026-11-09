import { describe, expect, it } from 'vitest'
import { appPlugins } from '../../../../src/renderer/src/shell/registry'
import { APP_EVENTS } from '../../../../src/shared/apps'

describe('app 注册表', () => {
  it('注册表非空', () => {
    expect(appPlugins.length).toBeGreaterThan(0)
  })

  it('每个 app 的 id 唯一且为 kebab-case', () => {
    const ids = appPlugins.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('每个 app 具备全部必填字段', () => {
    for (const app of appPlugins) {
      expect(app.id).toBeTruthy()
      expect(app.name).toBeTruthy()
      expect(app.icon).toBeTypeOf('function')
      expect(app.component).toBeTypeOf('function')
    }
  })

  it('每个 app 声明的事件都在 APP_EVENTS 的白名单内', () => {
    for (const app of appPlugins) {
      const declared = APP_EVENTS.find((entry) => entry.id === app.id)?.events ?? []
      for (const eventType of app.events ?? []) {
        expect(declared).toContain(eventType)
      }
    }
  })

  it('APP_EVENTS 的每个 id 都注册在 appPlugins 里', () => {
    const ids = new Set(appPlugins.map((app) => app.id))
    for (const entry of APP_EVENTS) {
      expect(ids.has(entry.id)).toBe(true)
    }
  })

  it('顺序即导航顺序：AI 工作流排在番茄时钟前面', () => {
    expect(appPlugins.map((a) => a.id)).toEqual(['ai-workflow', 'pomodoro'])
  })

  it('第一个注册的 app 是默认打开的 app（外壳取 apps[0]）', () => {
    expect(appPlugins[0]?.id).toBe('ai-workflow')
  })
})
