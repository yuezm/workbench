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
import { FormError } from './form-error'

export interface FolderPickerDialogProps {
  /** 起始目录；缺省由宿主给主目录 */
  start?: string
  /**
   * 列一层目录（`window.workbench.listDirs` 或测试替身）。
   *
   * 由调用方注入而不是组件自己去摸桥接：这个选择器要能同时服务项目弹窗、智能体
   * 工作目录等处的调用点，并且单测可以直接喂假目录树。
   */
  list: (path?: string) => Promise<DirListing>
  /** 选中的绝对路径 */
  onPick(path: string): void
  onCancel(): void
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 文件夹选择器（覆盖层组件）：上一级 + 盘符 + 子目录列表 + 「选这个文件夹」。
 *
 * 上游 shadcn/ui 没有文件/目录选择器（浏览器读不到本机文件系统），所以这里用上游
 * `Dialog` + `Button` 拼出来，不另造弹窗底座：模态语义、焦点锁、Esc 收口都归 Radix。
 *
 * 盘符来自 `listing.roots`：盘根没有上一级，不给跨盘入口就够不到别的盘（曾经只能
 * 在 C: 里上下走，D: 盘的项目永远选不到）。
 *
 * 只列目录不列文件：项目路径与工作目录都是文件夹。列不出来就原地给可读错误
 * （权限 / 不存在），弹窗不关、当前目录不丢，用户可以退到上一级再试。
 *
 * 状态只有「已列出的目录」与「错误」两份：加载中由 `listing === null && error === null`
 * 派生，不再单独存一个 `loading`（省掉一次同步 setState，也少一个会不同步的真相源）。
 */
export function FolderPickerDialog({
  start,
  list,
  onPick,
  onCancel,
}: FolderPickerDialogProps): ReactElement {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (path?: string): Promise<void> => {
      try {
        setListing(await list(path))
        setError(null)
      } catch (e) {
        setError(errorText(e))
      }
    },
    [list],
  )

  useEffect(() => {
    // 只在打开时定位一次；之后翻目录由用户点击驱动。
    // 放到微任务里：effect 同步阶段改 state 会触发级联渲染（与 FeishuConnections 同一写法）
    void Promise.resolve().then(() => load(start))
  }, [load, start])

  const loading = listing === null && error === null
  const parent = listing?.parent ?? null
  const entries = listing?.entries ?? []
  const roots = listing?.roots ?? []
  /** 当前目录落在哪个根下（盘根高亮那一枚，让「我在哪个盘」一眼可见） */
  const onRoot = (root: string): boolean =>
    listing !== null && listing.path.toLowerCase().startsWith(root.toLowerCase())

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
          <DialogTitle>选择文件夹</DialogTitle>
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

          {/*
            跨盘入口。盘根的 `parent` 是 null，「上一级」到此为止，只靠目录列表就在
            一个盘里打转。`roots` 由宿主给（Windows 列现有盘符），只有一枚时不占地方。
          */}
          {roots.length > 1 && (
            <div role="group" aria-label="盘符" className="flex flex-wrap items-center gap-1.5">
              {roots.map((root) => (
                <Button
                  key={root}
                  type="button"
                  variant={onRoot(root) ? 'secondary' : 'quiet'}
                  size="xs"
                  aria-current={onRoot(root) ? 'true' : undefined}
                  aria-label={`切换到 ${root}`}
                  onClick={() => {
                    void load(root)
                  }}
                >
                  <span className="font-mono">{root}</span>
                </Button>
              ))}
            </div>
          )}

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
