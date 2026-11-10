import { useEffect, useState, type ReactElement } from 'react'
import type {
  PermissionMode,
  Runtime,
  RuntimeExecutorChoice,
  RuntimeInput,
  RuntimeModelOption,
} from '../../../../../protocol/entities'
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

/** 模型下拉里代表「手动输入」的哨兵值（不会发给主进程） */
const CUSTOM_MODEL = '__custom__'

const ARGS_TEMPLATE_HINT = 'JSON 数组，占位符 {model}/{effort}/{cwd}/{context}/{prompt}'

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'read-only', label: '只读' },
  { value: 'workspace-write', label: '可写' },
  { value: 'danger-full-access', label: '完全访问' },
]

const PERMISSION_HINT =
  '沙箱基线：越界修改先被拒绝；工具可随后申请提权，而提权请求由运行时自动放行（不会询问你）。'

/** 完全访问的风险声明：选中后必须显式勾选才能保存（Multica 式「缩小暴露面」的最小落地） */
const DANGER_NOTICE =
  '完全访问没有沙箱：agent 可读写本机任意文件、网络不受限制，所有提权请求自动放行。'

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
 * 编辑时才有 id，才能读该运行时的模型目录（`runtimes.models`）：新建阶段不做探测，
 * 模型与推理强度留到保存后再选，避免未落库就调用 CLI。提交失败的错误留在弹窗内。
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
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    initial?.permissionMode ?? runtime?.permissionMode ?? 'workspace-write',
  )
  /** 完全访问的显式确认：每次保存都要重新勾（不给「顺手点过」留默认值） */
  const [dangerAck, setDangerAck] = useState(false)
  const [modelChoice, setModelChoice] = useState<string>(
    runtime?.model ? CUSTOM_MODEL : (initial?.model ?? ''),
  )
  const [customModel, setCustomModel] = useState(runtime?.model ?? initial?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(runtime?.reasoningEffort ?? '')
  const [workdir, setWorkdir] = useState(initial?.workdir ?? runtime?.workdir ?? '')
  /** 宿主解析出的默认工作目录（表单留空时实际用的路径），只用于展示 */
  const [defaultWorkdir, setDefaultWorkdir] = useState('')
  const [maxConcurrent, setMaxConcurrent] = useState(
    String(runtime?.maxConcurrent ?? initial?.maxConcurrent ?? 1),
  )
  const [enabled, setEnabled] = useState(runtime?.enabled ?? true)
  const [executors, setExecutors] = useState<RuntimeExecutorChoice[]>([])
  const [executorsLoading, setExecutorsLoading] = useState(true)
  const [executorsError, setExecutorsError] = useState<string | null>(null)
  const [models, setModels] = useState<RuntimeModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(editing)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [concurrentError, setConcurrentError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 执行器清单来自宿主视图 `runtimes.executors`（注册表顺序）；表单不写死任何执行器名。
  // 新建时用首项 manifest 的 command/profile 预填，编辑时保留运行时现有值不覆盖。
  useEffect(() => {
    let alive = true
    void getKernelStore()
      .query('runtimes.executors')
      .then((list) => {
        if (!alive) return
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

  // 默认工作目录：宿主视图只读一次，用作「工作目录」留空时的占位提示
  useEffect(() => {
    let alive = true
    void getKernelStore()
      .query('runtimes.default-workdir')
      .then((value) => {
        if (alive) setDefaultWorkdir(value ?? '')
      })
      .catch(() => {
        // 读不到只影响占位文案：留空仍然会走宿主默认目录
        if (alive) setDefaultWorkdir('')
      })
    return () => {
      alive = false
    }
  }, [])

  // 编辑时读取该运行时的模型目录；失败不阻塞手动填写模型 id
  useEffect(() => {
    const target = runtime
    if (!target) return
    const initialModel = target.model ?? ''
    let alive = true
    void getKernelStore()
      .query('runtimes.models', { runtimeId: target.id })
      .then((list) => {
        if (!alive) return
        setModels(list ?? [])
        // 初始按「手动输入」渲染的已有模型，命中目录后切回已知选项
        setModelChoice((prev) =>
          prev === CUSTOM_MODEL && (list ?? []).some((m) => m.id === initialModel)
            ? initialModel
            : prev,
        )
      })
      .catch((e: unknown) => {
        if (alive) setModelsError(errMsg(e))
      })
      .finally(() => {
        if (alive) setModelsLoading(false)
      })
    return () => {
      alive = false
    }
  }, [runtime])

  const modelValue = modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice
  const selectedModel = models.find((m) => m.id === modelValue) ?? null
  const thinkingLevels = selectedModel?.thinkingLevels ?? []

  const effortOptions = [
    { value: '', label: '默认' },
    ...thinkingLevels.map((level) => ({ value: level, label: level })),
  ]
  // 已有值不在当前模型的能力清单里时仍要能显示（例如模型目录读取失败）
  if (reasoningEffort !== '' && !thinkingLevels.includes(reasoningEffort)) {
    effortOptions.push({ value: reasoningEffort, label: reasoningEffort })
  }

  const modelOptions = editing
    ? [
        { value: '', label: '默认' },
        ...models.map((m) => ({ value: m.id, label: m.label })),
        { value: CUSTOM_MODEL, label: '手动输入…' },
      ]
    : [{ value: '', label: '默认' }]

  const changeExecutor = (key: string): void => {
    setExecutorKey(key)
    // 新建时切执行器才预填该执行器 manifest 的默认命令/profile；编辑时不动用户的现有配置
    if (editing) return
    // Select 的选项来自 executors：能选到的 key 一定在清单里（找不到说明 UI 状态不一致）
    const choice = executors.find((item) => item.key === key) as RuntimeExecutorChoice
    setCommand(choice.command)
    setProfile(choice.profile)
  }

  const changeModel = (value: string): void => {
    setModelChoice(value)
    setReasoningEffort('')
  }

  const changeCustomModel = (value: string): void => {
    setCustomModel(value)
    setReasoningEffort('')
  }

  /** 按钮禁用必须伴随可见原因：解释了才知道要先去勾确认 */
  const dangerHint =
    permissionMode === 'danger-full-access' && !dangerAck
      ? '先勾选上面的「我明白风险，仍要选完全访问」，才能保存。'
      : null

  const submit = async (ev: React.FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault()
    setError(null)
    setNameError(null)
    setConcurrentError(null)

    // 必填与数值校验放在前端：空名不再交给内核 reject，非法并发也不再被悄悄改成 1
    if (name.trim() === '') {
      setNameError('名称必填')
      focusControl(ev.currentTarget, '运行时名称')
      return
    }
    const concurrent = Number(maxConcurrent.trim())
    if (!Number.isInteger(concurrent) || concurrent < 1) {
      setConcurrentError('并发上限必须是 ≥1 的整数')
      focusControl(ev.currentTarget, '运行时并发上限')
      return
    }

    setSaving(true)
    try {
      const input: RuntimeInput = {
        name: name.trim(),
        command: command.trim(),
        profile: profile.trim(),
        argsTemplate: argsTemplate.trim(),
        permissionMode,
        model: modelValue === '' ? null : modelValue,
        reasoningEffort: reasoningEffort === '' ? null : reasoningEffort,
        workdir: workdir.trim() === '' ? null : workdir.trim(),
        maxConcurrent: concurrent,
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
      onOpenChange={(next) => {
        if (!next) onCancel()
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
            <Field label="命令">
              <Input
                aria-label="运行时命令"
                className="font-mono"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
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
            <Field label="并发上限" hint="同一运行时同时执行的任务数，≥1" error={concurrentError}>
              <Input
                aria-label="运行时并发上限"
                type="number"
                min={1}
                value={maxConcurrent}
                onChange={(e) => {
                  setMaxConcurrent(e.target.value)
                  setConcurrentError(null)
                }}
              />
            </Field>
            <Field label="权限模式" hint={PERMISSION_HINT}>
              <Select
                value={permissionMode}
                onValueChange={(v) => {
                  setPermissionMode(v as PermissionMode)
                  // 换了模式就撤销上一次的确认：确认只对当前选择有效
                  setDangerAck(false)
                }}
              >
                <SelectTrigger aria-label="运行时权限模式" className="w-full">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="工作目录"
              hint="留空 = 默认目录（改默认值设 WORKBENCH_WORKDIR，缺省 ~/.workbench）"
            >
              <Input
                aria-label="运行时工作目录"
                className="font-mono"
                value={workdir}
                placeholder={defaultWorkdir === '' ? '留空用默认目录' : defaultWorkdir}
                onChange={(e) => setWorkdir(e.target.value)}
              />
            </Field>
            <Field
              label="模型"
              hint={modelsLoading ? '读取模型中…' : undefined}
              error={modelsError === null ? null : `模型加载失败：${modelsError}（可手填）`}
            >
              {/* 空值项（默认模型）显示 placeholder：placeholder 文案 = 该空值项的标签 */}
              <Select
                value={modelChoice}
                onValueChange={changeModel}
                disabled={!editing || modelsLoading}
              >
                <SelectTrigger aria-label="运行时模型" className="w-full">
                  <SelectValue placeholder="默认" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="推理强度">
              <Select
                value={reasoningEffort}
                onValueChange={setReasoningEffort}
                disabled={!editing || thinkingLevels.length === 0}
              >
                <SelectTrigger aria-label="运行时推理强度" className="w-full">
                  <SelectValue placeholder="默认" />
                </SelectTrigger>
                <SelectContent>
                  {effortOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {editing && modelChoice === CUSTOM_MODEL && (
              <Field label="模型 id" className="col-span-2">
                <Input
                  aria-label="运行时模型手填"
                  className="font-mono"
                  value={customModel}
                  onChange={(e) => changeCustomModel(e.target.value)}
                />
              </Field>
            )}
          </div>

          {permissionMode === 'danger-full-access' && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
              <p className="text-xs text-destructive">{DANGER_NOTICE}</p>
              <Label className="mt-1.5 flex items-center gap-2 text-xs font-normal text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label="已确认完全访问风险"
                  className="size-4 accent-[var(--ring)]"
                  checked={dangerAck}
                  onChange={(e) => setDangerAck(e.target.checked)}
                />
                <span>我明白风险，仍要选完全访问</span>
              </Label>
            </div>
          )}

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

          <div className="flex flex-col gap-2">
            {dangerHint !== null && <p className="text-xs text-faint-foreground">{dangerHint}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                取消
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                disabled={saving || (permissionMode === 'danger-full-access' && !dangerAck)}
              >
                {editing ? '保存' : '添加'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
