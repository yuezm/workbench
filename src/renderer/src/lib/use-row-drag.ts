import { useState, type DragEvent } from 'react'

/**
 * 行内拖拽排序（智能体 / 工作流 / 工作流阶段共用）。
 *
 * 用原生 HTML5 拖拽，与看板（`KanbanBoard` 的任务卡）同一套做法：整行既是拖拽源也是落点，
 * 「正在拖谁」由 React 状态记住，不依赖 `dataTransfer`——同一次拖拽不会跨出清单，
 * 也就不需要在 drop 时解析传输数据（拖到应用外自然失效）。
 *
 * 落点语义是「占位」：把拖拽源挪到落点行当前的下标（`arrayMove`），不是交换。
 * 首尾 / 拖到自己身上 / 没有拖拽源时的落点一律不算数，由调用方的纯函数再兜一层。
 */
export interface RowDragProps {
  draggable: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent<HTMLElement>) => void
}

export interface RowDrag {
  /** 正在拖的行（渲染半透明，表示这是拖拽源） */
  draggingId: string | null
  /** 当前悬停的落点行（渲染高亮，表示松手就落在这里） */
  overId: string | null
  /** 一行的拖拽属性：整行可拖，落点在同清单内的另一行 */
  rowProps: (id: string) => RowDragProps
}

/**
 * `commit(from, to)` 只在「拖拽源与落点都存在且不同」时调用一次；
 * 参数是行 id，重排规则（下标怎么挪、流转目标怎么重映射）留在调用方的纯函数里。
 */
export function useRowDrag(commit: (from: string, to: string) => void): RowDrag {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const stop = (): void => {
    setDraggingId(null)
    setOverId(null)
  }

  return {
    draggingId,
    overId,
    rowProps: (id) => ({
      draggable: true,
      onDragStart: () => {
        setDraggingId(id)
        // 上一次拖拽留下的落点不能跟着新一轮：否则一按下就有一行莫名高亮
        setOverId(null)
      },
      onDragEnd: stop,
      onDragOver: (event) => {
        // 没有拖拽源（别的窗口 / 文件拖进来）或悬停自己时不接落点：
        // 不 preventDefault 就不会产生 drop，也不会给自己画高亮
        if (draggingId === null || draggingId === id) return
        event.preventDefault()
        setOverId(id)
      },
      onDragLeave: () => {
        // 只在离开的是当前落点时才清：行内子元素之间的移动不该把高亮抖掉
        setOverId((prev) => (prev === id ? null : prev))
      },
      onDrop: (event) => {
        event.preventDefault()
        const from = draggingId
        stop()
        if (from === null || from === id) return
        commit(from, id)
      },
    }),
  }
}
