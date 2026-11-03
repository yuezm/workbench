import { useState, type ReactElement } from 'react'
import type { PromptMode, RuntimeInput } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'

interface RuntimeDialogProps {
  /** 打开时的预填值（新建为空表单，检测结果「使用」带入名称与命令） */
  initial: RuntimeInput
  onSubmit: (input: RuntimeInput) => Promise<void>
  onCancel: () => void
}

function parseArgs(text: string): string[] {
  const t = text.trim()
  return t ? t.split(/\s+/) : []
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 新建运行时弹窗：点「新建运行时」或检测清单的「使用」后才出现 */
export function RuntimeDialog({ initial, onSubmit, onCancel }: RuntimeDialogProps): ReactElement {
  const [name, setName] = useState(initial.name)
  const [command, setCommand] = useState(initial.command)
  const [argsText, setArgsText] = useState((initial.args ?? []).join(' '))
  const [promptMode, setPromptMode] = useState<PromptMode>(initial.promptMode ?? 'arg')
  const [workdir, setWorkdir] = useState(initial.workdir ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSubmit({
        name,
        command,
        args: parseArgs(argsText),
        promptMode,
        workdir: workdir.trim() || null,
      })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="新建运行时" onClose={onCancel}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="名称">
            <Input aria-label="运行时名称" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="命令">
            <Input
              aria-label="运行时命令"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </Field>
          <Field label="prompt 传递">
            <Select
              ariaLabel="prompt 传递方式"
              value={promptMode}
              onChange={(v) => setPromptMode(v === 'stdin' ? 'stdin' : 'arg')}
              options={[
                { value: 'arg', label: '参数' },
                { value: 'stdin', label: '标准输入' },
              ]}
            />
          </Field>
          <Field label={`参数（空格分隔，可用 {'{prompt}'}）`} className="sm:col-span-2">
            <Input
              aria-label="运行时参数"
              className="font-mono"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
          </Field>
          <Field label="工作目录（可选）">
            <Input
              aria-label="运行时工作目录"
              className="font-mono"
              value={workdir}
              onChange={(e) => setWorkdir(e.target.value)}
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
          <Button type="submit" variant="primary" size="sm" disabled={saving}>
            添加运行时
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
