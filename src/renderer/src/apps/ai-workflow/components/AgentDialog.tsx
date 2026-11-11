import { useEffect, useState, type ReactElement } from 'react'
import { AGENT_ENV_LIMITS, ENV_KEY_PATTERN } from '../../../../../protocol/entities'
import type {
  AgentInput,
  PermissionMode,
  Runtime,
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

/** 模型下拉里代表「手动输入」的哨兵值（不会发给主进程） */
const CUSTOM_MODEL = '__custom__'

/** 访问权限的中文名（清单与表单共用一张表，不写两套映射）。 */
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  'read-only': '只读',
  'workspace-write': '可写',
  'danger-full-access': '完全访问',
}

/** 访问权限选项（沙箱基线，越界操作先被拒绝）。 */
export const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'read-only', label: PERMISSION_LABEL['read-only'] },
  { value: 'workspace-write', label: PERMISSION_LABEL['workspace-write'] },
  { value: 'danger-full-access', label: PERMISSION_LABEL['danger-full-access'] },
]

const PERMISSION_HINT =
  '沙箱基线：越界修改先被拒绝；工具可随后申请提权，而提权请求按所选模式自动放行（不会询问你）。'

/** 完全访问的风险声明：选中后必须显式勾选才能保存（与旧的运行时表单同口径） */
const DANGER_NOTICE =
  '完全访问没有沙箱：agent 可读写本机任意文件、网络不受限制，所有提权请求自动放行。'

/** 环境变量文本 → 对象：`KEY=VALUE` 一行一条，空行忽略；非法行整体报错（不做静默丢弃）。 */
export function parseEnvText(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '') continue
    const at = line.indexOf('=')
    if (at <= 0) return { env: {}, error: `第 ${i + 1} 行缺少「键=值」` }
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1)
    if (!ENV_KEY_PATTERN.test(key) || key.length > AGENT_ENV_LIMITS.maxKeyChars) {
      return { env: {}, error: `第 ${i + 1} 行的变量名非法：${key}` }
    }
    if (value.length > AGENT_ENV_LIMITS.maxValueChars) {
      return { env: {}, error: `第 ${i + 1} 行的值超过 ${AGENT_ENV_LIMITS.maxValueChars} 字符` }
    }
    env[key] = value
  }
  if (Object.keys(env).length > AGENT_ENV_LIMITS.maxVars) {
    return { env: {}, error: `最多 ${AGENT_ENV_LIMITS.maxVars} 个环境变量` }
  }
  return { env, error: null }
}

/** 环境变量对象 → 文本（编辑态回显）。 */
export function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
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
 * 新建 / 编辑智能体弹窗：身份 + System Prompt + **执行配置**。
 *
 * 执行配置（模型 / 思考强度 / 并发 / 访问权限 / 工作目录 / 环境变量）是智能体的设置；
 * 运行时只提供连接，所以模型目录按所选运行时向宿主查询（`runtimes.models`）。
 *
 * 校验：名称必填（保存时 trim）、并发是 ≥1 的整数、环境变量逐行合法；提交被拒时错误挂在
 * 对应字段上，父级 reject 的文案留在弹窗底部，输入不丢。
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
  const [modelChoice, setModelChoice] = useState(initial.model ?? '')
  const [customModel, setCustomModel] = useState(initial.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(initial.reasoningEffort ?? '')
  const [maxConcurrent, setMaxConcurrent] = useState(String(initial.maxConcurrent ?? 1))
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    initial.permissionMode ?? 'workspace-write',
  )
  const [dangerAck, setDangerAck] = useState(false)
  const [workdir, setWorkdir] = useState(initial.workdir ?? '')
  const [envText, setEnvText] = useState(formatEnvText(initial.env ?? {}))
  /**
   * 模型目录按运行时缓存一份：`runtimeId` 与缓存不一致就是「正在读」。
   * 这样切换运行时不需要在 effect 里同步 setState（不会被 lint 挡，也不会连环渲染）。
   */
  const [modelsState, setModelsState] = useState<{
    runtimeId: string
    list: RuntimeModelOption[]
    error: string | null
  }>({ runtimeId: '', list: [], error: null })
  const [defaultWorkdir, setDefaultWorkdir] = useState('')
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [concurrentError, setConcurrentError] = useState<string | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)
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

  // 模型目录跟着所选运行时走（连接决定有哪些模型）；读取失败不阻塞手填 id
  useEffect(() => {
    if (runtimeId === '') return
    let alive = true
    void getKernelStore()
      .query('runtimes.models', { runtimeId })
      .then((list) => {
        if (alive) setModelsState({ runtimeId, list: list ?? [], error: null })
      })
      .catch((e: unknown) => {
        if (alive) setModelsState({ runtimeId, list: [], error: errMsg(e) })
      })
    return () => {
      alive = false
    }
  }, [runtimeId])

  // 默认工作目录：宿主视图只读一次，用作「工作目录」留空时的占位提示
  useEffect(() => {
    let alive = true
    void getKernelStore()
      .query('runtimes.default-workdir')
      .then((value) => {
        if (alive) setDefaultWorkdir(value ?? '')
      })
      .catch(() => {
        if (alive) setDefaultWorkdir('')
      })
    return () => {
      alive = false
    }
  }, [])

  /** 当前运行时对应的模型目录（缓存键不一致 = 还没回来，按空目录处理） */
  const models = modelsState.runtimeId === runtimeId ? modelsState.list : []
  const modelsLoading = runtimeId !== '' && modelsState.runtimeId !== runtimeId
  const modelsError = modelsState.runtimeId === runtimeId ? modelsState.error : null
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

  /** 模型选项：目录 + 「默认」+「手动输入」；目录里没有的既有值也补一条，避免保存时被悄悄改掉 */
  const modelOptions = [
    { value: '', label: '默认' },
    ...models.map((m) => ({ value: m.id, label: m.label })),
    ...(modelChoice !== '' &&
    modelChoice !== CUSTOM_MODEL &&
    !models.some((m) => m.id === modelChoice)
      ? [{ value: modelChoice, label: modelChoice }]
      : []),
    { value: CUSTOM_MODEL, label: '手动输入…' },
  ]

  /** 按钮禁用必须伴随可见原因：点不动又不说为什么，和静默 return 是同一个毛病 */
  const disabledHint =
    runtimeId === '' ? '缺少可绑定的运行时：先到「运行时」新建并测试通过再回来。' : null
  const dangerHint =
    permissionMode === 'danger-full-access' && !dangerAck
      ? '先勾选上面的「我明白风险，仍要选完全访问」，才能保存。'
      : null

  const submit = async (ev: React.FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault()
    setError(null)
    setNameError(null)
    setRuntimeError(null)
    setModelError(null)
    setConcurrentError(null)
    setEnvError(null)

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
    const concurrent = Number(maxConcurrent.trim())
    if (!Number.isInteger(concurrent) || concurrent < 1) {
      setConcurrentError('并发上限必须是 ≥1 的整数')
      focusControl(ev.currentTarget, '智能体并发上限')
      return
    }
    // 模型 id 必须是 provider/model：写错时在这里拦住，别让执行期悄悄退回默认模型
    if (modelValue !== '' && !/^[^/]+\/\S+$/.test(modelValue)) {
      setModelError('模型 id 必须是 provider/model 形式')
      focusControl(ev.currentTarget, modelChoice === CUSTOM_MODEL ? '智能体模型手填' : '智能体模型')
      return
    }
    const parsed = parseEnvText(envText)
    if (parsed.error !== null) {
      setEnvError(parsed.error)
      focusControl(ev.currentTarget, '智能体环境变量')
      return
    }

    setSaving(true)
    try {
      await onSubmit({
        name: trimmedName,
        description: description.trim(),
        runtimeId,
        systemPrompt: systemPrompt.trim(),
        model: modelValue === '' ? null : modelValue,
        reasoningEffort: reasoningEffort === '' ? null : reasoningEffort,
        maxConcurrent: concurrent,
        permissionMode,
        workdir: workdir.trim() === '' ? null : workdir.trim(),
        env: parsed.env,
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
      onOpenChange={() => {
        // Radix 受控弹窗无 Trigger：dismiss 只会发 false，故直接收口
        onCancel()
      }}
    >
      {/*
        必须有高度上限：System Prompt 能写几千字，`field-sizing-content` 的 textarea 会把
        弹窗撑到比视口还高，而 DialogContent 是 fixed + translate 居中（SPEC-ui §4「Dialog 的
        尺寸」），超出的上下两端会被裁到屏幕外，保存按钮点不到。改为头部 / 底部固定、
        字段区自己滚动的列布局。
      */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
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

              <Field
                label="模型"
                hint={modelsLoading ? '读取模型中…' : '来自运行时连接'}
                error={
                  modelError ??
                  (modelsError === null ? null : `模型加载失败：${modelsError}（可手填）`)
                }
              >
                {/* 空值项（默认模型）显示 placeholder：placeholder 文案 = 该空值项的标签 */}
                <Select
                  value={modelChoice}
                  onValueChange={(value) => {
                    setModelChoice(value)
                    setModelError(null)
                    setReasoningEffort('')
                  }}
                  disabled={modelsLoading}
                >
                  <SelectTrigger aria-label="智能体模型" className="w-full">
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
              {modelChoice === CUSTOM_MODEL && (
                <Field
                  label="模型 id"
                  className="col-span-2"
                  hint="provider/model，如 deepseek/deepseek-v4"
                >
                  <Input
                    aria-label="智能体模型手填"
                    className="font-mono"
                    value={customModel}
                    onChange={(e) => {
                      setCustomModel(e.target.value)
                      setModelError(null)
                    }}
                  />
                </Field>
              )}
              <Field label="思考强度">
                <Select
                  value={reasoningEffort}
                  onValueChange={setReasoningEffort}
                  disabled={thinkingLevels.length === 0}
                >
                  <SelectTrigger aria-label="智能体思考强度" className="w-full">
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

              <Field label="并发上限" hint="同一智能体同时执行的任务数，≥1" error={concurrentError}>
                <Input
                  aria-label="智能体并发上限"
                  type="number"
                  min={1}
                  value={maxConcurrent}
                  onChange={(e) => {
                    setMaxConcurrent(e.target.value)
                    setConcurrentError(null)
                  }}
                />
              </Field>
              <Field label="访问权限" hint={PERMISSION_HINT}>
                <Select
                  value={permissionMode}
                  onValueChange={(v) => {
                    setPermissionMode(v as PermissionMode)
                    // 换了模式就撤销上一次的确认：确认只对当前选择有效
                    setDangerAck(false)
                  }}
                >
                  <SelectTrigger aria-label="智能体访问权限" className="w-full">
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
                className="col-span-2"
                hint="留空 = 任务项目的文件夹；没有项目时用默认目录（改默认值设 WORKBENCH_WORKDIR，缺省 ~/.workbench）"
              >
                <Input
                  aria-label="智能体工作目录"
                  className="font-mono"
                  value={workdir}
                  placeholder={defaultWorkdir === '' ? '留空用默认目录' : defaultWorkdir}
                  onChange={(e) => setWorkdir(e.target.value)}
                />
              </Field>

              <Field
                label="环境变量"
                className="col-span-2"
                hint={`每行一条 KEY=VALUE；最多 ${AGENT_ENV_LIMITS.maxVars} 个，值里的等号原样保留`}
                error={envError}
              >
                <Textarea
                  aria-label="智能体环境变量"
                  className="max-h-40 min-h-20 resize-y font-mono text-sm"
                  rows={4}
                  placeholder="HTTP_PROXY=http://127.0.0.1:7890"
                  value={envText}
                  onChange={(e) => {
                    setEnvText(e.target.value)
                    setEnvError(null)
                  }}
                />
              </Field>
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
          </div>

          <FormError message={error} onDismiss={() => setError(null)} />

          <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-3">
            {disabledHint !== null && (
              <p className="text-xs text-faint-foreground">{disabledHint}</p>
            )}
            {dangerHint !== null && <p className="text-xs text-faint-foreground">{dangerHint}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                取消
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                disabled={
                  saving ||
                  runtimeId === '' ||
                  (permissionMode === 'danger-full-access' && !dangerAck)
                }
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
