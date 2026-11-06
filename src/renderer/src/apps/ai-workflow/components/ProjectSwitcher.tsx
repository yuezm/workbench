import type { ReactElement } from 'react'
import type { Project } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/cn'

/**
 * 「未归属」哨兵 id（M10 边界）：老数据 / 老规则建的任务没有项目（`projectId: null`），
 * 它们不属于任何真实项目，又不能在界面上消失，所以在项目列表末尾挂一行伪项目。
 * 用它当选中值（不可能与真实 id 撞车），页面据此把任务来源切成 `tasks.unassigned`。
 */
export const UNASSIGNED_PROJECT_ID = '__unassigned__'

export interface ProjectSwitcherProps {
  projects: Project[]
  /** 当前选中项：项目 id 或 `UNASSIGNED_PROJECT_ID`；未选中（或已失效）时为空 */
  activeId: string | undefined
  /** 未归属任务数：0 时不渲染「未归属」行（没有老数据就不必占一行） */
  unassignedCount: number
  onSelect: (id: string) => void
  onCreate: () => void
  onEdit: (project: Project) => void
}

/** 行样式：选中态沿用会话清单的高亮（两侧都靠这层圆角底色表达「当前在哪」） */
const rowCls = (isActive: boolean): string =>
  cn(
    'flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-2.5 py-2 text-left text-sm',
    'transition-colors duration-200 outline-none',
    'focus-visible:ring-2 focus-visible:ring-focus/60',
    isActive
      ? 'bg-surface-3 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/6%)]'
      : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink',
  )

/**
 * 任务栏侧栏的项目列表（M10）：项目是任务的容器，所以它排在任务栏最上面，
 * 工作流切换器在它下面——先选「在哪个文件夹里干活」，再选「按哪套流程」。
 *
 * 每行两段文字（名字 + 文件夹路径）沿用会话清单的行样式：路径只是让人认出是哪个
 * 项目，超长一律截断，不换行也不出横向滚动条。
 * 列表末尾的「未归属」是只读聚合，没有文件夹也没有编辑入口（它不对应任何项目行）。
 */
export function ProjectSwitcher({
  projects,
  activeId,
  unassignedCount,
  onSelect,
  onCreate,
  onEdit,
}: ProjectSwitcherProps): ReactElement {
  const showUnassigned = unassignedCount > 0
  const unassignedActive = activeId === UNASSIGNED_PROJECT_ID

  return (
    <section aria-label="项目列表" className="flex min-h-0 flex-col gap-1.5">
      <div className="flex shrink-0 items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-medium tracking-wide text-ink-faint">项目</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={onCreate}
        >
          + 添加
        </Button>
      </div>

      {projects.length === 0 && !showUnassigned ? (
        // 空态两行：是什么 + 怎么开始；添加入口在上面的标题行，这里不重复放按钮
        <div className="rounded-xl border border-dashed border-line px-2.5 py-3 text-center text-[11px] leading-relaxed text-ink-faint">
          <p>还没有项目</p>
          <p>添加本地文件夹作为项目</p>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-col gap-1 overflow-auto">
          {projects.map((project) => {
            const isActive = project.id === activeId
            return (
              <li key={project.id} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={`项目：${project.name}`}
                  className={rowCls(isActive)}
                  onClick={() => onSelect(project.id)}
                >
                  <span className="w-full truncate font-medium">{project.name}</span>
                  <span className="w-full truncate text-[11px] text-ink-faint">{project.path}</span>
                </button>

                {/* 编辑只挂在选中项上：项目列表很短，常驻按钮反而挤掉路径 */}
                {isActive && (
                  <button
                    type="button"
                    aria-label={`编辑项目 ${project.name}`}
                    className={cn(
                      'shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint',
                      'transition-colors duration-150 outline-none',
                      'hover:bg-white/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/60',
                    )}
                    onClick={() => onEdit(project)}
                  >
                    编辑
                  </button>
                )}
              </li>
            )
          })}

          {showUnassigned && (
            // 伪项目：只用来查看 / 处理没有项目的老任务，所以没有编辑与文件夹
            <li className="flex items-center gap-1">
              <button
                type="button"
                aria-current={unassignedActive ? 'page' : undefined}
                aria-label="未归属"
                className={rowCls(unassignedActive)}
                onClick={() => onSelect(UNASSIGNED_PROJECT_ID)}
              >
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium">未归属</span>
                  <span className="shrink-0 rounded-sm bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-ink-dim tabular-nums">
                    {unassignedCount}
                  </span>
                </span>
                <span className="w-full truncate text-[11px] text-ink-faint">没有项目的任务</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
