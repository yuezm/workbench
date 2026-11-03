import { useState, type ReactElement } from 'react'
import type { AgentInput, Runtime } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface AgentDialogProps {
  /** 可绑定的运行时；为空时不允许创建 */
  runtimes: Runtime[]
  /** 打开时的预填值 */
  initial: AgentInput
  onSubmit: (input: AgentInput) => Promise<void>
  onCancel: () => void
}

/** 新建智能体弹窗：点「新建智能体」后才出现 */
export function AgentDialog({
  runtimes,
  initial,
  onSubmit,
  onCancel,
}: AgentDialogProps): ReactElement {
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description ?? '')
  const [selected, setSelected] = useState<string | null>(initial.runtimeId || null)
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 运行时列表变化时，选中项失效则回落到第一个可用运行时；列表为空则清空
  const runtimeId =
    selected && runtimes.some((r) => r.id === selected) ? selected : (runtimes[0]?.id ?? '')

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSubmit({ name, description, runtimeId, systemPrompt })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="新建智能体" onClose={onCancel}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {runtimes.length === 0 && (
          <div className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
            <p>请先在上方添加一个运行时。</p>
            <p className="mt-1 text-ink-dim">（切到顶部的「运行时配置」页新建）</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="名称">
            <Input aria-label="智能体名称" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="绑定运行时">
            <Select
              ariaLabel="智能体运行时"
              value={runtimeId}
              onChange={setSelected}
              options={
                runtimes.length === 0
                  ? [{ value: '', label: '（无）' }]
                  : runtimes.map((r) => ({ value: r.id, label: r.name }))
              }
            />
          </Field>
          <Field label="描述" className="col-span-2">
            <Input
              aria-label="智能体描述"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="能力（System Prompt）" className="col-span-2">
            <Input
              aria-label="智能体能力"
              className="font-mono"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </Field>
        </div>

        {error && (
          <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={saving || !runtimeId}>
            添加智能体
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
