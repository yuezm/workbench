import { useState, type ReactElement } from 'react'
import type { WorkflowInput, WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'
import { SOP_TEMPLATES, draftFromTemplate, type SopTemplate } from '../model/sop-templates'
import { WorkflowEditor } from './WorkflowEditor'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 设置区的工作流清单：新建 / 选择 / 编辑工作流定义。
 *
 * 自己订阅 `workflows.all` 并维护「当前」选中（首个工作流为默认；新建成功后用
 * `dispatch` 返回的实体选中新建项）。新建/编辑共用一个弹窗，保存命令也在这里发，
 * 页面不再传任何 props。
 *
 * 新建有两条路：「新建工作流」给空白草稿（一个「待办」阶段），「SOP 模板」列出
 * 产品/研发/测试/发版的开箱模板，选中即把阶段序列与「要干什么」预填进同一个编辑器——
 * 模板只预填，落地仍要用户确认（阶段绑定的智能体是本机配置，模板不替用户做主）。
 */
export function WorkflowManager(): ReactElement {
  const { data, error: readError } = useKernelViewState('workflows.all')
  const workflows = data ?? []
  /** 用户选中的工作流 id；失效（被删）时回落到首个 */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 非 undefined = 编辑器打开中（null = 新建，实体 = 编辑） */
  const [editing, setEditing] = useState<WorkflowWithStages | null | undefined>(undefined)
  /** 从模板新建时的预填草稿；空白新建与编辑时为 null */
  const [seed, setSeed] = useState<WorkflowInput | null>(null)
  /** SOP 模板选择弹窗 */
  const [picking, setPicking] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 删除失败（与保存错误分开，避免同屏互相覆盖） */
  const [actionError, setActionError] = useState<string | null>(null)

  const activeId =
    selectedId !== null && workflows.some((w) => w.id === selectedId)
      ? selectedId
      : workflows[0]?.id

  const openEditor = (workflow: WorkflowWithStages | null): void => {
    setSaveError(null)
    setSeed(null)
    setEditing(workflow)
  }

  /** 选中模板：直接打开编辑器并预填，模板弹窗关掉（保存与否由用户在编辑器里决定） */
  const openTemplate = (template: SopTemplate): void => {
    setSaveError(null)
    setSeed(draftFromTemplate(template))
    setEditing(null)
    setPicking(false)
  }

  /** 删除工作流：内核级联删阶段 / 任务 / run；有活跃任务的 run 由宿主先取消 */
  const remove = async (id: string): Promise<void> => {
    setActionError(null)
    try {
      await getKernelStore().dispatch({ type: 'workflow.remove', commandId: '', id })
      setEditing((prev) => (prev && prev.id === id ? undefined : prev))
    } catch (e) {
      setActionError(errMsg(e))
    }
  }

  const save = async (input: WorkflowInput): Promise<void> => {
    setSaveError(null)
    try {
      const store = getKernelStore()
      if (editing) {
        await store.dispatch({
          type: 'workflow.update',
          commandId: '',
          id: editing.id,
          input,
        })
      } else {
        const result = await store.dispatch({ type: 'workflow.create', commandId: '', input })
        // 保存后选中新建项：id 直接取命令返回的实体，不等视图刷新
        if (result.value !== null) setSelectedId(result.value.id)
      }
      setEditing(undefined)
    } catch (e) {
      // 保存失败保持弹窗打开并就地说明原因
      setSaveError(errMsg(e))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {(actionError ?? readError) && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
          {actionError ?? readError}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-faint">阶段序列与流转</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
            SOP 模板
          </Button>
          <Button variant="primary" size="sm" onClick={() => openEditor(null)}>
            新建工作流
          </Button>
        </div>
      </div>

      {workflows.length === 0 ? (
        <p className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
          暂无工作流
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {workflows.map((w) => {
            const active = w.id === activeId
            return (
              <li
                key={w.id}
                className={
                  active
                    ? 'flex items-center gap-3 bg-focus/[0.06] px-4 py-3'
                    : 'flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]'
                }
              >
                <button
                  type="button"
                  aria-label={`选择工作流 ${w.name}`}
                  className="flex min-w-0 flex-1 flex-col items-start text-left outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                  onClick={() => setSelectedId(w.id)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">
                    {w.name}
                    {active && (
                      <span className="rounded-sm bg-focus/15 px-1.5 py-0.5 text-[11px] text-focus-soft">
                        当前
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] text-ink-faint">
                    {w.stages.length} 阶段
                    {w.description ? ` · ${w.description}` : ''}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => openEditor(w)}>
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-400 hover:text-red-300"
                    aria-label={`删除工作流 ${w.name}`}
                    onClick={() => void remove(w.id)}
                  >
                    删除
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {editing !== undefined && (
        <Dialog onClose={() => setEditing(undefined)} className="max-w-3xl">
          {saveError && (
            <p className="mb-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
              {saveError}
            </p>
          )}
          <WorkflowEditor
            workflow={editing}
            initial={seed}
            onSave={save}
            onCancel={() => setEditing(undefined)}
          />
        </Dialog>
      )}

      {picking && (
        <Dialog onClose={() => setPicking(false)} className="max-w-2xl">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="text-[13px] font-medium tracking-wide text-ink">从 SOP 模板新建</h3>
              <p className="text-[11px] text-ink-faint">
                模板只预填阶段序列与「要干什么」；阶段绑定的智能体是本机配置，进编辑器后自行选择再保存。
              </p>
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {SOP_TEMPLATES.map((template) => (
                <li key={template.id}>
                  <button
                    type="button"
                    aria-label={`使用模板 ${template.name}`}
                    className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-focus/60 focus-visible:outline-none"
                    onClick={() => openTemplate(template)}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-ink">
                      {template.name}
                      <span className="rounded-sm bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-faint">
                        {template.stages.length} 阶段
                      </span>
                    </span>
                    <span className="text-[11px] text-ink-dim">{template.description}</span>
                    <span className="text-[11px] text-ink-faint">{template.basis}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end">
              <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
                取消
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}
