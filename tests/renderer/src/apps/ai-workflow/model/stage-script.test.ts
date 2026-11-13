import { describe, expect, it } from 'vitest'
import {
  defaultScript,
  formatArgLines,
  formatEnvLines,
  parseArgLines,
  parseEnvLines,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  SCRIPT_TIMEOUT_CHOICES,
} from '../../../../../../src/renderer/src/apps/ai-workflow/model/stage-script'

describe('model/stage-script（M40）', () => {
  it('默认脚本配置：空命令 + 空参数 + 10 分钟超时 + 给定运行时', () => {
    expect(defaultScript('rt-1')).toEqual({
      runtimeId: 'rt-1',
      command: '',
      args: [],
      cwd: null,
      env: {},
      timeoutMs: SCRIPT_DEFAULT_TIMEOUT_MS,
    })
    expect(SCRIPT_DEFAULT_TIMEOUT_MS).toBe(10 * 60_000)
    expect(SCRIPT_TIMEOUT_CHOICES.map((choice) => choice.value)).toEqual([
      String(5 * 60_000),
      String(10 * 60_000),
      String(30 * 60_000),
      String(60 * 60_000),
    ])
  })

  it('参数文本 ↔ argv：一行一项，空行丢弃，项内空格保留', () => {
    expect(parseArgLines('check\n\n--reporter=dot\n  --watch  ')).toEqual([
      'check',
      '--reporter=dot',
      '--watch',
    ])
    expect(parseArgLines('')).toEqual([])
    expect(formatArgLines(['check', '--a b'])).toBe('check\n--a b')
    expect(parseArgLines(formatArgLines(['check', 'x']))).toEqual(['check', 'x'])
  })

  it('环境变量文本 ↔ 键值：只认 KEY=VALUE，无等号 / 空键丢弃，值里的等号保留', () => {
    expect(parseEnvLines('CI=1\n\nBROKEN\n=no-key\nA=b=c\n SPACE = 1 ')).toEqual({
      CI: '1',
      A: 'b=c',
      SPACE: '1',
    })
    expect(parseEnvLines('')).toEqual({})
    expect(formatEnvLines({ B: '2', A: '1' })).toBe('A=1\nB=2')
    expect(parseEnvLines(formatEnvLines({ A: '1', B: '2' }))).toEqual({ A: '1', B: '2' })
  })
})
