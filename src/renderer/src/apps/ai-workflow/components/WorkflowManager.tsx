import { useState, type ReactElement } from 'react'
import type { WorkflowInput, WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { FormError } from '../../../components/ui/form-error'
import { Menu } from '../../../components/ui/menu'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelView, useKernelViewState } from '../../../shell/useKernelView'
import { SOP_TEMPLATES, draftFromTemplate, type SopTemplate } from '../model/sop-templates'
import { dropVanishedStages } from '../model/stage-draft'
import { WorkflowEditor } from './WorkflowEditor'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 设置区的工作流清单：新建 / 选择 / 编辑工作流定义。
 *
 * 自己订阅 `workflows.all` 并维护「当前」选中（首个工作流为默认；新建成功后用
 * `dispatch` 返回的实体选中新建项）。新建/编辑共用一个弹窗，保存命令也在这里发，
 * 页面不再传任何 props。
 *
 * 新建只有一个入口：点「新建工作流」展开下拉，取空白草稿（只有四个内置阶段）或某条
 * 开箱 SOP 模板（产品发现 / 研发交付 / 测试质量 / 发版运维 / 事故复盘 / 迭代回顾）。
 * 模板只把阶段序列与每阶段「要干什么」预填进同一个编辑器，保存前不落库；阶段绑定的
 * 智能体是本机配置，模板不替用户做主。
 *
 * M18：每个工作流恒有四个内置阶段（待办 / 已阻塞 / 已完成 / 已取消），名称与位置锁定，
 * 自己添加的阶段落在「待办」与「已阻塞」之间。
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
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 删除失败（与保存错误分开，避免同屏互相覆盖） */
  const [actionError, setActionError] = useState<string | null>(null)

  const activeId =
    selectedId !== null && workflows.some((w) => w.id === selectedId)
      ? selectedId
      : workflows[0]?.id
  /** M23：当前工作流的阶段指标（只读派生；没有选中时暂不订阅） */
  const metrics = useKernelView(
    'workflow.stage-metrics',
    activeId === undefined ? null : { workflowId: activeId },
  )
  const measured = (metrics?.stages ?? []).filter(
    (stage) => stage.runs > 0 || stage.asks > 0 || stage.humanComments > 0,
  )

  const openEditor = (workflow: WorkflowWithStages | null): void => {
    setSaveError(null)
    setSeed(null)
    setEditing(workflow)
  }

  /** 选中模板：直接打开编辑器并预填（保存与否由用户在编辑器里决定） */
  const openTemplate = (template: SopTemplate): void => {
    setSaveError(null)
    setSeed(draftFromTemplate(template))
    setEditing(null)
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
        // 编辑期间别处可能删过阶段（本机迁移脚本 / 另一个窗口）：一次性查询里拿到最新定义，
        // 把草稿里已经不存在的阶段过滤掉再提交。不过滤的话内核按「阶段 id 不存在」整份拒收，
        // 界面上只剩一个 uuid，用户只能重启应用。
        const latest = await store.query('workflows.all').catch(() => null)
        const live = latest?.find((item) => item.id === editing.id)
        const stages =
          live === undefined
            ? input.stages
            : dropVanishedStages(input.stages, new Set(live.stages.map((s) => s.id)))
        await store.dispatch({
          type: 'workflow.update',
          commandId: '',
          id: editing.id,
          input: { ...input, stages },
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
      {/* 写命令失败可以关掉；读视图失败是持续状态，不给关闭入口 */}
      <FormError
        message={actionError ?? readError}
        onDismiss={actionError === null ? undefined : () => setActionError(null)}
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-faint-foreground">阶段序列与流转</p>
        {/* 一个入口两种建法：空白起手，或按 SOP 模板预填阶段 */}
        <Menu
          label="新建工作流"
          variant="default"
          sections={[
            {
              items: [
                {
                  id: 'blank',
                  label: '从空白创建',
                  description: '内置待办 / 已阻塞 / 已完成 / 已取消，自己往中间加阶段',
                  ariaLabel: '从空白创建工作流',
                  onSelect: () => openEditor(null),
                },
              ],
            },
            {
              title: 'SOP 模板',
              items: SOP_TEMPLATES.map((template) => ({
                id: template.id,
                label: template.name,
                badge: `${template.stages.length} 阶段`,
                description: template.description,
                ariaLabel: `使用模板 ${template.name}`,
                onSelect: () => openTemplate(template),
              })),
            },
          ]}
        />
      </div>

      {workflows.length === 0 ? (
        <p className="grid place-items-center rounded-xl border border-dashed border-border py-6 text-sm text-faint-foreground">
          暂无工作流
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {workflows.map((w) => {
            const active = w.id === activeId
            return (
              <li
                key={w.id}
                className={
                  active
                    ? 'flex items-center gap-3 bg-primary/[0.06] px-4 py-3'
                    : 'flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent'
                }
              >
                <button
                  type="button"
                  aria-label={`选择工作流 ${w.name}`}
                  className="flex min-w-0 flex-1 flex-col items-start text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  onClick={() => setSelectedId(w.id)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {w.name}
                    {active && (
                      <span className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-xs text-brand">
                        当前
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-faint-foreground">
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
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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

      {measured.length > 0 && (
        <section className="rounded-xl border border-border">
          <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-2">
            <h3 className="text-xs font-medium text-foreground">阶段指标</h3>
            <p className="text-xs text-faint-foreground">累计值，用来判断哪条流程真的在自动跑</p>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-faint-foreground">
                <th className="px-4 py-1.5 font-normal">阶段</th>
                <th className="px-2 py-1.5 text-right font-normal">轮次</th>
                <th className="px-2 py-1.5 text-right font-normal">平均轮数</th>
                <th className="px-2 py-1.5 text-right font-normal">降级</th>
                <th className="px-2 py-1.5 text-right font-normal">问人</th>
                <th className="px-4 py-1.5 text-right font-normal">人评</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {measured.map((stage) => (
                <tr key={stage.stageId} className="text-foreground">
                  <td className="px-4 py-1.5">{stage.stageName}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{stage.runs}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{stage.avgRounds}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{stage.degraded}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{stage.asks}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{stage.humanComments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {editing !== undefined && (
        <Dialog
          open
          onOpenChange={() => {
            // Radix 受控弹窗无 Trigger：dismiss 只会发 false，故直接收口
            setEditing(undefined)
          }}
        >
          {/* 宽度必须带 sm: 前缀：基座里的是 sm:max-w-lg，裸 max-w-3xl 跟它不同变体、合不掉，
              窄屏保底 max-w-[calc(100%-2rem)] 也会被覆盖。内容高，交给弹窗自己滚动。 */}
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
            {/* 标题由编辑器自己画（图标 + 「工作流定义」），这里只补一个无障碍名称 */}
            <DialogHeader>
              <DialogTitle className="sr-only">工作流定义</DialogTitle>
            </DialogHeader>
            <FormError message={saveError} className="mb-3" />
            <WorkflowEditor
              workflow={editing}
              initial={seed}
              onSave={save}
              onCancel={() => setEditing(undefined)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
