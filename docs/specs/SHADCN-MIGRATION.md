---
type: spec
status: active
owner: lead
updated: 2026-11-28
---

# shadcn 迁移契约（历史记录）

> 本轮迁移已落地（2026-11-09）。保留本文件作为迁移期的写法约定与踩坑记录，供后续加组件时对照。
> 当前口径以 [SPEC-ui.md](./SPEC-ui.md) 为准；新加组件直接参照上游 registry。

> 组件基座已落在 `packages/client/ui-primitives/src/`，**调用点一律用上游 API**。
> 不要再引入项目自研的中间封装（options 数组式 Select、title/onClose 式 Dialog 等一律废除）。

## 6. 测试改动规则

- 改断言时**数量不得减少**（floor-guard 会拦），优先等义替换
- Radix Select 内容渲染在 portal 里，`screen.getByRole('option')` 可用；不要用 `container.querySelector` 找选项
- 不许跳过用例、不许删断言、不许改测试预期来掩盖实现问题
