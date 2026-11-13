import { useEffect, useState, type ReactElement } from 'react'
import type { Runtime, RuntimeExecutorChoice, RuntimeInput } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { FormError } from '../../../components/ui/form-error'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import { getKernelStore } from '../../../shell/kernelStore'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 焦点定位：下拉没转发 ref，统一按 aria-label 从表单里取控件 */
function focusControl(form: HTMLFormElement, label: string): void {
  form.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus()
}

const ARGS_TEMPLATE_HINT = 'JSON 数组，占位符 {model}/{effort}/{cwd}/{context}/{prompt}'

export interface RuntimeDialogProps {
  /** 编辑目标；不传 = 新建 */
  runtime?: Runtime | null
  /** 新建预填（检测清单「使用」带入名称与命令） */
  initial?: RuntimeInput | null
  onSubmit: (input: RuntimeInput) => Promise<void>
  onCancel: () => void
}

/**
 * 新建 / 编辑运行时共用的弹窗。
 *
 * 运行时只描述**连接**：用哪个执行器协议、把哪个命令怎么起来。模型、思考强度、
 * 并发、访问权限、工作目录、环境变量都在智能体上配（见 `AgentDialog`），这里不出现。
 */
export function RuntimeDialog({
  runtime = null,
  initial = null,
  onSubmit,
  onCancel,
}: RuntimeDialogProps): ReactElement {
  const editing = runtime !== null

  const [name, setName] = useState(initial?.name ?? runtime?.name ?? '')
  const [executorKey, setExecutorKey] = useState(initial?.executorKey ?? runtime?.executorKey ?? '')
  const [command, setCommand] = useState(initial?.command ?? runtime?.command ?? '')
  const [profile, setProfile] = useState(initial?.profile ?? runtime?.profile ?? '')
  const [argsTemplate, setArgsTemplate] = useState(
    initial?.argsTemplate ?? runtime?.argsTemplate ?? '',
  )
  const [enabled, setEnabled] = useState(runtime?.enabled ?? true)
  const [executors, setExecutors] = useState<RuntimeExecutorChoice[]>([])
  const [executorsLoading, setExecutorsLoading] = useState(true)
  const [executorsError, setExecutorsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 执行器清单来自宿主视图 `runtimes.executors`（注册表顺序）；表单不写死任何执行器名。
  // 新建时用首项 manifest 的 command/profile 预填，编辑时保留运行时现有值不覆盖。
  useEffect(() => {
    let alive = true
    void getKernelStore()
      .query('runtimes.executors')
      .then((list) => {
        if (!alive) return
        // 宿主视图正常返回数组；桩 / 读失败时按空清单处理（下拉禁用并提示）
        setExecutors(list ?? [])
        const first = (list ?? [])[0]
        if (first === undefined) return
        setExecutorKey((prev) => (prev === '' ? first.key : prev))
        if (editing) return
        // 只在字段仍为空时预填：检测清单「使用」带入的用户值优先，用户已输入的值也不覆盖
        setCommand((prev) => (prev.trim() === '' ? first.command : prev))
        setProfile((prev) => (prev.trim() === '' ? first.profile : prev))
      })
      .catch((e: unknown) => {
        if (alive) setExecutorsError(errMsg(e))
      })
      .finally(() => {
        if (alive) setExecutorsLoading(false)
      })
    return () => {
      alive = false
    }
  }, [editing])

  const changeExecutor = (key: string): void => {
    setExecutorKey(key)
    // 新建时切执行器才预填该执行器 manifest 的默认命令/profile；编辑时不动用户的现有配置
    if (editing) return
    // Select 的选项来自 executors：能选到的 key 一定在清单里（找不到说明 UI 状态不一致）
    const choice = executors.find((item) => item.key === key) as RuntimeExecutorChoice
    setCommand(choice.command)
    setProfile(choice.profile)
  }

  const submit = async (ev: React.FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault()
    setError(null)
    setNameError(null)
    setCommandError(null)

    // 必填校验放在前端：空名不再交给内核 reject
    if (name.trim() === '') {
      setNameError('名称必填')
      focusControl(ev.currentTarget, '运行时名称')
      return
    }

    // `command` 执行器没有 manifest 默认命令：空命令的探测必失败（命令必填），
    // 先在这里说清，别让用户去读一句「探测失败：命令必填：…」
    if (command.trim() === '') {
      setCommandError('命令必填：填命令名或绝对路径（如 pnpm）')
      focusControl(ev.currentTarget, '运行时命令')
      return
    }

    setSaving(true)
    try {
      const input: RuntimeInput = {
        name: name.trim(),
        command: command.trim(),
        profile: profile.trim(),
        argsTemplate: argsTemplate.trim(),
        enabled,
      }
      // 清单加载失败时没有可选执行器：不写空串 key（IPC 会把空串当成未注册的 key 拒绝）
      if (executorKey !== '') input.executorKey = executorKey
      await onSubmit(input)
    } catch (e) {
      // 新建会先探测，失败时弹窗保持打开并就地说明原因
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={() => {
        // Radix 受控弹窗无 Trigger：dismiss 只会发 false，故直接收口
        onCancel()
      }}
    >
      {/* 高度上限 + 内部滚动：字段多的表单不把弹窗顶出视口（SPEC-ui §4「Dialog 的尺寸」） */}
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑运行时' : '新建运行时'}</DialogTitle>
        </DialogHeader>

        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="名称" required hint="保存时去掉首尾空格" error={nameError}>
              <Input
                aria-label="运行时名称"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameError(null)
                }}
              />
            </Field>
            <Field
              label="执行器"
              error={executorsError === null ? null : `执行器加载失败：${executorsError}`}
            >
              <Select
                value={executorKey}
                onValueChange={changeExecutor}
                disabled={executors.length === 0}
              >
                <SelectTrigger aria-label="运行时执行器" className="w-full">
                  <SelectValue
                    placeholder={executorsLoading ? '正在读取执行器…' : '无可用执行器'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {executors.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="命令"
              required
              hint="命令名或绝对路径；脚本阶段用的就是这一条（阶段上不再单独填命令）；保存前会探测这条连接能否起来"
              error={commandError}
            >
              <Input
                aria-label="运行时命令"
                className="font-mono"
                value={command}
                onChange={(e) => {
                  setCommand(e.target.value)
                  setCommandError(null)
                }}
              />
            </Field>
            <Field label="profile">
              <Input
                aria-label="运行时 profile"
                className="font-mono"
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              />
            </Field>
            <Field label="参数模板" className="col-span-2" hint={ARGS_TEMPLATE_HINT}>
              <Textarea
                aria-label="运行时参数模板"
                className="max-h-48 min-h-20 resize-y font-mono"
                placeholder='["--print","{prompt}"]'
                value={argsTemplate}
                onChange={(e) => setArgsTemplate(e.target.value)}
              />
            </Field>
          </div>

          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
            模型、思考强度、并发、访问权限、工作目录、环境变量都在「智能体」里配：同一个连接可以被多个智能体复用。
          </p>

          {editing && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">启用</span>
              <Label className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label="启用运行时"
                  className="size-4 accent-[var(--ring)]"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>启用后派发</span>
              </Label>
            </div>
          )}

          <FormError message={error} onDismiss={() => setError(null)} />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button type="submit" variant="default" size="sm" disabled={saving}>
              {editing ? '保存' : '添加'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
