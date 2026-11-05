// @vitest-environment node
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES } from '../../src/protocol/manifest'
import { executorById, executors } from '../../src/plugins/registry'

/**
 * 执行器插件注册表契约（SPEC-plugins「Manifest / 测试 / 内置插件清单」）。
 *
 * 新增协议 = `src/plugins/executors/<id>/` + registry 一行；本文件守住两件事：
 * ① 清单本身合法（id/kind/version/capabilities/run）；
 * ② 目录与清单双向一致——漏注册（目录在、清单没有）和幽灵注册（清单有、目录没了）都失败。
 */

const EXECUTORS_ROOT = resolve(import.meta.dirname, '../../src/plugins/executors')

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe('执行器插件注册表', () => {
  it('注册表非空', () => {
    expect(executors.length).toBeGreaterThan(0)
  })

  it('每条注册项的 key 唯一、等于 manifest.id 且为 kebab-case', () => {
    const keys = executors.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of executors) {
      expect(entry.key).toMatch(KEBAB_CASE)
      expect(entry.key).toBe(entry.manifest.id)
      expect(entry.manifest.kind).toBe('executor')
    }
  })

  it('manifest 必填字段齐全、capabilities 在枚举内且不重复', () => {
    for (const entry of executors) {
      const { key, label, manifest, plugin } = entry
      expect(label, `${key} 的展示名为空`).toBeTruthy()
      expect(manifest.name, `${key} 的 manifest.name 为空`).toBeTruthy()
      expect(manifest.version, `${key} 的 manifest.version 为空`).toBeTruthy()
      expect(Array.isArray(manifest.capabilities)).toBe(true)
      expect(new Set(manifest.capabilities).size).toBe(manifest.capabilities.length)
      for (const capability of manifest.capabilities) {
        expect(CAPABILITIES, `${key} 声明了枚举外的能力「${capability}」`).toContain(capability)
      }
      expect(plugin.run, `${key} 缺少 run`).toBeTypeOf('function')
      for (const optional of ['probe', 'models', 'detect'] as const) {
        if (plugin[optional] !== undefined) {
          expect(plugin[optional], `${key} 的 ${optional} 不是函数`).toBeTypeOf('function')
        }
      }
    }
  })

  it('executorById 命中同一条注册项，未知 key 抛可读错误', () => {
    for (const entry of executors) {
      expect(executorById(entry.key)).toBe(entry)
    }
    expect(() => executorById('nope')).toThrow(/执行器插件未注册: nope/)
    expect(() => executorById('')).toThrow(/执行器插件未注册/)
  })

  it('src/plugins/executors/* 目录与注册表清单双向一致', () => {
    if (!existsSync(EXECUTORS_ROOT)) return

    const dirIds = readdirSync(EXECUTORS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const registeredIds = executors.map((entry) => entry.key).sort()

    expect(
      registeredIds,
      `执行器目录与注册表不一致：多出/缺少注册项（目录 [${dirIds.join(', ')}]，清单 [${registeredIds.join(', ')}]）`,
    ).toEqual(dirIds)

    for (const id of dirIds) {
      for (const file of ['manifest.ts', 'index.ts']) {
        expect(existsSync(join(EXECUTORS_ROOT, id, file)), `${id} 缺少 ${file}`).toBe(true)
      }
    }
  })
})
