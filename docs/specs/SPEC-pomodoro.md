# Spec: pomodoro（番茄时钟）

> Module id：`pomodoro`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。依赖 `shell`。确认日期：2026-10-28。

## Objective

工作台的第一个 app：标准番茄钟，用于学习/工作时专注计时。核心是一台**可测试的计时状态机**：25 分钟专注 + 5 分钟短休息，每完成 4 轮专注进入一次 15 分钟长休息；三段时长与长休间隔可配置；支持开始/暂停/重置/跳过；阶段结束时响铃并弹系统通知。

**用户故事：**

- 作为使用者，我点击开始后进入专注倒计时；一个阶段结束时有声音和系统通知提醒我切换状态。
- 作为使用者，我可以跳过当前阶段、暂停/恢复、或整体重置。
- 作为使用者，我可以把各阶段时长调成适合我的节奏（仅运行期生效，不保存）。

## Tech Stack

- 与 shell 相同（Electron + React + TS + CSS Modules）
- 计时逻辑：纯 TypeScript reducer（不依赖 React），UI 仅订阅
- 响铃：Web Audio API（振荡器合成，不引音频资源文件）
- 系统通知：调用 shell 提供的 `window.workbench.notify()`

## Commands

同 shell（`npm run dev` / `npm run build` / `npm test` / `npm run lint`）。

## Project Structure

> 实际落地遵循 electron-vite 约定（renderer 源码根 `src/renderer/src/`）。

```
src/renderer/src/apps/pomodoro/
├── index.tsx           # AppDefinition 声明（pomodoroApp：id/name/icon/component）
├── PomodoroPage.tsx    # 组装：usePomodoro + 子组件
├── timer/
│   ├── types.ts        # Phase、Event、PomodoroState、PomodoroConfig、CONFIG_LIMITS
│   ├── machine.ts      # 纯 reducer：reduce(state, event)；工厂 createInitialState(config)
│   └── machine.test.ts
├── hooks/
│   └── usePomodoro.ts  # 接线层：interval 驱动 TICK；justCompleted → 响铃 + notify
├── audio.ts            # 响铃（Web Audio 振荡器合成，播放器可注入测试）
└── components/
    ├── TimerDisplay.tsx    # 大号 mm:ss + 阶段标签 + 轮次圆点
    ├── Controls.tsx        # 开始/暂停/重置/跳过
    └── SettingsPanel.tsx   # 时长配置（<details> 折叠，运行态禁用）
```

## 状态机（核心规则）

**阶段（Phase）：** `focus`（专注）| `shortBreak`（短休息）| `longBreak`（长休息）| `idle`（未开始，等同 focus 的就绪态）。

**完成标记：** 状态携带 `justCompleted`——最近一次转移是否为"阶段自然到 0"。UI 据此触发响铃 + 通知；SKIP/RESET 及后续转移将其清除，保证提醒恰好一次。

**配置（默认值）：**

| 配置项                | 默认 | 范围       |
| --------------------- | ---- | ---------- |
| focusMin              | 25   | 1–120 分钟 |
| shortBreakMin         | 5    | 1–30 分钟  |
| longBreakMin          | 15   | 1–60 分钟  |
| roundsBeforeLongBreak | 4    | 2–8 轮     |

**事件与转移：**

| 事件                             | 行为                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| START                            | 从 `paused`/就绪态开始倒计时                                                                      |
| TICK                             | 剩余时间随真实时间递减（基于时间戳差值，非 interval 累加）                                        |
| PHASE_COMPLETE（倒计时自然到 0） | 响铃 + 系统通知；切换到下一阶段并**暂停等待用户确认**；若刚结束的是 focus，`completedRounds += 1` |
| PAUSE                            | 冻结剩余时间                                                                                      |
| SKIP                             | 不响铃、不计轮数，直接切换到下一阶段（就绪态）；跳过 focus **不**计入已完成轮数                   |
| RESET                            | 回到初始态：idle/focus、计时清零、`completedRounds` 清零                                          |

**下一阶段规则：** focus 结束 → `completedRounds % roundsBeforeLongBreak === 0` 时进 `longBreak`，否则进 `shortBreak`；break 结束 → 回 `focus`。

**配置修改时机：** 仅在非运行态（idle/paused）可修改；运行中设置面板禁用。

## Code Style

同 shell 约定。计时器核心风格示例——状态机是纯函数，UI 不写业务规则：

```ts
export function tick(state: PomodoroState, now: number): PomodoroState {
  const remaining = state.endsAt === null ? state.remainingMs : Math.max(0, state.endsAt - now)
  return remaining === 0 ? onPhaseComplete(state) : { ...state, remainingMs: remaining }
}
```

## Testing Strategy

- 框架：Vitest + @testing-library/react，测试文件就近放置。
- **状态机（重点，要求分支全覆盖）：** 用假时钟（注入时间戳）驱动——完整 4 轮循环进入长休、跨轮切换正确、TICK 到 0 触发 PHASE_COMPLETE、PAUSE/SKIP/RESET 语义（尤其"skip 不计轮"）、配置边界值。
- **组件：** TimerDisplay 渲染 mm:ss 与阶段名；Controls 触发对应事件；SettingsPanel 修改配置并校验范围钳制。
- **响铃/通知：** audio.ts 以可注入的播放函数测试（单测验证"阶段完成时会调用播放"）；系统通知经 `window.workbench.notify` 的 mock 验证调用参数。
- 覆盖率：`machine.ts` 分支覆盖 100%。

## Boundaries

- **Always：** 阶段切换、计轮等业务规则只写在 `machine.ts`；倒计时基于时间戳差值；通知通过 `window.workbench.notify()` 发送。
- **Ask first：** 修改默认时长/轮数或范围；为配置或历史引入任何持久化。
- **Never：** 直接调用 Electron API（必须走 shell 的 `WorkbenchApi`）；落盘任何数据；把计时逻辑写在组件里。

## Success Criteria

1. 默认 25/5/15/4，四项配置均可在设置面板修改并立即生效（非运行态），非法输入被钳制到范围内。
2. 将各段时长设为秒级后手动走完整流程：连续完成 `roundsBeforeLongBreak` 轮专注后正确进入长休息；休息结束回到专注。
3. 开始/暂停/重置/跳过行为与状态机表格完全一致（由状态机单测证明，含"跳过专注不计轮"）。
4. 阶段自然结束时：响铃播放 + 系统通知弹出（含下个阶段名称），并停在下一阶段等待确认。
5. 倒计时在窗口失焦、系统休眠恢复后仍准确（时间戳机制，单测以大幅跳跃的时间戳模拟）。
6. 侧边栏高亮当前 app（由 shell 承载，pomodoro 无需感知）。

## Open Questions

1. **阶段结束后自动切换并暂停**（等待用户点开始）——还是全自动连跑？按前者执行。
2. **跳过 focus 不计轮数**——如果你希望跳过也算完成一轮，请指出。
3. 界面文案中文、深色主题——按假设执行。
