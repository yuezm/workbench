// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAgentEnv } from '../../../src/host/store/agent-env'

describe('parseAgentEnv：agents.env_json → 环境变量对象', () => {
  it('合法 JSON 原样解析', () => {
    expect(parseAgentEnv('{"HTTP_PROXY":"http://127.0.0.1:7890","CI":"1"}')).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      CI: '1',
    })
  })

  it('空串 / null / undefined 按「没有环境变量」归一', () => {
    expect(parseAgentEnv('')).toEqual({})
    expect(parseAgentEnv('   ')).toEqual({})
    expect(parseAgentEnv(null)).toEqual({})
    expect(parseAgentEnv(undefined)).toEqual({})
  })

  it('坏 JSON 与 JSON 非对象（含数组）都按空对象归一（一条脏行不炸整张视图）', () => {
    expect(parseAgentEnv('{')).toEqual({})
    expect(parseAgentEnv('"text"')).toEqual({})
    expect(parseAgentEnv('null')).toEqual({})
    expect(parseAgentEnv('[1,2]')).toEqual({})
  })
})
