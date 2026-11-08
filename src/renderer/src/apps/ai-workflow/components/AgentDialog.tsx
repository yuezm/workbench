import { useState, type ReactElement } from 'react'
import type { AgentInput, Runtime } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { fieldCls, Input } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** System Prompt 是多行文本：等宽、可纵向拉伸，方便写分段指令 */
const promptCls = cn(fieldCls, 'min-h-24 resize-y py-2 text-body font-mono')

/** 运行时健康：从未探测也算可用（不拦截未检测的运行时） */
export type RuntimeHealth = 'ready' | 'unavailable' | 'unknown'

export const RUNTIME_HEALTH_LABEL: Record<RuntimeHealth, string> = {
  ready: '可用',
  unavailable: '不可用',
  unknown: '未检测',
}

/** 从最近一次探测结论推导健康状态（供下拉与清单状态点共用） */
export function runtimeHealth(runtime: Runtime): RuntimeHealth {
  if (runtime.lastProbe === null) return 'unknown'
  return runtime.lastProbe.state
}

export interface AgentDialogProps {
  /** 可绑定的运行时；为空时不允许创建 */
  runtimes: Runtime[]
  /** 打开时的预填值 */
  initial: AgentInput
  /** 新建或编辑：影响标题/按钮文案，编辑时保留原绑定（含不可用运行时）不被清空 */
  mode?: 'create' | 'edit'
  onSubmit: (input: AgentInput) => Promise<void>
  onCancel: () => void
}

/**
 * 新建 / 编辑智能体弹窗。
 *
 * 运行时下拉直接带出健康状态；不可用的运行时禁用并汇总提示，
 * 默认选中第一个可用（未检测可选中）运行时，避免把智能体绑到已知失效的运行时。
 * 编辑模式下保留当前绑定，即使该运行时已不可用，也不替换成其它运行时。
 */
export function AgentDialog({
  runtimes,
  initial,
  mode = 'create',
  onSubmit,
  onCancel,
}: AgentDialogProps): ReactElement {
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description ?? '')
  const [selected, setSelected] = useState<string | null>(initial.runtimeId || null)
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const usable = runtimes.filter((r) => runtimeHealth(r) !== 'unavailable')
  // 编辑时允许保留已不可用的原运行时：否则保存会把它悄悄改绑到别的运行时
  const kept = runtimes.find(
    (r) => r.id === selected && (mode === 'edit' || runtimeHealth(r) !== 'unavailable'),
  )
  const runtimeId = kept?.id ?? usable[0]?.id ?? ''
  const unavailable = runtimes.filter((r) => runtimeHealth(r) === 'unavailable')

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
    <Dialog title={mode === 'edit' ? '编辑智能体' : '新建智能体'} onClose={onCancel}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {runtimes.length === 0 && (
          <div className="rounded-lg border border-dashed border-line px-3 py-2 text-body text-ink-faint">
            先添加运行时。
          </div>
        )}

        {runtimes.length > 0 && usable.length === 0 && (
          <p className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-body text-amber-200">
            没有可用运行时，先到「运行时」测试通过。
          </p>
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
                  ? [{ value: '', label: '无' }]
                  : runtimes.map((r) => ({
                      value: r.id,
                      label: `${r.name} · ${RUNTIME_HEALTH_LABEL[runtimeHealth(r)]}`,
                      disabled: runtimeHealth(r) === 'unavailable',
                    }))
              }
            />
          </Field>

          {unavailable.length > 0 && (
            <p className="col-span-2 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-2.5 py-1.5 text-body text-red-300">
              不可用：{unavailable.map((r) => r.name).join('、')}
            </p>
          )}

          <Field label="描述" className="col-span-2">
            <Input
              aria-label="智能体描述"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="System Prompt" className="col-span-2">
            <textarea
              aria-label="智能体能力"
              className={promptCls}
              rows={6}
              placeholder="写清这个智能体的角色、做事方式与产出要求；每轮运行都会带上这段。"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </Field>
        </div>

        {error && (
          <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-body text-red-300">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={saving || !runtimeId}>
            {mode === 'edit' ? '保存' : '添加'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
