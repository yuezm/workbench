import { useMemo, useState, type ReactElement } from 'react'
import type { RulePreviewArgs } from '../../../../../protocol/views'
import { useKernelView } from '../../../shell/useKernelView'
import { Button } from '../../../components/ui/button'
import { Field } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import { Panel } from '../../../components/ui/panel'

/**
 * 规则预演面板（M36-F）：填一条事件样本 → 显示「会被哪几条规则接、落到哪个阶段」。
 *
 * 只读：预演走 `rules.preview` 视图（内核纯函数），不建线程、不建任务、不记事实；
 * 停用规则也会列出来（标「已停用」），否则用户看到「没有规则会接」会误判是条件写错了。
 */
export function RulePreviewPanel(): ReactElement {
  const [source, setSource] = useState('github')
  const [type, setType] = useState('issues.opened')
  const [subject, setSubject] = useState('#42 示例')
  const [sample, setSample] = useState<RulePreviewArgs | null>(null)

  const preview = useKernelView('rules.preview', sample)
  const matches = useMemo(() => preview?.matches ?? [], [preview])

  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="来源" className="w-32">
          <Input
            aria-label="事件来源"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
        </Field>
        <Field label="类型" className="w-44">
          <Input
            aria-label="事件类型"
            value={type}
            onChange={(event) => setType(event.target.value)}
          />
        </Field>
        <Field label="对象" className="min-w-48 flex-1">
          <Input
            aria-label="事件对象"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() =>
            setSample({ source: source.trim(), type: type.trim(), subject: subject.trim() })
          }
        >
          试跑
        </Button>
      </div>

      {sample !== null && preview !== undefined && (
        <div className="flex flex-col gap-1.5 text-sm" role="status">
          {matches.length === 0 ? (
            <span className="text-muted-foreground">没有规则会接这条事件。</span>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">
                {preview?.wouldCreate === true
                  ? '会建任务：'
                  : '不会建任务（规则已停用或落点失效）：'}
              </span>
              <ul className="flex flex-col gap-1">
                {matches.map((match) => (
                  <li key={match.ruleId} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium text-foreground">{match.ruleName}</span>
                    {!match.enabled && (
                      <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-faint-foreground">
                        已停用
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {match.workflowId === null
                        ? '落点已失效'
                        : `→ ${match.stageId ?? match.workflowId}`}
                    </span>
                    <span className="text-xs text-faint-foreground">标题：{match.title}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Panel>
  )
}
