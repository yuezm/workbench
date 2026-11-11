/**
 * 回执键单一真相源的护栏（M24）。
 *
 * 原来「提示词文案 / 解析白名单 / 协议校验」各自写了十二个键：M14/M20/M21 加键时
 * 解析器漏了三个，提示词让模型写、执行器却把整块判成「不是回执」，而且不报错。
 * 这里把三处钉在一起——任何一处再漂移，这组用例直接红。
 */
import { describe, expect, it } from 'vitest'
import {
  BASE_RECEIPT_KEYS,
  CHAT_RECEIPT_KEYS,
  RECEIPT_KEYS,
  RECEIPT_KEY_DOCS,
  RECEIPT_LIMITS_LINE,
  type ReceiptKey,
} from '../../src/protocol/receipt-keys'
import { validateInput } from '../../src/protocol/validate'
import { RECEIPT_BLOCK_KEYS } from '../../src/plugins/shared/receipt-block'

describe('protocol/receipt-keys：键集合是三处共用的一份', () => {
  it('文案表、解析白名单与 RECEIPT_KEYS 逐键一致（顺序也一致）', () => {
    expect(Object.keys(RECEIPT_KEY_DOCS)).toEqual([...RECEIPT_KEYS])
    expect([...RECEIPT_BLOCK_KEYS]).toEqual([...RECEIPT_KEYS])
  })

  it('每个键都有非空口径与形状示例', () => {
    for (const key of RECEIPT_KEYS) {
      const doc = RECEIPT_KEY_DOCS[key]
      expect(doc.text.trim()).not.toBe('')
      expect(doc.shape.trim()).not.toBe('')
      // 形状示例必须是能解析的 JSON
      expect(() => JSON.parse(doc.shape)).not.toThrow()
    }
  })

  it('上限行覆盖所有有上限的键', () => {
    for (const key of ['ask', 'notices', 'resolves', 'events', 'notes', 'findings', 'addresses']) {
      expect(RECEIPT_LIMITS_LINE).toContain(`\`${key}\``)
    }
    expect(RECEIPT_LIMITS_LINE).toContain('`checks` 32 条')
    expect(RECEIPT_LIMITS_LINE).toContain('`acceptance` 12 条')
    expect(RECEIPT_LIMITS_LINE).toContain('`spawn` 32 项')
  })

  it('子集常量都在全集内，且聊天键不含阶段专属键', () => {
    for (const key of [...BASE_RECEIPT_KEYS, ...CHAT_RECEIPT_KEYS]) {
      expect(RECEIPT_KEYS).toContain(key)
    }
    expect(CHAT_RECEIPT_KEYS).toEqual(BASE_RECEIPT_KEYS)
    for (const key of ['notes', 'verdict', 'checks', 'findings', 'addresses', 'acceptance']) {
      expect(CHAT_RECEIPT_KEYS).not.toContain(key as ReceiptKey)
    }
  })

  it('协议校验认识每一个键（塞非法值必被拒，且文案点到该键）', () => {
    for (const key of RECEIPT_KEYS) {
      const result = validateInput({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: { status: 'succeeded', leaseId: 'lease-1', turn: 1, [key]: false },
      })
      expect(result.ok, `receipt.${key} 应被校验拒绝`).toBe(false)
      if (!result.ok) expect(result.message).toContain(`receipt.${key}`)
    }
  })
})
