/**
 * 通道插件测试夹具：按 `ChannelContext` 形状构造可控上下文（不启动 hub、不读写库）。
 *
 * - `onCard` 记录订阅者并返回退订函数，`deliver(card, ref)` 模拟 hub 分发（M43：带上这个
 *   通道自己的消息引用）；
 * - `delivered` / `answer` 只是记录回调参数并返回已兑现的 Promise（hub 的真实实现更复杂，
 *   通道插件只依赖回调契约）；
 * - `sdk` 用 `fakeSdk`（notify 调用记进 `sdk.notifyCalls`，文案只作参数）。
 */
import type {
  ChannelAnswerOutcome,
  ChannelContext,
  ChannelProgress,
  ChannelProgressHandler,
  ChannelSubmitHints,
  ChannelSubmitOutcome,
} from '../../../src/protocol/channels'
import type { Card } from '../../../src/protocol/entities'
import { fakeSdk, type FakeSdk } from '../support/fake-sdk'

/** 合法卡片夹具（open / pending，字段齐全） */
export const cardOf = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 'task-1',
  conversationId: null,
  title: '选一个',
  text: '用哪个方案？',
  kind: 'ask',
  options: ['A', 'B'],
  key: 'plan',
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  deliveryRefs: {},
  deliveryAttempts: 0,
  nextDeliveryAt: null,
  deliveryGivenUp: false,
  optionIndex: null,
  answeredBy: null,
  answeredByRef: null,
  answeredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
  ...over,
})

/** 通道侧回答的参数（M43：带上消息引用与操作人） */
export interface AnswerCall {
  cardId: string
  optionIndex: number
  ref?: string
  byRef?: string
}

export interface ChannelHarness {
  ctx: ChannelContext
  sdk: FakeSdk
  controller: AbortController
  /** 已订阅的 onCard 处理器（模拟 hub 的分发列表） */
  handlers: Array<(card: Card, ref: string | null) => void>
  /** 通道回报的 delivered 参数 */
  delivered: Array<{ cardId: string; version: number; ref: string }>
  /** 通道回报的 answer 参数（`answer` 抛错时仍记录，再抛错） */
  answers: AnswerCall[]
  /** 通道提交的入站文本（M44/M45/M47：`submit` 的调用参数，含平台线索与按连接覆盖的智能体） */
  submits: Array<{ text: string; hints: ChannelSubmitHints; agent?: string }>
  /** 已订阅的进展处理器（M44） */
  progressHandlers: ChannelProgressHandler[]
  /** 模拟 hub 把一张卡片分发给所有订阅者（与 hub 的同步调用口径一致） */
  deliver(card: Card, ref?: string | null): void
  /** 模拟 hub 把一条进展分发给所有订阅者（M44） */
  progress(p: ChannelProgress): void
}

export interface ChannelHarnessOptions {
  sdk?: FakeSdk
  /** 自定义 answer 行为：用于「内核拒绝 / 已经 settled」这类路径（缺省总是成功） */
  answer?: (call: AnswerCall) => Promise<ChannelAnswerOutcome>
  /** 自定义 submit 行为：入站派活的结果（缺省 accepted=true，会话 `conversation-1`） */
  submit?: (
    text: string,
    hints: ChannelSubmitHints,
    agent?: string,
  ) => Promise<ChannelSubmitOutcome>
}

export function channelHarness(options: ChannelHarnessOptions = {}): ChannelHarness {
  const sdk = options.sdk ?? fakeSdk()
  const controller = new AbortController()
  const handlers: ChannelHarness['handlers'] = []
  const delivered: ChannelHarness['delivered'] = []
  const answers: ChannelHarness['answers'] = []
  const submits: ChannelHarness['submits'] = []
  const progressHandlers: ChannelProgressHandler[] = []

  const ctx: ChannelContext = {
    sdk,
    onCard: (handler) => {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    delivered: (cardId, version, ref) => {
      delivered.push({ cardId, version, ref })
      return Promise.resolve()
    },
    answer: (cardId, optionIndex, ref, byRef) => {
      const call: AnswerCall = {
        cardId,
        optionIndex,
        ...(ref === undefined ? {} : { ref }),
        ...(byRef === undefined ? {} : { byRef }),
      }
      answers.push(call)
      return options.answer === undefined
        ? Promise.resolve({ changed: true, status: 'answered' })
        : options.answer(call)
    },
    submit: (text, hints, agent) => {
      submits.push({
        text,
        hints,
        ...(agent === undefined ? {} : { agent }),
      })
      if (options.submit !== undefined) return options.submit(text, hints, agent)
      return Promise.resolve({
        accepted: true,
        conversationId: 'conversation-1',
        receipt: '已收到',
      })
    },
    onProgress: (handler) => {
      progressHandlers.push(handler)
      return () => {
        const index = progressHandlers.indexOf(handler)
        if (index >= 0) progressHandlers.splice(index, 1)
      }
    },
    signal: controller.signal,
  }

  return {
    ctx,
    sdk,
    controller,
    handlers,
    delivered,
    answers,
    submits,
    progressHandlers,
    deliver: (card, ref = null) => {
      // 复制一份：处理器可能在分发过程中退订（与 hub 递归分发时的表现一致）
      for (const handler of [...handlers]) handler(card, ref)
    },
    progress: (p) => {
      for (const handler of [...progressHandlers]) handler(p)
    },
  }
}
