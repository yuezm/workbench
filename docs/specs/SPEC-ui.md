# Spec: UI 设计规则（workbench）

> Module id：`ui`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。确认日期：2026-11-07。
> 规则的事实来源是 `src/renderer/src/shell/styles/global.css` 的 `@theme`；本文件解释「为什么」与「怎么用」。
> `pnpm check:ui` 机器校验圆角、重玻璃、调色板与对比度；改 token 必须同步本文件。

## 1. 方向

中性石墨底 + 单一靛蓝主色，平面分层，克制质感。2026-11-07 起废弃上一版的「深空 + 极光渐变 + 玻璃拟态」：
下沉的紫底与大圆角在长时间使用里显得发闷，且大面积半透明层让正文对比度不可控。

三条硬取向：

1. **层次靠底色与描边，不靠模糊。** 四层实心底（abyss → surface → surface-2 → surface-3）+ 8%/16% 两档描边。
2. **圆角小一号。** 控件 6px、容器 10px、徽标 4px；胶囊按钮与 16px 卡片圆角不再使用。
3. **正文不许暗。** 三级前景的对比度下限写进检查脚本，不能靠调 opacity 或换底色绕过。

## 2. 色彩 token

| Token                     | 值                    | 用途                                 | 对 surface 的对比度 |
| ------------------------- | --------------------- | ------------------------------------ | ------------------- |
| `--color-abyss`           | `#0a0a0c`             | 窗口底色、顶部栏                     | —                   |
| `--color-surface`         | `#121214`             | 面板、看板列、侧栏、弹窗             | —                   |
| `--color-surface-2`       | `#19191d`             | 卡片、输入框、下拉、工具条           | —                   |
| `--color-surface-3`       | `#232329`             | 悬停 / 选中行 / 分段当前项           | —                   |
| `--color-ink`             | `#f4f4f6`             | 主文字：标题、正文、输入值           | 17.0:1              |
| `--color-ink-dim`         | `#c7c7d0`             | 次要文字：说明、字段值、未选中项     | 11.2:1              |
| `--color-ink-faint`       | `#8f8f9c`             | 辅助文字：占位符、时间戳、计数       | 5.9:1               |
| `--color-line`            | `white/8%`            | 常规描边、分隔线                     | —                   |
| `--color-line-strong`     | `white/16%`           | 悬停描边、浮层描边                   | —                   |
| `--color-focus`           | `#6366f1`             | 强调色**填充**：主按钮底、圆点、进度 | 白字 4.5:1          |
| `--color-focus-deep`      | `#4f46e5`             | 主按钮默认底、按下态                 | 白字 6.3:1          |
| `--color-focus-soft`      | `#818cf8`             | 暗底上的强调**文字与图标**           | 6.3:1               |
| `--color-short` / `-deep` | `#34d399` / `#10b981` | 成功、已完成                         | 9.7:1               |
| `--color-long` / `-deep`  | `#38bdf8` / `#0ea5e9` | 信息、等待中                         | 8.7:1               |
| `--color-danger`          | `#f87171`             | 失败、危险操作                       | 6.8:1               |
| `--color-warn`            | `#fbbf24`             | 提权记录、提醒                       | 11.2:1              |

规则：

- **只用 token 类名**（`bg-surface-2` / `text-ink` / `border-line`）；tsx 里出现调色板之外的 `#rrggbb` 会被 `check:ui` 拦下。
- **主色只给可交互强调**：主按钮、当前选中、进行中、进度环。单屏主色面积控制在 10% 以内，不做大面积渐变与光斑。
- **`text-focus` 不可读**：暗底上的主色文字/图标一律 `text-focus-soft`；`focus` 只用于 `bg-`、`border-`、`ring-`。
- 语义色固定为成功 / 信息 / 危险 / 警告四组，不新增彩色。

## 3. 前景三级（对比度底线）

- `ink`：用户必须读到的东西 —— 标题、正文、**输入框里的值**、任务描述、运行输出正文。
- `ink-dim`：解释性文字 —— 字段值、辅助说明、未选中项、时间戳。
- `ink-faint`：装饰性/极次要 —— 占位符、计数、空态提示。

底线（`pnpm check:ui` 强制，分别对 `surface` 与 `surface-2` 计算）：

| 层级        | 最小对比度 |
| ----------- | ---------- |
| `ink`       | 12:1       |
| `ink-dim`   | 8:1        |
| `ink-faint` | 4.5:1      |

禁止：

- 用 `text-ink/60` 之类的透明度压暗文字来代替换层级 —— 对比度不可预测，也不进检查。
- 把正文放进 10px 字号再配 `ink-faint`。
- 输入框底色叠 `bg-black/*`：输入统一 `bg-surface-2`，文字 `text-ink`，占位符 `text-ink-faint`。

## 4. 圆角刻度

| Token         | 值   | 用在哪                                     |
| ------------- | ---- | ------------------------------------------ |
| `rounded-xs`  | 3px  | 极小内嵌块（少用）                         |
| `rounded-sm`  | 4px  | 徽标、标签、计数、键帽、小方块             |
| `rounded-md`  | 6px  | **按钮、输入、下拉、图标按钮、分段项**     |
| `rounded-lg`  | 8px  | 分段容器、工具条、代码块、消息气泡、小卡片 |
| `rounded-xl`  | 10px | 面板、卡片、看板列、列表块、弹窗           |
| `rounded-2xl` | 12px | 上限，仅页面级容器；默认不用               |

禁止：

- `rounded-3xl`、任意值 `rounded-[Npx]`、`rounded-[10px]` 这类硬编码 —— 全部走刻度。
- 矩形块用 `rounded-full`（胶囊按钮、胶囊标签）。`rounded-full` 只允许圆点（`size-*`）、开关滑块（`w-9`）、1px 线段端点。
- 调大刻度：`--radius-*` 只能收紧；`check:ui` 对 sm/md/lg/xl/2xl 设了上限（4/6/8/10/12）。

## 5. 质感

- 不叠玻璃：`backdrop-blur` 只允许弹窗遮罩（`components/ui/dialog.tsx`），其余一律实心底。
- 阴影只给浮层与弹窗（下拉、modal）；平面卡片用描边区分层级，不加投影。
- 不使用大面积模糊光斑、渐变背景、渐变按钮。品牌标记是实心主色方块。
- 动效克制：颜色/位移 150–200ms；只保留 `animate-rise`（浮层与卡片入场），不做漂移背景。

## 6. 字号与控件尺寸

- 正文 14px（`text-sm`）；次要 12px（`text-xs`）；元信息 11px；徽标 10–11px。10px 只允许放徽标，不放内容。
- 页面/区块标题：13px `font-medium`；卡片标题：14px `font-medium`。
- 控件高度：`sm` 32 / `md` 36 / `lg` 40；输入与下拉统一 36（`h-9`）。
- 间距基数 4px；列表行纵向 12–16px；面板内边距 12–20px。

## 7. 状态约定

| 状态          | 表达                                                                 |
| ------------- | -------------------------------------------------------------------- |
| hover         | `bg-surface-3`（有底色块）或 `bg-white/[0.06]`（无底色行）+ 描边加强 |
| 选中 / 当前   | `bg-surface-3 text-ink`；左侧栏与顶部栏保持一致                      |
| focus-visible | `ring-2 ring-focus/50`，弹窗与浮层加 `ring-offset-2 offset-abyss`    |
| disabled      | `opacity-40 cursor-not-allowed`，不再额外改文字色                    |
| 危险          | `text-danger` / `bg-danger/10` + `border-danger/30`                  |

## 8. 组件映射（`components/ui/`）

| 组件               | 关键类                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `Button`           | `rounded-md`；primary=实心 `bg-focus-deep`（hover `bg-focus`），secondary=`bg-surface-2 ring-1 ring-line`，ghost=纯文字 |
| `Input`            | `fieldCls`：`rounded-md border-line bg-surface-2 text-ink placeholder:text-ink-faint focus:ring-2 ring-focus/25`        |
| `Select`           | 触发器同 `Input`；浮层 `rounded-lg bg-surface border-line-strong/60`                                                    |
| `Panel` / `Dialog` | `rounded-xl bg-surface border-line`；弹窗遮罩 `bg-black/55 backdrop-blur-sm`                                            |
| `Segmented`        | 容器 `rounded-lg bg-surface-2`，选项 `rounded-md`，当前项 `bg-surface-3`                                                |
| `Field`            | 小标签 `text-[11px] text-ink-dim`                                                                                       |
| 徽标               | `badgeCls`：`rounded-sm bg-white/[0.07] text-[11px] text-ink-dim`                                                       |

## 9. 检查方式

```
pnpm check:ui   # 圆角越界 / rounded-full 误用 / 重玻璃 / 调色板外色值 / 圆角刻度上限 / 前景对比度
```

`check:ui` 已并入 `pnpm check:fast` 与 pre-commit。它只拦机械可判定的部分；下面这些靠 review：

- [ ] 重要文字用的是 `ink` 或 `ink-dim`，没有落进 `ink-faint`。
- [ ] 按钮、输入、下拉都是 `rounded-md`；没有胶囊按钮。
- [ ] 新面板用 `surface` 系实心底，没有新增半透明叠层或模糊。
- [ ] 主色只出现在强调位；一屏没有第二种彩色。
- [ ] 空态、错误态、禁用态三类都有对应 token，没有临时色值。

## 10. 反例（出现即改）

- 按钮 `rounded-xl` / `rounded-full`，卡片 `rounded-2xl`。
- 输入框 `bg-black/25` + `text-ink-faint` 占位符配 `text-ink/60` 输入值。
- 面板 `bg-white/[0.02] backdrop-blur-xl shadow-[...]` 三层叠加。
- 顶部栏 / 页面背景放大面积渐变或模糊光斑。
- 在组件里写 `#8b7cf7` 这类调色板外颜色。
