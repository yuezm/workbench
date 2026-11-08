import { useState, type ReactElement } from 'react'
import type { Project, ProjectInput } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { FormError } from '../../../components/ui/form-error'
import { Input, fieldCls } from '../../../components/ui/input'
import { cn } from '../../../lib/cn'

export interface ProjectDialogProps {
  /** 编辑态传入现有项目；新建时省略 */
  project?: Project
  onSave: (input: ProjectInput, id?: string) => Promise<void>
  /** 编辑态才给：删除项目（项目下还有任务时内核会拒绝，错误就地展示） */
  onRemove?: (id: string) => Promise<void>
  onCancel: () => void
}

const textareaCls = cn(fieldCls, 'min-h-20 resize-y py-2')

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 内核必填的两个字段 */
type ProjectField = 'name' | 'path'

/** 字段 → 控件 aria-label（聚焦出错字段用） */
const FIELD_CONTROL: Record<ProjectField, string> = {
  name: '项目名称',
  path: '文件夹路径',
}

function focusControl(form: HTMLFormElement, label: string): void {
  form.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus()
}

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
 *
 * 名称与路径都是内核必填：未填时保存按钮禁用并写明原因；回车 / 程序化提交同样落到
 * 字段级错误（`role="alert"`）并把焦点移到第一个缺的控件。选择器失败、删除失败、保存
 * 失败的文案都留在各自触发点附近，弹窗不关、输入不丢。
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
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ProjectField, string>>>({})
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  /** 名称与路径都是内核必填：任一为空时保存不可点，但旁边写明为什么 */
  const canSave = name.trim() !== '' && path.trim() !== ''

  const clearError = (field: ProjectField): void => {
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  const validate = (): { field: ProjectField; message: string } | null => {
    if (name.trim() === '') return { field: 'name', message: '项目名称必填' }
    if (path.trim() === '') return { field: 'path', message: '文件夹路径必填' }
    return null
  }

  const chooseFolder = (): void => {
    void (async () => {
      setPickerError(null)
      try {
        const picked = await window.workbench.pickFolder()
        // 取消不算错误：什么都不改
        if (picked === null) return
        setPath(picked)
        clearError('path')
        if (name.trim() === '') setName(folderName(picked))
      } catch (e) {
        setPickerError(errMsg(e))
      }
    })()
  }

  const submit = async (ev: React.FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault()
    setSubmitError(null)
    const problem = validate()
    if (problem !== null) {
      setFieldErrors({ [problem.field]: problem.message })
      focusControl(ev.currentTarget, FIELD_CONTROL[problem.field])
      return
    }
    setFieldErrors({})

    setBusy(true)
    try {
      await onSave(
        { name: name.trim(), path: path.trim(), description: description.trim() },
        project?.id,
      )
    } catch (e) {
      // 父级同时把文案挂到页面顶部错误条；这里就地再显示一次，弹窗不关
      setSubmitError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  /** 删除：失败文案贴在删除按钮上方（它只属于这一个动作，不该混进保存错误） */
  const remove = (id: string, run: (target: string) => Promise<void>): void => {
    setBusy(true)
    setRemoveError(null)
    void (async () => {
      try {
        await run(id)
      } catch (e) {
        setRemoveError(errMsg(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Dialog title={editing ? '编辑项目' : '新建项目'} onClose={onCancel}>
      <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <Field label="项目名称" required hint="保存时去掉首尾空格" error={fieldErrors.name ?? null}>
          <Input
            aria-label="项目名称"
            placeholder="用来区分项目的名字"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              clearError('name')
            }}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-end gap-2">
            <Field
              label="文件夹路径"
              required
              hint="项目的运行工作目录：从选择器挑，或粘贴绝对路径"
              error={fieldErrors.path ?? null}
              className="min-w-0 flex-1"
            >
              <Input
                aria-label="文件夹路径"
                className="font-mono text-body"
                placeholder="D:\\Codes\\workbench"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value)
                  clearError('path')
                }}
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
          <FormError message={pickerError} onDismiss={() => setPickerError(null)} />
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

        <FormError message={submitError} onDismiss={() => setSubmitError(null)} />

        <div className="mt-2 flex flex-col gap-2">
          <FormError message={removeError} onDismiss={() => setRemoveError(null)} />
          <div className="flex items-center justify-between gap-2">
            {/* 删除只在编辑态出现，放左边：与右侧的「取消 / 保存」隔开，避免误点 */}
            <div>
              {project !== undefined && onRemove !== undefined && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:bg-danger/10 hover:text-danger"
                  disabled={busy}
                  onClick={() => remove(project.id, onRemove)}
                >
                  删除项目
                </Button>
              )}
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {!canSave && (
                <p className="text-meta text-ink-faint">名称与文件夹路径都必填，填好后才能保存。</p>
              )}
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
          </div>
        </div>
      </form>
    </Dialog>
  )
}
