import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { DirListing } from '@workbench/protocol/http'
import { Button } from '@workbench/client-ui-primitives/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workbench/client-ui-primitives/dialog'
import { FormError } from '@workbench/client-ui-kit/form-error'

export interface FolderPickerDialogProps {
  /** 起始目录；缺省由服务端给主目录 */
  start?: string
  /** 选中的绝对路径 */
  onPick(path: string): void
  onCancel(): void
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 文件夹选择器（Web 形态的项目路径选择）。
 *
 * 桌面形态靠 `dialog.showOpenDialog`；浏览器读不到本机文件系统，所以由服务端列目录
 * （`/api/fs/dirs`）、这里画一层：上一级 + 子目录列表 + 「选这个文件夹」。
 *
 * 只列目录不列文件：项目 = 文件夹。列不出来就原地给可读错误（权限 / 不存在），
 * 弹窗不关、当前目录不丢，用户可以退到上一级再试。
 *
 * 状态只有「已列出的目录」与「错误」两份：加载中由 `listing === null && error === null`
 * 派生，不再单独存一个 `loading`（省掉一次同步 setState，也少一个会不同步的真相源）。
 */
export function FolderPickerDialog({
  start,
  onPick,
  onCancel,
}: FolderPickerDialogProps): ReactElement {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (path?: string): Promise<void> => {
    try {
      setListing(await window.workbench.listDirs(path))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  useEffect(() => {
    // 只在打开时定位一次；之后翻目录由用户点击驱动。
    // 放到微任务里：effect 同步阶段改 state 会触发级联渲染（与 FeishuConnections 同一写法）
    void Promise.resolve().then(() => load(start))
  }, [load, start])

  const loading = listing === null && error === null
  const parent = listing?.parent ?? null
  const entries = listing?.entries ?? []

  return (
    <Dialog
      open
      onOpenChange={() => {
        // 受控弹窗无 Trigger：dismiss 只会发 false，直接收口
        onCancel()
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>选择项目文件夹</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={parent === null}
              onClick={() => {
                void load(parent ?? undefined)
              }}
            >
              上一级
            </Button>
            <span
              aria-label="当前目录"
              title={listing?.path ?? ''}
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            >
              {listing?.path ?? '读取中…'}
            </span>
          </div>

          <ul
            aria-label="目录列表"
            className="max-h-64 min-h-24 overflow-y-auto rounded-md border border-border"
          >
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    void load(entry.path)
                  }}
                >
                  <span aria-hidden="true" className="text-muted-foreground">
                    📁
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
              </li>
            ))}
            {!loading && entries.length === 0 && error === null && (
              <li className="px-3 py-2 text-xs text-muted-foreground">这个目录下没有子目录</li>
            )}
          </ul>

          <FormError message={error} onDismiss={() => setError(null)} />

          <DialogFooter>
            <Button type="button" variant="quiet" onClick={onCancel}>
              取消
            </Button>
            <Button
              type="button"
              disabled={listing === null}
              onClick={() => {
                if (listing !== null) onPick(listing.path)
              }}
            >
              选这个文件夹
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
