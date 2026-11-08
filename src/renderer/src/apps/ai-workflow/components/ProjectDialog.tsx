import { useState, type ReactElement } from 'react'
import type { Project, ProjectInput } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { Input, fieldCls } from '../../../components/ui/input'
import { cn } from '../../../lib/cn'

export interface ProjectDialogProps {
  /** 编辑态传入现有项目；新建时省略 */
  project?: Project
  onSave: (input: ProjectInput, id?: string) => Promise<void>
  /** 编辑态才给：删除项目（项目下还有任务时内核会拒绝，错误由父级展示） */
  onRemove?: (id: string) => Promise<void>
  onCancel: () => void
}

const textareaCls = cn(fieldCls, 'min-h-20 resize-y py-2')

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 路径最后一段用来预填项目名：`D:\Codes\workbench` → `workbench`。
 * 分隔符两种都认（Windows 反斜杠 + POSIX 斜杠），尾部斜杠先丢掉，避免取到空串。
 */
function folderName(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? path
}

/**
 * 新建 / 编辑项目弹窗（M10）。
 *
 * 为什么路径只能从选择器来：项目文件夹就是该项目任务的运行工作目录，手输错一个字符
 * 就变成另一个目录，所以提供「选择文件夹」走宿主原生对话框；输入框仍可改（测试/粘贴用）。
 * 名称留空时按目录名预填，减少一次输入。
 */
export function ProjectDialog({
  project,
  onSave,
  onRemove,
  onCancel,
}: ProjectDialogProps): ReactElement {
  const editing = project !== undefined
  const [name, setName] = useState(project?.name ?? '')
  const [path, setPath] = useState(project?.path ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 名称与路径都是内核必填：任一为空时保存不可点 */
  const canSave = name.trim() !== '' && path.trim() !== ''

  const chooseFolder = (): void => {
    void (async () => {
      try {
        const picked = await window.workbench.pickFolder()
        // 取消不算错误：什么都不改
        if (picked === null) return
        setPath(picked)
        if (name.trim() === '') setName(folderName(picked))
      } catch (e) {
        setError(errMsg(e))
      }
    })()
  }

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await onSave(
        { name: name.trim(), path: path.trim(), description: description.trim() },
        project?.id,
      )
    } catch (e) {
      // 父级同时把文案挂到页面顶部错误条；这里就地再显示一次，弹窗不关
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = (): void => {
    if (onRemove === undefined || project === undefined) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        await onRemove(project.id)
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Dialog title={editing ? '编辑项目' : '新建项目'} onClose={onCancel}>
      <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <Field label="项目名称">
          <Input
            aria-label="项目名称"
            placeholder="用来区分项目的名字"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <div className="flex items-end gap-2">
          <Field label="文件夹路径" className="min-w-0 flex-1">
            <Input
              aria-label="文件夹路径"
              className="font-mono text-body"
              placeholder="D:\\Codes\\workbench"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={chooseFolder}
          >
            选择文件夹
          </Button>
        </div>

        <Field label="备注">
          <textarea
            aria-label="项目备注"
            className={textareaCls}
            placeholder="这个项目在做什么（可空）"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <p className="text-meta text-ink-faint">项目文件夹就是该项目任务的运行工作目录。</p>

        {error && (
          <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-body text-red-300">
            {error}
          </p>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          {/* 删除只在编辑态出现，放左边：与右侧的「取消 / 保存」隔开，避免误点 */}
          <div>
            {editing && onRemove !== undefined && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-300 hover:bg-red-400/10 hover:text-red-300"
                disabled={busy}
                onClick={remove}
              >
                删除项目
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || !canSave}
              className="disabled:opacity-40"
            >
              保存
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
