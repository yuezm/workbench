import { useState, type ReactElement } from 'react'
import type { ConfigField, PluginKind } from '../../../../../protocol/manifest'
import type { PluginStatus, PluginView } from '../../../../../protocol/plugins'
import { Button } from '../../../components/ui/button'
import { Field } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import { badgeCls, panelCls } from '../../../components/ui/panel'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 空态：引用稳定，未就绪时不每次渲染都新建数组 */
const EMPTY_PLUGINS: PluginView[] = []

/** 状态中文映射：口径由契约 `PluginStatus` 给，UI 不推导装载规则 */
const STATUS_LABELS: Record<PluginStatus, string> = {
  ready: '可用',
  disabled: '已停用',
  unauthorized: '未授权',
  error: '异常',
  manifest_error: '清单不合法',
}

/** 状态徽标配色：可用 = 短休息绿，未授权 = 琥珀，异常 / 清单不合法 = 红 */
const STATUS_TONES: Record<PluginStatus, string> = {
  ready: 'bg-short/15 text-short',
  disabled: 'bg-white/[0.07] text-ink-faint',
  unauthorized: 'bg-amber-400/15 text-amber-300',
  error: 'bg-red-400/15 text-red-300',
  manifest_error: 'bg-red-400/15 text-red-300',
}

const KIND_LABELS: Record<PluginKind, string> = {
  source: '来源',
  executor: '执行器',
  channel: '通道',
  app: '应用',
}

/** 表单草稿：文本 / 数字 / 下拉存字符串，布尔单列（保存时按字段类型转回标量） */
interface ConfigDraft {
  text: Record<string, string>
  flags: Record<string, boolean>
}

/** 按当前视图值初始化 config 表单（缺省值由 manifest 的 default 给；secret 不在表单值里） */
function initialConfig(plugin: PluginView): ConfigDraft {
  const draft: ConfigDraft = { text: {}, flags: {} }
  for (const field of plugin.configFields) {
    const current = plugin.config[field.key]
    if (field.type === 'boolean') {
      draft.flags[field.key] = current === true
      continue
    }
    if (field.type === 'secret') continue
    const raw = current ?? field.default
    draft.text[field.key] = raw === undefined ? '' : String(raw)
  }
  return draft
}

/**
 * 一行插件：只读视图字段 + 本地编辑草稿。
 *
 * - 启停直接发 `plugin.set{enabled}`（不乐观更新，等事实失效后的视图回显）；
 * - 授权 / config / secret 先在本地编辑，保存时一次 `plugin.set` 合并提交；
 * - secret 只写不回显：输入框始终从空开始，已写入的键由视图 `secretKeys` 标记「已设置」。
 */
function PluginRow({ plugin }: { plugin: PluginView }): ReactElement {
  const [granted, setGranted] = useState<string[]>(() => [...plugin.granted])
  const [config, setConfig] = useState<ConfigDraft>(() => initialConfig(plugin))
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const declared = plugin.declared
  const grantedSet = new Set(granted)
  const secretKeys = new Set(plugin.secretKeys)

  const run = (command: () => Promise<unknown>): void => {
    setBusy(true)
    setActionError(null)
    void (async () => {
      try {
        await command()
      } catch (e) {
        setActionError(errMsg(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  const toggleEnabled = (): void => {
    run(() =>
      getKernelStore().dispatch({
        type: 'plugin.set',
        commandId: '',
        pluginId: plugin.id,
        enabled: !plugin.enabled,
      }),
    )
  }

  const toggleGranted = (capability: string, checked: boolean): void => {
    setGranted((current) =>
      checked ? [...current, capability] : current.filter((item) => item !== capability),
    )
  }

  const setText = (key: string, value: string): void => {
    setConfig((current) => ({ ...current, text: { ...current.text, [key]: value } }))
  }

  const setFlag = (key: string, value: boolean): void => {
    setConfig((current) => ({ ...current, flags: { ...current.flags, [key]: value } }))
  }

  /** 按字段类型把草稿转成标量；空字符串不写入（保留 manifest 缺省值） */
  const configPatch = (): Record<string, string | number | boolean> => {
    const patch: Record<string, string | number | boolean> = {}
    for (const field of plugin.configFields) {
      if (field.type === 'boolean') {
        patch[field.key] = config.flags[field.key] === true
        continue
      }
      if (field.type === 'secret') continue
      const text = config.text[field.key]
      if (text.trim() === '') continue
      patch[field.key] = field.type === 'number' ? Number(text) : text
    }
    return patch
  }

  const save = (): void => {
    run(async () => {
      const hasSecrets = Object.keys(secrets).length > 0
      await getKernelStore().dispatch({
        type: 'plugin.set',
        commandId: '',
        pluginId: plugin.id,
        enabled: plugin.enabled,
        granted: declared.filter((capability) => grantedSet.has(capability)),
        config: configPatch(),
        ...(hasSecrets ? { secrets } : {}),
      })
      setSecrets({})
    })
  }

  const renderControl = (field: ConfigField): ReactElement => {
    const name = `${plugin.name} ${field.label}`
    if (field.type === 'boolean') {
      return (
        <Field key={field.key} label={field.label} className="min-w-0">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-black/25 px-3 text-sm text-ink">
            <input
              type="checkbox"
              aria-label={name}
              className="size-4 accent-[var(--color-focus)]"
              checked={config.flags[field.key] === true}
              onChange={(e) => setFlag(field.key, e.target.checked)}
            />
            <span className="text-[11px] text-ink-faint">
              {config.flags[field.key] === true ? '开启' : '关闭'}
            </span>
          </div>
        </Field>
      )
    }
    if (field.type === 'select') {
      return (
        <Field key={field.key} label={field.label} className="min-w-0">
          <Select
            ariaLabel={name}
            value={config.text[field.key]}
            options={[
              { value: '', label: '未设置' },
              ...(field.options ?? []).map((option) => ({ value: option, label: option })),
            ]}
            onChange={(next) => setText(field.key, next)}
          />
        </Field>
      )
    }
    if (field.type === 'secret') {
      const written = secretKeys.has(field.key)
      return (
        <Field key={field.key} label={field.label} className="min-w-0">
          <Input
            type="password"
            aria-label={name}
            autoComplete="new-password"
            placeholder={written ? '已设置，留空不修改' : '未设置'}
            value={secrets[field.key] ?? ''}
            onChange={(e) => {
              const value = e.target.value
              setSecrets((current) => {
                if (value !== '') return { ...current, [field.key]: value }
                const next = { ...current }
                delete next[field.key]
                return next
              })
            }}
          />
          {written && <span className="text-[10px] text-short">已设置</span>}
        </Field>
      )
    }
    return (
      <Field key={field.key} label={field.label} className="min-w-0">
        <Input
          type={field.type === 'number' ? 'number' : 'text'}
          aria-label={name}
          value={config.text[field.key]}
          onChange={(e) => setText(field.key, e.target.value)}
        />
      </Field>
    )
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-white/[0.02]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-ink-dim">
          <PluginIcon />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{plugin.name}</span>
            <span
              className={cn('rounded-full px-1.5 py-0.5 text-[10px]', STATUS_TONES[plugin.status])}
            >
              {STATUS_LABELS[plugin.status]}
            </span>
            <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-faint">
              {plugin.builtin ? '内置' : '外部'}
            </span>
            <span className="text-[11px] text-ink-faint">
              {KIND_LABELS[plugin.kind]} · v{plugin.version}
            </span>
          </div>
          {plugin.description !== '' && (
            <p className="truncate text-[11px] text-ink-faint">{plugin.description}</p>
          )}
          {plugin.error !== null && <p className="text-[11px] text-red-300">{plugin.error}</p>}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={plugin.enabled}
          aria-label={`启用插件 ${plugin.name}`}
          disabled={busy}
          onClick={toggleEnabled}
          className={cn(
            'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200 outline-none',
            'focus-visible:ring-2 focus-visible:ring-focus/60 disabled:cursor-not-allowed disabled:opacity-40',
            plugin.enabled ? 'bg-focus' : 'bg-white/10',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-200',
              plugin.enabled && 'translate-x-4',
            )}
          />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] text-ink-faint">声明能力</span>
        {declared.length === 0 ? (
          <span className="text-[11px] text-ink-faint">无</span>
        ) : (
          declared.map((capability) => (
            <label
              key={capability}
              className="flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-[11px] text-ink-dim"
            >
              <input
                type="checkbox"
                aria-label={`${plugin.name} 授权 ${capability}`}
                className="size-3.5 accent-[var(--color-focus)]"
                checked={grantedSet.has(capability)}
                disabled={busy}
                onChange={(e) => toggleGranted(capability, e.target.checked)}
              />
              <span className="font-mono">{capability}</span>
            </label>
          ))
        )}
      </div>

      {plugin.configFields.length > 0 && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {plugin.configFields.map(renderControl)}
        </div>
      )}

      {actionError !== null && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-[11px] text-red-300">
          {actionError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <p className="text-[11px] text-ink-faint">授权只是信任门；secret 不回显。</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={`保存插件 ${plugin.name}`}
          disabled={busy}
          className="ml-auto"
          onClick={save}
        >
          保存
        </Button>
      </div>
    </li>
  )
}

function PluginIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" />
    </svg>
  )
}

/**
 * 设置区「插件」页（M7）：读宿主视图 `plugins.all`，写一律 `plugin.set`。
 *
 * UI 只做「展示视图 + 收集用户输入」：插件该不该启动、是否授权足够、secret 写没写成功
 * 都由宿主按视图与命令结果表达，组件不推导装载规则、不轮询、不新增通道。
 */
export function PluginsManager(): ReactElement {
  const pluginsState = useKernelViewState('plugins.all')
  const plugins = pluginsState.data ?? EMPTY_PLUGINS
  const error = pluginsState.error
  const loading = pluginsState.data === undefined && error === null

  return (
    <div className="flex flex-col gap-3">
      {error !== null && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <p className="text-xs text-ink-faint">未授权的插件不会启动。</p>

      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(badgeCls)}>共 {plugins.length} 个</span>
      </div>

      {loading ? (
        <p className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
          正在读取插件清单…
        </p>
      ) : plugins.length === 0 ? (
        <p className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
          未发现插件
        </p>
      ) : (
        <ul className={cn(panelCls, 'divide-y divide-line overflow-hidden')}>
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} />
          ))}
        </ul>
      )}
    </div>
  )
}
