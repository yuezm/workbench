// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { expandArgs, parseArgsTemplate, type ArgvVars } from '../../../src/plugins/shared/argv'

/** 默认变量：测试按需覆盖单项 */
const varsOf = (over: Partial<ArgvVars> = {}): ArgvVars => ({
  model: 'magpie/auto',
  effort: 'high',
  cwd: 'D:/repo',
  context: 'C:/refs/brief.md',
  prompt: '只回复 OK',
  ...over,
})

describe('parseArgsTemplate', () => {
  it('空串与纯空白 = 无参数', () => {
    expect(parseArgsTemplate('')).toEqual([])
    expect(parseArgsTemplate('   \n\t ')).toEqual([])
  })

  it('解析 JSON 字符串数组（空串项原样保留）', () => {
    expect(parseArgsTemplate('["--print","{prompt}"]')).toEqual(['--print', '{prompt}'])
    expect(parseArgsTemplate('["a","","b"]')).toEqual(['a', '', 'b'])
    expect(parseArgsTemplate('[]')).toEqual([])
  })

  it('非法 JSON 抛可读错误', () => {
    expect(() => parseArgsTemplate('--print hi')).toThrow(/argsTemplate 不是合法的 JSON/)
    expect(() => parseArgsTemplate('["unterminated"')).toThrow(/argsTemplate/)
  })

  it('非数组抛可读错误', () => {
    expect(() => parseArgsTemplate('{"a":1}')).toThrow(/argsTemplate 必须是 JSON 字符串数组/)
    expect(() => parseArgsTemplate('"text"')).toThrow(/必须是 JSON 字符串数组/)
    expect(() => parseArgsTemplate('42')).toThrow(/必须是 JSON 字符串数组/)
  })

  it('数组里有非字符串项时指出下标', () => {
    expect(() => parseArgsTemplate('["a",1]')).toThrow(/argsTemplate\[1\] 必须是字符串/)
    expect(() => parseArgsTemplate('["a",null]')).toThrow(/argsTemplate\[1\]/)
  })
})

describe('expandArgs', () => {
  it('逐项替换全部占位符，项数不变、每项仍是独立元素', () => {
    const { args, promptInArgs } = expandArgs(
      [
        '--model',
        '{model}',
        '--effort={effort}',
        '--dir',
        '{cwd}',
        '--context',
        '{context}',
        '{prompt}',
      ],
      varsOf(),
    )

    expect(args).toEqual([
      '--model',
      'magpie/auto',
      '--effort=high',
      '--dir',
      'D:/repo',
      '--context',
      'C:/refs/brief.md',
      '只回复 OK',
    ])
    expect(promptInArgs).toBe(true)
  })

  it('模板没有 {prompt} 时 promptInArgs=false 且提示词不出现在 argv', () => {
    const { args, promptInArgs } = expandArgs(['--batch', '--model={model}'], varsOf())

    expect(promptInArgs).toBe(false)
    expect(args).toEqual(['--batch', '--model=magpie/auto'])
  })

  it('未知占位符原样保留（由协议层负责拒绝）', () => {
    const { args, promptInArgs } = expandArgs(['{unknown}', '{model}-{unknown}'], varsOf())

    expect(args).toEqual(['{unknown}', 'magpie/auto-{unknown}'])
    expect(promptInArgs).toBe(false)
  })

  it('同一项里重复占位符都替换', () => {
    expect(expandArgs(['{model}:{model}'], varsOf()).args).toEqual(['magpie/auto:magpie/auto'])
  })

  it('变量值里的替换模式字符不被二次解释', () => {
    const { args } = expandArgs(['{prompt}'], varsOf({ prompt: '$& $1 $` {model}' }))

    expect(args).toEqual(['$& $1 $` {model}'])
  })
})
