# shadcn 迁移契约（历史记录）

> 本轮迁移已落地（2026-11-09）。保留本文件作为迁移期的写法约定与踩坑记录，供后续加组件时对照。
> 当前口径以 [SPEC-ui.md](./SPEC-ui.md) 为准；新加组件直接参照上游 registry。

> 组件基座已落在 `src/renderer/src/components/ui/`，**调用点一律用上游 API**。
> 不要再引入项目自研的中间封装（options 数组式 Select、title/onClose 式 Dialog 等一律废除）。

## 1. Button（上游 `components/ui/button.tsx`）

- 变体：`default | destructive | outline | secondary | ghost | link`
- 尺寸：`default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg`
- 迁移映射：
  - `variant="primary"` → `variant="default"`
  - `variant="secondary"` → 保持 `variant="secondary"`
  - `variant="ghost"` → 保持 `variant="ghost"`
  - 不写 variant 的旧调用点：旧默认是 secondary，补上显式 `variant="secondary"`（保住原有中性观感）
  - `size="md"` → 去掉该属性（上游默认即 default）；`size="sm"` / `size="lg"` 保持
- 其它属性（`className`、`aria-*`、`onClick`、`type`、`disabled`）原样透传。

## 2. Input / Textarea（上游 `components/ui/input.tsx` / `textarea.tsx`）

- `<Input ... />` 用法不变；上游自带 `h-9 w-full rounded-md border border-input`。
- 项目旧的 `fieldCls` / `inputCls` 导出**删除**。凡是 `<textarea className={cn(fieldCls, '...')}>` 一律改成：

```tsx
<Textarea className="min-h-20 resize-y" ...其余属性照搬 />
```

- 上游 Textarea 已含 `w-full rounded-md border border-input px-3 py-2`，不要再重复写这些类。
- 旧的 `min-h-20` / `min-h-24` / `resize-y` / `py-2` / `font-mono` 等自定义类保留（`py-2` 可去掉，上游已有）。

- `labelCls`（来自 `components/ui/field.tsx`）在 **field.tsx 之外**不再使用：
  - 有 `htmlFor` 的标签 → 改用上游 `<Label htmlFor="...">`（`import { Label } from '../../../components/ui/label'`）
  - 只是文字说明、不是表单标签的 `<span className={labelCls}>` → 改成 `<span className="text-sm font-medium text-muted-foreground">`

## 3. Select（上游 `components/ui/select.tsx`，Radix）

上游是复合 API。标准写法：

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'

;<Select value={v} onValueChange={(next) => setV(next)}>
  <SelectTrigger aria-label="运行时执行器" className="w-full">
    <SelectValue placeholder="请选择" />
  </SelectTrigger>
  <SelectContent>
    {options.map((o) => (
      <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
        {o.label}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

规则：

- 旧的 `ariaLabel="X"` → `<SelectTrigger aria-label="X">`
- 旧的 `options={[{ value, label, disabled }]}` → 展开成 `SelectItem` 子节点；`value`/`label`/`disabled` 语义不变
- 旧的 `placeholder="X"` → `<SelectValue placeholder="X" />`
- 旧的 `disabled` → 放在 `<Select disabled>` 上（Radix Root 支持 `disabled`），或 `<SelectTrigger disabled>`
- 旧的 `className` → 放在 `<SelectTrigger className=...>` 上
- **空值项（`value: ''`）**：上游 Radix 在 `value === ''` 时触发器显示 `SelectValue` 的 placeholder 文案。
  所以当选项列表里含 `{ value: '', label: '未设置' }` 这类条目时：
  - `<SelectValue placeholder="未设置" />`（placeholder 文案 = 该空值项的 label）
  - 该条目仍写成 `<SelectItem value="">未设置</SelectItem>`
    观感与迁移前一致（触发器显示「未设置」）。
- 触发器宽度：上游默认 `w-fit`，旧实现是 `w-full`。凡是旧调用点期望整行宽度的，加 `className="w-full"`；期望内容宽度的保留原 className。
- 旧的 `value` 一定给字符串；不要传 `undefined`。

## 4. Dialog（上游 `components/ui/dialog.tsx`，Radix）

上游是复合 API。标准写法：

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog'

;<Dialog
  open
  onOpenChange={(next) => {
    if (!next) onClose()
  }}
>
  <DialogContent className="max-w-2xl">
    <DialogHeader>
      <DialogTitle>新建规则</DialogTitle>
    </DialogHeader>
    ...原来的 children...
  </DialogContent>
</Dialog>
```

规则：

- 旧的 `title="X"` → `<DialogTitle>X</DialogTitle>`，并用 `<DialogHeader>` 包裹
- 旧的 `onClose` → `onOpenChange` 里在 `next === false` 时调用 `onClose`
- 旧的 `className` → `<DialogContent className=...>`
- 旧弹窗里自绘的「图标 + 标题 + 副标题」头部 → 改成 `<DialogHeader>` + `<DialogTitle>` + `<DialogDescription>`
- 没有可见标题的弹窗 → 放一个 `<DialogTitle className="sr-only">…</DialogTitle>`，保证无障碍名称
- 弹窗内原来的 `<form>` 等内容保持不变，放在 `DialogContent` 里

## 5. 不动的项目覆盖层（不要改其 API）

- `components/ui/field.tsx`：`Field`（label / required / hint / error）保持扁平 API 与 §11 语义（红星 + sr-only「必填」+ `role="alert"`）
- `components/ui/panel.tsx`：`Panel` / `panelCls` / `badgeCls` 保持
- `components/ui/menu.tsx`：保持（但其 `variant` 取值需与新 Button 对齐，见下）
- `components/ui/segmented.tsx`、`form-error.tsx`、`error-boundary.tsx`：保持

`components/ui/menu.tsx` 的 `variant` 允许值随 Button 变为 `default | secondary | ghost` 等；
`WorkflowManager.tsx` 里的 `variant="primary"` 改成 `variant="default"`。

## 6. 测试改动规则

- 测试文件与源码同构镜像：`src/renderer/src/apps/...` ↔ `tests/renderer/src/apps/...`
- 改断言时**数量不得减少**（floor-guard 会拦），优先等义替换
- Select 触发器相关断言注意：
  - 旧断言 `expect(combobox).toHaveValue('r1')` → 上游触发器没有 `value` 属性，改成断言可见文案
    （`expect(combobox).toHaveTextContent('标签')`），或断言对应 `SelectItem` 的 `data-state="checked"`
  - 旧断言 `expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')` → 上游触发器没有该属性，改断言 `aria-expanded`
  - 旧断言 `expect(option).toHaveAttribute('aria-selected', 'true')` → 仍然成立（Radix 选中项 `aria-selected="true"`、`data-state="checked"`）
- Radix Select / Dialog 在 jsdom 下需要环境垫片，已加到 `vitest.setup.ts`（`ResizeObserver`、`hasPointerCapture`、`setPointerCapture`、`releasePointerCapture`、`scrollIntoView`），测试里不要再自己打桩
- Radix Select 内容渲染在 portal 里，`screen.getByRole('option')` 可用；不要用 `container.querySelector` 找选项
- 不许跳过用例、不许删断言、不许改测试预期来掩盖实现问题

## 7. 边界

- 只改自己负责的文件；不要动 `src/renderer/src/components/ui/**`、`tests/renderer/src/components/ui/**`、`docs/**`、`scripts/**`、`vitest.setup.ts`
- 不要 `git commit`
- 改完跑：`npx vitest run <自己负责的测试文件>`
