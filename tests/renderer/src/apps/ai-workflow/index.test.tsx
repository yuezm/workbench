import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiWorkflowApp } from '@workbench/client-app-ai-workflow'
import { AiWorkflowPage } from '@workbench/client-app-ai-workflow/AiWorkflowPage'
import { installFakeKernel, stopFakeKernel } from '../../../shell/fake-kernel'

/**
 * ai-workflow 的注册入口（`src/index.tsx`）：shell 的 `registry.ts` 靠它把 app 挂进工作台。
 *
 * 这里只守注册契约——id 必须与目录 / 路由一致、名称与图标给得出、component 指向真组件且能渲染一次；
 * 业务行为在各组件自己的用例里。
 */
describe('ai-workflow 注册入口（index.tsx）', () => {
  beforeEach(() => {
    installFakeKernel()
  })

  afterEach(() => {
    stopFakeKernel()
  })

  it('AppPlugin 形状：id / 名称 / 图标 / 组件', () => {
    expect(aiWorkflowApp.id).toBe('ai-workflow')
    expect(aiWorkflowApp.name).toBe('AI 工作流')
    expect(aiWorkflowApp.component).toBe(AiWorkflowPage)
    expect(typeof aiWorkflowApp.icon).toBe('function')

    const { container, unmount } = render(<aiWorkflowApp.icon />)
    expect(container.querySelector('svg')).not.toBeNull()
    unmount()
  })

  it('组件可渲染：进到工作台能看到标题与空态（没有工作流时给指路）', () => {
    const { container } = render(<aiWorkflowApp.component />)
    expect(container.textContent).toContain('AI 工作流')
    expect(container.textContent).toContain('尚无工作流')
  })
})
