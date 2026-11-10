import { useState, type ReactElement } from 'react'
import type { AgentInput, Runtime } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { FormError } from '../../../components/ui/form-error'
import { Input } from '../../../components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 把焦点移到出错的控件：下拉触发器（Radix Select）没转发 ref，统一按 aria-label 从表单里找，
 * 输入框与下拉共用一条路径。
 */
function focusControl(form: HTMLFormElement, label: string): void {
  form.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus()
}

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
 *
 * 校验：名称必填（保存时 trim），提交被拒时错误挂在对应字段上（`role="alert"`），
 * 并把焦点移到第一个出错的控件；父级 reject 的文案留在弹窗底部，输入不丢。
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
  const [nameError, setNameError] = useState<string | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const usable = runtimes.filter((r) => runtimeHealth(r) !== 'unavailable')
  // 编辑时允许保留已不可用的原运行时：否则保存会把它悄悄改绑到别的运行时
  const kept = runtimes.find(
    (r) => r.id === selected && (mode === 'edit' || runtimeHealth(r) !== 'unavailable'),
  )
  const runtimeId = kept?.id ?? usable[0]?.id ?? ''
  const unavailable = runtimes.filter((r) => runtimeHealth(r) === 'unavailable')

  /**
   * 下拉选项：没有运行时时给一个空值项「无」（迁移前就是这条空值项把触发器写成「无」）。
   * Radix 在 `value === ''` 时显示 `SelectValue` 的 placeholder，所以 placeholder 与这条
   * 空值项的文案对齐即可保持观感；有运行时但全都不可用时没有空值项，placeholder 回到
   * 迁移前的「请选择」。
   */
  const runtimeOptions =
    runtimes.length === 0
      ? [{ value: '', label: '无', disabled: false }]
      : runtimes.map((r) => ({
          value: r.id,
          label: `${r.name} · ${RUNTIME_HEALTH_LABEL[runtimeHealth(r)]}`,
          disabled: runtimeHealth(r) === 'unavailable',
        }))

  /** 按钮禁用必须伴随可见原因：点不动又不说为什么，和静默 return 是同一个毛病 */
  const disabledHint =
    runtimeId === '' ? '缺少可绑定的运行时：先到「运行时」新建并测试通过再回来。' : null

  const submit = async (ev: React.FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault()
    setError(null)
    setNameError(null)
    setRuntimeError(null)

    // 必填校验放在前端：空值不再静默 return，也不靠内核 reject 兜底
    const trimmedName = name.trim()
    if (trimmedName === '') {
      setNameError('名称必填')
      focusControl(ev.currentTarget, '智能体名称')
      return
    }
    if (runtimeId === '') {
      setRuntimeError('没有可绑定的运行时：先到「运行时」新建并测试通过。')
      focusControl(ev.currentTarget, '智能体运行时')
      return
    }

    setSaving(true)
    try {
      await onSubmit({
        name: trimmedName,
        description: description.trim(),
        runtimeId,
        systemPrompt: systemPrompt.trim(),
      })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      {/*
        必须有高度上限：System Prompt 能写几千字，`field-sizing-content` 的 textarea 会把
        弹窗撑到比视口还高，而 DialogContent 是 fixed + translate 居中（SPEC-ui §4「Dialog 的
        尺寸」），超出的上下两端会被裁到屏幕外，保存按钮点不到。改为头部 / 底部固定、
        字段区自己滚动的列布局。
      */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{mode === 'edit' ? '编辑智能体' : '新建智能体'}</DialogTitle>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-4" noValidate onSubmit={submit}>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {runtimes.length === 0 && (
              <div className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
                先添加运行时。
              </div>
            )}

            {runtimes.length > 0 && usable.length === 0 && (
              <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                没有可用运行时，先到「运行时」测试通过。
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="名称" required hint="保存时去掉首尾空格" error={nameError}>
                <Input
                  aria-label="智能体名称"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setNameError(null)
                  }}
                />
              </Field>
              <Field label="绑定运行时" required error={runtimeError}>
                <Select
                  value={runtimeId}
                  onValueChange={(next) => {
                    setSelected(next)
                    setRuntimeError(null)
                  }}
                >
                  <SelectTrigger aria-label="智能体运行时" className="w-full">
                    <SelectValue placeholder={runtimes.length === 0 ? '无' : '请选择'} />
                  </SelectTrigger>
                  <SelectContent>
                    {runtimeOptions.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {unavailable.length > 0 && (
                <p className="col-span-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-sm text-destructive">
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
                <Textarea
                  aria-label="智能体能力"
                  // 上限压住自动增高：几千字的提示词也只占这么高，框内自己滚，不把弹窗顶大
                  className="max-h-56 min-h-24 resize-y font-mono text-sm"
                  rows={6}
                  placeholder="写清这个智能体的角色、做事方式与产出要求；每轮运行都会带上这段。"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                />
              </Field>
            </div>
          </div>

          <FormError message={error} onDismiss={() => setError(null)} />

          <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-3">
            {disabledHint !== null && (
              <p className="text-xs text-faint-foreground">{disabledHint}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                取消
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                disabled={saving || runtimeId === ''}
              >
                {mode === 'edit' ? '保存' : '添加'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
