import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, WorkflowWithStages } from '../../../../../shared/ai-workflow-api'
import { WorkflowEditor } from './WorkflowEditor'

const agent: Agent = {
  id: 'ag1',
  name: 'coder',
  description: '',
  runtimeId: 'r1',
  systemPrompt: '',
  createdAt: 't',
}

describe('WorkflowEditor', () => {
  it('新建：填名称、改阶段、加/删阶段、设目标并保存', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} agents={[agent]} onSave={onSave} onCancel={onCancel} />)

    await user.type(screen.getByLabelText('工作流名称'), '研发')
    await user.type(screen.getByLabelText('工作流描述'), 'desc')
    await user.clear(screen.getByLabelText('阶段1名称'))
    await user.type(screen.getByLabelText('阶段1名称'), '待办')

    await user.selectOptions(screen.getByLabelText('阶段1进入方式'), 'agent')
    await user.selectOptions(screen.getByLabelText('阶段1智能体'), '')
    await user.selectOptions(screen.getByLabelText('阶段1智能体'), 'ag1')

    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    await user.selectOptions(screen.getByLabelText('阶段2完成后进入'), '0')
    await user.selectOptions(screen.getByLabelText('阶段2完成后进入'), '')
    await user.selectOptions(screen.getByLabelText('阶段2完成后进入'), '0')
    await user.selectOptions(screen.getByLabelText('阶段2打回退回到'), '0')
    await user.selectOptions(screen.getByLabelText('阶段2打回退回到'), '')
    await user.selectOptions(screen.getByLabelText('阶段2打回退回到'), '0')

    // 再加一个阶段后删除，覆盖删除分支
    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    await user.click(screen.getAllByRole('button', { name: '删除阶段' })[2])

    await user.click(screen.getByRole('button', { name: '保存工作流' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0]
    expect(draft.name).toBe('研发')
    expect(draft.stages).toHaveLength(2)
    expect(draft.stages[0]).toMatchObject({ name: '待办', entryMode: 'agent', agentId: 'ag1' })
    expect(draft.stages[1]).toMatchObject({ onCompleteIndex: 0, onRejectIndex: 0 })

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('编辑已有工作流：把阶段 id 还原成下标', () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '旧流',
      description: 'd',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w',
          name: '待办',
          position: 0,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: 's1',
          onRejectStageId: null,
        },
        {
          id: 's1',
          workflowId: 'w',
          name: '进行中',
          position: 1,
          entryMode: 'user',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: 's0',
        },
      ],
    }
    render(<WorkflowEditor workflow={existing} agents={[]} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('工作流名称')).toHaveValue('旧流')
    expect(screen.getByLabelText('阶段1完成后进入')).toHaveValue('1')
    expect(screen.getByLabelText('阶段2打回退回到')).toHaveValue('0')
  })

  it('工作流没有描述时描述输入框留空', () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '无描述',
      description: undefined as unknown as string,
      createdAt: 't',
      stages: [],
    }
    render(<WorkflowEditor workflow={existing} agents={[]} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('工作流描述')).toHaveValue('')
  })
})
