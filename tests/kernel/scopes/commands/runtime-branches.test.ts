// @vitest-environment node
/**
 * 项目命令（`scopes/commands/runtime.ts`）的边缘臂：`description` 可省。
 *
 * 表单里不填说明是常态（老 UI / 模板导入都可能是空），落行必须给空串而不是 `undefined`
 * ——投影表的 `description` 列非空。
 */
import { describe, expect, it } from 'vitest'
import type { Input } from '@workbench/protocol/inputs'
import type { Project } from '@workbench/protocol/entities'
import { createProject } from '@workbench/kernel/scopes/commands/runtime'
import { TEST_AT, emptyView, testEnv } from '../../../support/kernel-view'

const create = (input: { name: string; path: string; description?: string }) =>
  createProject(
    emptyView(),
    { type: 'project.create', commandId: 'c-1', input } as unknown as Extract<
      Input,
      { type: 'project.create' }
    >,
    TEST_AT,
    testEnv(),
  )

describe('createProject：没填说明', () => {
  it('缺省 description 落空串（不是 undefined）', () => {
    const decision = create({ name: '工作台', path: 'D:/work' })
    expect(decision.reject).toBeUndefined()
    const created = decision.facts.find((fact) => fact.type === 'project.created')
    expect((created?.payload as { project: Project }).project).toEqual({
      id: 'project-next',
      name: '工作台',
      path: 'D:/work',
      description: '',
      createdAt: TEST_AT,
      updatedAt: TEST_AT,
    })
  })
})
