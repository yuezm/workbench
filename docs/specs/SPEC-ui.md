# Spec: UI 设计规则（workbench）

> Module id：`ui`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。确认日期：2026-11-09。
> **基线是 shadcn/ui v4**（`new-york-v4` 风格，Radix 基座）：token 语义、组件 API、类名约定一律以上游为准。
> 本文件只记录两件事：**上游基线之上本项目的覆盖层（overlay）**，以及**为什么**。
> 机器事实来源是 `src/renderer/src/shell/styles/global.css` 与 `scripts/check-ui-rules.mjs`；改 token 必须同步本文件。
> `pnpm check:ui` 机器校验圆角、调色板外色值、玻璃拟态与对比度；`pnpm check:floor` 校验本文件与 CONSTRAINTS 的门槛未被放松。

## 1. 方向与分层

基线换成 shadcn/ui v4 之后，本项目只做**主题层**与**覆盖层**，不再自造组件结构。

- **组件 API = 上游 API。** `components/ui/` 下的 `button` / `input` / `textarea` / `label` / `select` / `dialog` 是上游 v4 源码，只改 import 路径与 token 引用。调用点用上游复合 API（如 `<Select><SelectTrigger><SelectValue/>…`），不写项目自研的扁平封装。
- **为什么换基座。** 自研的 select / dialog 缺焦点陷阱、缺 `aria-modal`、缺键盘导航，BUG 集中在这些地方；上游是经过验证的实现，AI 辅助开发时也能对上上游文档与 registry。
- **主题层。** 上游 token 语义（`background` / `foreground` / `card` / `popover` / `primary` / `secondary` / `muted` / `accent` / `destructive` / `border` / `input` / `ring` / `radius`）原样保留，值由本项目决定。**双主题**：亮色值写在 `:root`（`.light` 同值），暗色值写在 `.dark`；`<html>` 上的 `light` / `dark` 类决定用哪一套，同时让组件里的 `dark:` 变体生效。用户在界面里选「亮色 / 暗色 / 跟随系统」，偏好存 localStorage（`src/renderer/src/lib/theme.ts`），渲染层偏好不进工作台事实日志。
- **覆盖层（本文件的重点）。** 上游没有、项目自己需要的部分，见 §4。

方向三条硬取向（不变）：

1. **层次靠底色与描边，不靠模糊。** 四层实心底 + 8%/16% 两档描边。
2. **圆角小一号。** 控件 6px、容器 10px、徽标 4px；胶囊按钮与 16px 卡片圆角不使用。
3. **正文不许暗。** 三级前景的对比度下限写进检查脚本，不能靠调 opacity 或换底色绕过。

## 2. 色彩 token（shadcn 基线）

变量与上游同名，值分两套：**亮色**写在 `:root, .light`，**暗色**写在 `.dark`。语义名与用途两套一致，只有值不同；`@theme inline` 的 `--color-*` 映射两套共用。

### 2.1 暗色主题（`.dark`）

| Token                      | 值          | 用途                             | 用途底上的对比度 |
| -------------------------- | ----------- | -------------------------------- | ---------------- |
| `--background`             | `#0a0a0c`   | 窗口底色、顶部栏                 | —                |
| `--foreground`             | `#f4f4f6`   | 主文字：标题、正文、输入值       | 17.0:1           |
| `--card`                   | `#121214`   | 面板、看板列、侧栏、弹窗         | —                |
| `--card-foreground`        | `#f4f4f6`   | 卡片内文字                       | —                |
| `--popover`                | `#121214`   | 下拉、菜单浮层                   | —                |
| `--popover-foreground`     | `#f4f4f6`   | 浮层内文字                       | —                |
| `--primary`                | `#4f46e5`   | 主按钮底、按下态                 | 白字 6.3:1       |
| `--primary-foreground`     | `#ffffff`   | 主色底上的文字                   | —                |
| `--secondary`              | `#19191d`   | 次要按钮底                       | —                |
| `--secondary-foreground`   | `#f4f4f6`   | 次要按钮文字                     | —                |
| `--muted`                  | `#19191d`   | 卡片、输入框、下拉、工具条       | —                |
| `--muted-foreground`       | `#c7c7d0`   | 次要文字：说明、字段值、未选中项 | 11.1:1           |
| `--accent`                 | `#232329`   | 悬停 / 选中行 / 分段当前项       | —                |
| `--accent-foreground`      | `#f4f4f6`   | 强调底上的文字                   | —                |
| `--destructive`            | `#f87171`   | 失败、危险操作                   | 6.8:1            |
| `--destructive-foreground` | `#ffffff`   | 危险底上的文字                   | —                |
| `--border`                 | `white/8%`  | 常规描边、分隔线                 | —                |
| `--input`                  | `white/16%` | 悬停描边、浮层描边、输入控件描边 | —                |
| `--ring`                   | `#6366f1`   | 焦点环                           | —                |

### 2.2 亮色主题（`:root, .light`）

| Token                      | 值          | 用途底上的对比度                |
| -------------------------- | ----------- | ------------------------------- |
| `--background`             | `#f5f5f7`   | —                               |
| `--foreground`             | `#17171a`   | 17.9:1（card）/ 15.9:1（muted） |
| `--card`                   | `#ffffff`   | —                               |
| `--card-foreground`        | `#17171a`   | —                               |
| `--popover`                | `#ffffff`   | —                               |
| `--popover-foreground`     | `#17171a`   | —                               |
| `--primary`                | `#4f46e5`   | 白字 6.3:1                      |
| `--primary-foreground`     | `#ffffff`   | —                               |
| `--secondary`              | `#eeeef2`   | —                               |
| `--secondary-foreground`   | `#17171a`   | —                               |
| `--muted`                  | `#f1f1f4`   | —                               |
| `--muted-foreground`       | `#43434d`   | 9.8:1（card）/ 8.7:1（muted）   |
| `--accent`                 | `#e9e9ee`   | —                               |
| `--accent-foreground`      | `#17171a`   | —                               |
| `--destructive`            | `#dc2626`   | 白字 4.8:1                      |
| `--destructive-foreground` | `#ffffff`   | —                               |
| `--border`                 | `black/10%` | —                               |
| `--input`                  | `black/16%` | —                               |
| `--ring`                   | `#6366f1`   | —                               |

规则：

- **只用 token 类名**（`bg-card` / `text-foreground` / `border-border`）；tsx 里出现调色板之外的 `#rrggbb` 会被 `check:ui` 拦下。
- **主色只给可交互强调**：主按钮、当前选中、进行中、进度环。单屏主色面积控制在 10% 以内，不做大面积渐变与光斑。
- **语义色固定为成功 / 信息 / 危险 / 警告四组**，不新增彩色。

## 3. 项目扩展 token（覆盖层）

上游基线没有三级前景与状态色，本项目补 5 个变量（`global.css` 的 `:root, .light` 与 `.dark` 两套，映射到 `@theme inline` 的 `--color-*`）：

| Token                | 暗色值（`.dark`） | 亮色值（`:root`） | 用途                             | 暗色 card/muted | 亮色 card/muted |
| -------------------- | ----------------- | ----------------- | -------------------------------- | --------------- | --------------- |
| `--faint-foreground` | `#8f8f9c`         | `#6b6b76`         | 第三级前景：占位符、时间戳、计数 | 5.9:1 / 5.5:1   | 5.3:1 / 4.7:1   |
| `--brand`            | `#818cf8`         | `#4338ca`         | 强调**文字与图标**               | 6.3:1 / 5.9:1   | 7.9:1 / 7.0:1   |
| `--success`          | `#34d399`         | `#15803d`         | 成功、已完成                     | 9.7:1 / 9.1:1   | 5.0:1 / 4.4:1   |
| `--info`             | `#38bdf8`         | `#0369a1`         | 信息、等待中                     | 8.7:1 / 8.2:1   | 5.9:1 / 5.3:1   |
| `--warning`          | `#fbbf24`         | `#b45309`         | 提权记录、提醒                   | 11.2:1 / 10.5:1 | 5.0:1 / 4.5:1   |

另有番茄钟渐变用的两个端点色：暗色 `--success-deep: #10b981` / `--info-deep: #0ea5e9`，亮色 `#047857` / `#075985`。

`--brand` 的存在理由：上游 `primary` 是深靛蓝（`#4f46e5`），在暗底上做**文字**对比度不够（4.5:1），做**填充**够。所以强调文字与图标一律 `text-brand`，`primary` 只用于 `bg-` / `border-` / `ring-`。

### 三级前景与对比度底线

- `foreground`：用户必须读到的东西 —— 标题、正文、**输入框里的值**、任务描述、运行输出正文。
- `muted-foreground`：解释性文字 —— 字段值、辅助说明、未选中项、时间戳。
- `faint-foreground`：装饰性/极次要 —— 占位符、计数、空态提示。

底线（`pnpm check:ui` 强制，分别对 `card` 与 `muted` 计算）：

| 层级               | 最小对比度 |
| ------------------ | ---------- |
| `foreground`       | 12:1       |
| `muted-foreground` | 8:1        |
| `faint-foreground` | 4.5:1      |
| `brand`            | 4.5:1      |

禁止：

- 用 `text-foreground/60` 之类的透明度压暗文字来代替换层级 —— 对比度不可预测，也不进检查。
- 把正文放进 10px 字号再配 `faint-foreground`。
- 输入框底色叠 `bg-black/*`。

### 阶段类别配色（M18）

工作流阶段按四类取色（`model/stage-kinds.ts` 的 `STAGE_KIND_META`，纯类名，不改 token）：

| 类别（`StageKind`） | 名称   | 圆点 / 强调           | 文字                    | 说明                                     |
| ------------------- | ------ | --------------------- | ----------------------- | ---------------------------------------- |
| `pending`           | 未开始 | `bg-muted-foreground` | `text-muted-foreground` | 内置「待办」                             |
| `active`            | 进行中 | `bg-brand`            | `text-brand`            | 内置「已阻塞」自己添加的阶段             |
| `done`              | 已完成 | `bg-success`          | `text-success`          | 内置「已完成」                           |
| `closed`            | 已关闭 | `bg-destructive`      | `text-muted-foreground` | 内置「已取消」（圆点用警示色区分于待办） |

- 颜色只出现在列头圆点与徽标底色（`/10`–`/15`），不铺满列背景，也不给卡片上色。
- 看板列头只显示阶段名 + 类别圆点，不挂类别文案（「待办」旁边不写「未开始」）；类别文案只出现在编辑器阶段详情的徽标上。
- 类别名固定用这四组中文，不出现在按钮上（阶段名才是可点对象）。

### 主题偏好（亮 / 暗 / 跟随系统）

- 偏好只有三档：**亮色 / 暗色 / 跟随系统**。存 localStorage 的 `workbench.theme`（渲染层自己的偏好，不进工作台事实日志）。
- 生效主题 = 偏好解析结果：跟随系统时读 `prefers-color-scheme`；用户在系统里改深浅色，窗口开着也要跟着变（媒体查询监听）。
- 落地方式：`<html>` 上挂 `light` / `dark` 类，token 与 `dark:` 变体随之切换。`initTheme()` 在渲染前调用，首帧不闪。
- 入口：`ThemeSwitcher`（图标按钮，hover 弹三个图标：亮色 / 暗色 / 跟随系统）。主题是**全局设置**，固定在 shell 顶部栏右侧，任何 app 都从这里切；app 侧栏里不再放第二份入口。
- 换主题只改 token：组件里不写任何按主题分支的样式。**app 内的颜色一律走 token**（含番茄钟的大号倒计时与进度环），不写死白/黑——写死就会在另一套主题下看不见。

## 4. 组件覆盖层（上游之上）

上游基座之外的**项目自留**组件。它们保留项目需要的语义，不改成上游形态：

| 组件            | 保留原因                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Field`         | 上游 `field.tsx` 没有必填星号与 sr-only「必填」，也没有 `error` 的 `role="alert"` 语义（§11 硬规则）                               |
| `Panel`         | 上游无对应物；项目面板是 `card` + 描边的实心容器，附 `panelCls` / `badgeCls` 类名导出                                              |
| `Menu`          | 上游 `dropdown-menu` 是 Radix 复合结构且有子菜单能力；项目菜单是「锚定按钮 + 分组条目 + 浮层上翻」的另一种形态，行为不同，保留自研 |
| `Segmented`     | 分段控件，上游无对应物                                                                                                             |
| `ThemeSwitcher` | 主题切换器：图标按钮 + hover 浮层（三个图标），上游无对应物                                                                        |
| `FormError`     | 错误条含 `role="alert"` + `onDismiss` 关闭入口，项目多处复用                                                                       |
| `ErrorBoundary` | 渲染层兜底，上游无对应物                                                                                                           |
| `SortHandle`    | 拖拽抓手：拖拽本身不可键盘操作，抓手聚焦后 ↑ / ↓ 挪一格（到头的方向不传回调）。上游无对应物，三个清单共用                          |

`Field` 是本项目唯一「既在上游目录、又保留自研 API」的组件：它承载 §11 的必填与错误语义，改成上游形态会丢掉这些。

### 组件 API 速查

| 组件       | 上游形态要点                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`   | `variant`: `default` / `secondary` / `outline` / `ghost` / `destructive` / `link`；`size`: `default` / `xs` / `sm` / `lg` / `icon` 系列；`asChild` 挂到子元素 |
| `Input`    | 原生 `input` 透传，`h-9`，非法值走 `aria-invalid:border-destructive`                                                                                          |
| `Textarea` | 原生 `textarea` 透传，`min-h-16` + `field-sizing-content`                                                                                                     |
| `Label`    | Radix `Label`，`htmlFor` 关联控件                                                                                                                             |
| `Select`   | 复合：`Select` > `SelectTrigger` > `SelectValue` + `SelectContent` > `SelectItem`                                                                             |
| `Dialog`   | 复合：`Dialog` > `DialogContent` > `DialogHeader` / `DialogTitle` / `DialogDescription` / `DialogFooter`                                                      |

### Select 的空值项（Radix 语义，踩过的坑）

Radix 2.4.1 支持 `value=""` 的选项，但 **`value === ''` 时触发器显示的是 `SelectValue` 的 `placeholder` 文案**，不是那条空值项自身的文案。所以：

- 有空值项时，`placeholder` 必须写成**该空值项的 label**（如空值项是「未设置」，就写 `placeholder="未设置"`），观感才与迁移前逐字一致。
- 无空值项时，`placeholder` 用中性文案（如「请选择」）。
- 旧组件的 `toHaveValue` 断言不成立：上游触发器**没有** `value` 属性，也没有 `aria-haspopup`。断言改成触发器可见文案（`toHaveTextContent`），或打开浮层后断言对应 option 的 `data-state="checked"` / `aria-selected="true"`。

### Dialog 的模态语义（Radix 语义，踩过的坑）

Radix `DialogContent` 是真模态：打开时 `hideOthers` 把背景整片标 `aria-hidden`，并给 `body` 加 `pointer-events: none`。因此：

- 模态打开时**背景不可交互、也不在无障碍树里**。测试里不要用 `hidden: true` 把背景的可访问性放回去——那等于把 Radix 刚修好的语义退回去。正确做法是「先关模态再操作背景」，或改为断言弹窗内元素。
- jsdom 下 `user.click` 会被 user-event 的可交互性检查拒掉（`pointer-events: none`）。需要点击浮层外部时，用 `userEvent.setup({ pointerEventsCheck: 0 })` 或 `fireEvent`。
- Radix 拦截 `Tab`（焦点锁在浮层内），`Esc` 才关闭。

### Dialog 的尺寸（Tailwind 变体，踩过的坑）

基座 `DialogContent` 带的是 `w-full max-w-[calc(100%-2rem)] sm:max-w-lg`。`cn()` 用 tailwind-merge 合并，**只合并同一变体**：

- 传裸 `max-w-3xl` → 只会顶掉 `max-w-[calc(100%-2rem)]`，`sm:max-w-lg` 仍在，宽度还是锁在 512px，同时丢掉窄窗保底。
- 传 `sm:max-w-3xl` → 顶掉 `sm:max-w-lg`，窄窗仍受 `calc(100%-2rem)` 约束。

所以**弹窗宽度一律写 `sm:max-w-*`**。内容可能超出视口高度时同时给 `max-h-[85vh] overflow-y-auto`（弹窗是 `fixed` 居中 + translate，没有 `max-h` 会被裁掉上下两端）。

## 5. 圆角刻度

`--radius: 0.5rem`（8px）为基数，`global.css` 的 `@theme inline` 派生刻度：

| Token         | 值     | 用在哪                                     |
| ------------- | ------ | ------------------------------------------ |
| `rounded-sm`  | 4.8px  | 徽标、标签、计数、键帽、小方块             |
| `rounded-md`  | 6.4px  | **按钮、输入、下拉、图标按钮、分段项**     |
| `rounded-lg`  | 8px    | 分段容器、工具条、代码块、消息气泡、小卡片 |
| `rounded-xl`  | 11.2px | 面板、卡片、看板列、列表块、弹窗           |
| `rounded-2xl` | 14.4px | 上限，仅页面级容器；默认不用               |

禁止：

- `rounded-3xl` / `rounded-4xl`、任意值 `rounded-[Npx]` 这类硬编码 —— 全部走刻度。
- 矩形块用 `rounded-full`（胶囊按钮、胶囊标签）。`rounded-full` 只允许圆点（`size-*`）、开关滑块（`w-9`）、1px 线段端点。
- 调大刻度：`--radius-*` 只能收紧；`check:ui` 对 sm/md/lg/xl/2xl 设了上限（4/6/8/10/12 px）。

## 6. 质感

- 不叠玻璃：`backdrop-blur` 一律不用（上游 `DialogOverlay` 是实心 `bg-black/50`，正好符合）。
- 阴影只给浮层与弹窗（下拉、modal）；平面卡片用描边区分层级，不加投影。
- 不使用大面积模糊光斑、渐变背景、渐变按钮。品牌标记是实心主色方块。
- 动效克制：颜色/位移 150–200ms；只保留 `animate-rise`（浮层与卡片入场），不做漂移背景。

## 7. 字阶与控件尺寸

字阶沿用 **Tailwind 原生档位名**（`xs` / `sm` / `base` / `lg`），但取本项目的紧凑值（macOS 密度）。用原生档位名而不是自定义 `text-body` / `text-meta`，是为了让上游 shadcn 组件里的 `text-sm` / `text-xs` 与本项目正文同号——不会出现同一界面两种字号体系。

| 档       | 类名        | 字号/行高 | 字重                             | 用在哪                                                       |
| -------- | ----------- | --------- | -------------------------------- | ------------------------------------------------------------ |
| 页面标题 | `text-lg`   | 15 / 22   | `font-semibold`（唯一）          | 每个页面顶部的唯一标题                                       |
| 标题     | `text-base` | 14 / 20   | `font-medium`                    | 区块标题、卡片标题、会话标题、详情页标题、弹窗标题           |
| 正文     | `text-sm`   | 13 / 19   | 常规                             | 消息、描述、活动流正文、错误条、代码与输出、空态提示、输入值 |
| 操作     | `text-sm`   | 13 / 19   | `font-medium`（按钮、行主文字）  | 按钮、菜单项、tab、分段项、可点列表行的主文字、复选框标签    |
| 元信息   | `text-xs`   | 11 / 16   | 常规；分组小标题可 `font-medium` | 字段标签、单行说明、时间戳、计数行、分组小标题               |
| 徽标     | `text-xs`   | 11 / 16   | 常规                             | 计数、状态标签、卡片角标                                     |

规则：

- 同一区域自内向外单调递减：标题 14 > 正文 13 = 操作 13（靠字重区分）> 元信息 11。不出现「标题比正文小」的倒挂。
- 禁止 `text-[Npx]`、`tracking-wide`、`leading-*` 覆盖、`font-semibold`（页面标题除外）；番茄钟计时数字是唯一例外（`TimerDisplay.tsx`）。
- 行高由字档提供，组件里不写 `leading-relaxed`；中文不加字距。
- 同一个区块里同类元素用同一档：标题都 14/500，说明都 11/常规，不再按文件各写一套。
- 控件高度：`sm` 32 / `default` 36 / `lg` 40；输入与下拉统一 36（`h-9`）。
- 间距基数 4px；列表行纵向 12–16px；面板内边距 12–20px。

## 8. 状态约定

| 状态          | 表达                                                               |
| ------------- | ------------------------------------------------------------------ |
| hover         | `bg-accent`（有底色块）+ 描边加强                                  |
| 选中 / 当前   | `bg-accent text-accent-foreground`；左侧栏与顶部栏保持一致         |
| focus-visible | `ring-[3px] ring-ring/50`（上游基座写法）                          |
| disabled      | `opacity-50 cursor-not-allowed`，不再额外改文字色                  |
| 危险          | `text-destructive` / `bg-destructive/10` + `border-destructive/30` |

## 9. 检查方式

```
pnpm check:ui   # 圆角越界 / rounded-full 误用 / 玻璃拟态 / 调色板外色值（#hex 与内置色类名）/ 圆角刻度上限 / 前景对比度 / 字阶越界 / 静默校验守卫
```

机械规则（对应 §11）：`off-palette-utility`（`text-red-300`、`bg-amber-400/10` 这类 Tailwind 内置色一律拦下，只认 token）与 `silent-validation-guard`（`if (!x.trim()) return` —— 点了没反应的静默校验）。

`check:ui` 已并入 `pnpm check:fast` 与 pre-commit。它只拦机械可判定的部分；下面这些靠 review：

- [ ] 重要文字用的是 `foreground` 或 `muted-foreground`，没有落进 `faint-foreground`。
- [ ] 按钮、输入、下拉都是 `rounded-md`；没有胶囊按钮。
- [ ] 新面板用 `card` 系实心底，没有新增半透明叠层或模糊。
- [ ] 主色只出现在强调位；一屏没有第二种彩色。
- [ ] 空态、错误态、禁用态三类都有对应 token，没有临时色值。
- [ ] 正文默认可选（`user-select: text`）：只有按钮、标签、菜单项这类控件外壳设 `user-select: none`；日志、提示词、智能体回复都要能拖动选中复制。
- [ ] 同一区块里标题 / 正文 / 操作文字 / 数字告示用的是同一档字阶，没有同类元素混用两档。

## 10. 反例（出现即改）

- 按钮 `rounded-xl` / `rounded-full`，卡片 `rounded-2xl`。
- 输入框 `bg-black/25` + `text-faint-foreground` 占位符配 `text-foreground/60` 输入值。
- 面板 `bg-white/[0.02] backdrop-blur-xl shadow-[...]` 三层叠加。
- 顶部栏 / 页面背景放大面积渐变或模糊光斑。
- 在组件里写 `#8b7cf7` 这类调色板外颜色。
- **自造组件 API**：在 `components/ui/` 里写上游没有的扁平封装（如 `options` 数组式 Select），或在上游组件文件里塞项目专属逻辑。要项目专属行为，走 §4 的覆盖层组件。

## 11. 表单校验与错误反馈

2026-11-08 起为硬规则。由来：新建任务弹窗不填标题点「创建」毫无反应（`if (!title.trim()) return`），
既没有必填标识也没有报错，用户只能猜。**「点了没反应」是缺陷，不是简洁。**

> 本节由 `Field` 覆盖层承载（§4）：上游 `field.tsx` 无必填星号与 `role="alert"` 错误语义，故 `Field` 保留自研 API。

| 场景             | 必须怎么做                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| 必填字段         | `Field required`（红 `*` + 读屏「必填」）；不靠「按钮灰着不响」表达必填                                               |
| 空值提交         | `role="alert"` 的就地文案 + 焦点移回出错字段（`aria-invalid`）；禁止 `if (!x) return` 静默返回                        |
| 字段级错误       | `Field error={...}`                                                                                                   |
| 表单 / 命令错误  | `<FormError message={...} />`；按钮被拒、宿主探测失败等都在弹窗就地展示，弹窗不关、输入不丢                           |
| 页面级错误条     | 只放整体状态：视图读失败（不可关）、跨组件写失败（可关）；不放用户能在字段里改的错误                                  |
| 同一错误的播报   | 一条错误只挂一处。`cards.open` 这类视图错误由页面级错误条播报，通知条自身不重复                                       |
| 文本字段         | 提交前 `trim()`                                                                                                       |
| 数字 / JSON 字段 | 非法给文案，不静默回落成默认值（`Number(x) \|\| 1` 是静默改写用户输入）                                               |
| 禁用按钮         | 必须伴随可见原因：空态提示行、前置条件说明，或已写明的必填错误                                                        |
| 颜色             | 只用语义 token（`text-destructive` / `border-destructive/30` / `bg-destructive/10`），不写 `red-400` 一类调色板外色值 |

写测试时，「空值提交」用例要断言两件事：**没有发命令** + **出现了可见提示**。
只断言「没提交」等于把静默失败固化成期望行为。
