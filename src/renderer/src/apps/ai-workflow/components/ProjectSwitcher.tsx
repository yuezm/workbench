import type { ReactElement } from 'react'
import type { Project } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/cn'

/**
 * 「默认目录」哨兵 id（M11）：聊天与任务都落在项目上，没有项目时落默认目录
 * （宿主的 `~/.workbench` / `WORKBENCH_WORKDIR`）。它不对应任何 `projects` 行，
 * 所以用不可能与真实 id 撞车的哨兵值表示选中态；数据侧用 `projectId = null` 表达。
 */
export const DEFAULT_PROJECT_ID = '__default__'

export interface ProjectSwitcherProps {
  projects: Project[]
  /** 当前选中项：项目 id 或 `DEFAULT_PROJECT_ID`；未选中（或已失效）时为空 */
  activeId: string | undefined
  /** 宿主默认目录的绝对路径（`runtimes.default-workdir` 视图）；空串表示未知 */
  defaultPath: string
  onSelect: (id: string) => void
  onCreate: () => void
  onEdit: (project: Project) => void
}

/** 行样式：选中态沿用会话清单的高亮（两侧都靠这层圆角底色表达「当前在哪」） */
const rowCls = (isActive: boolean): string =>
  cn(
    'flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-2.5 py-2 text-left text-sm',
    'transition-colors duration-200 outline-none',
    'focus-visible:ring-2 focus-visible:ring-ring/60',
    isActive
      ? 'bg-accent text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/6%)]'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  )

/**
 * 项目列表（M10；M11 提到顶层）：项目是聊天与任务的共同上下文，所以它排在栏目切换
 * 之上、常驻工作台——先定「在哪个文件夹里干活」，再选「聊天还是任务」。
 *
 * 每行两段文字（名字 + 文件夹路径）沿用会话清单的行样式：路径只是让人认出是哪个
 * 项目，超长一律截断，不换行也不出横向滚动条。
 * 列表末尾的「默认目录」是常驻落点（不是伪项目）：它没有 `projects` 行，因此没有编辑
 * 入口，路径来自宿主解析结果（未配置项目时运行目录就是它）。
 */
export function ProjectSwitcher({
  projects,
  activeId,
  defaultPath,
  onSelect,
  onCreate,
  onEdit,
}: ProjectSwitcherProps): ReactElement {
  const defaultActive = activeId === DEFAULT_PROJECT_ID

  return (
    <section aria-label="项目列表" className="flex shrink-0 flex-col gap-1.5">
      <div className="flex shrink-0 items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium text-faint-foreground">项目</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-sm"
          onClick={onCreate}
        >
          + 添加
        </Button>
      </div>

      <ul className="flex max-h-44 min-h-0 flex-col gap-1 overflow-auto">
        {projects.length === 0 && (
          // 空态一行：还没有项目时默认目录仍可用，添加入口在标题行，这里不重复放按钮
          <li className="rounded-xl border border-dashed border-border px-2.5 py-3 text-center text-sm text-faint-foreground">
            还没有项目，可先落到默认目录
          </li>
        )}

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
                <span className="w-full truncate text-xs text-faint-foreground">
                  {project.path}
                </span>
              </button>

              {/* 编辑只挂在选中项上：项目列表很短，常驻按钮反而挤掉路径 */}
              {isActive && (
                <button
                  type="button"
                  aria-label={`编辑项目 ${project.name}`}
                  className={cn(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-sm font-medium text-faint-foreground',
                    'transition-colors duration-150 outline-none',
                    'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60',
                  )}
                  onClick={() => onEdit(project)}
                >
                  编辑
                </button>
              )}
            </li>
          )
        })}

        <li className="flex items-center gap-1">
          {/* 默认目录：没有项目时的落点，聊天与任务共用；不对应项目行，所以没有编辑入口 */}
          <button
            type="button"
            aria-current={defaultActive ? 'page' : undefined}
            aria-label="默认目录"
            className={rowCls(defaultActive)}
            onClick={() => onSelect(DEFAULT_PROJECT_ID)}
          >
            <span className="w-full truncate font-medium">默认目录</span>
            <span className="w-full truncate text-xs text-faint-foreground">
              {defaultPath === '' ? '未配置项目时的工作目录' : defaultPath}
            </span>
          </button>
        </li>
      </ul>
    </section>
  )
}
