import { describe, expect, it } from 'vitest'
import { apps } from '../../../../src/renderer/src/shell/registry'

describe('app 注册表', () => {
  it('注册表非空', () => {
    expect(apps.length).toBeGreaterThan(0)
  })

  it('每个 app 的 id 唯一且为 kebab-case', () => {
    const ids = apps.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('每个 app 具备全部必填字段', () => {
    for (const app of apps) {
      expect(app.id).toBeTruthy()
      expect(app.name).toBeTruthy()
      expect(app.icon).toBeTypeOf('function')
      expect(app.component).toBeTypeOf('function')
    }
  })
})
