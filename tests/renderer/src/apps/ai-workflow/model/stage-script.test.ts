import { describe, expect, it } from 'vitest'
import type { StageScript } from '../../../../../../src/protocol/entities'
import {
  applyScriptPatch,
  cleanScript,
  defaultScript,
  formatArgLines,
  formatEnvLines,
  parseArgLines,
  parseEnvLines,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  SCRIPT_TIMEOUT_CHOICES,
} from '../../../../../../src/renderer/src/apps/ai-workflow/model/stage-script'

describe('model/stage-script（M40）', () => {
  it('默认脚本配置：空参数 + 10 分钟超时 + 给定运行时（没有命令字段）', () => {
    expect(defaultScript('rt-1')).toEqual({
      runtimeId: 'rt-1',
      args: [],
      cwd: null,
      env: {},
      timeoutMs: SCRIPT_DEFAULT_TIMEOUT_MS,
    })
    // 命令只来自运行时连接：脚本配置里不存在这个键
    expect(defaultScript('rt-1')).not.toHaveProperty('command')
    expect(SCRIPT_DEFAULT_TIMEOUT_MS).toBe(10 * 60_000)
    expect(SCRIPT_TIMEOUT_CHOICES.map((choice) => choice.value)).toEqual([
      String(5 * 60_000),
      String(10 * 60_000),
      String(30 * 60_000),
      String(60 * 60_000),
    ])
  })

  it('改脚本配置：有脚本就浅合并，没有就补一份默认（界面走不到的守卫）', () => {
    const base = defaultScript('rt-1')
    expect(applyScriptPatch(base, { args: ['check'] })).toEqual({
      ...base,
      args: ['check'],
    })
    // 只改一项不动其它项（浅合并，不重置 args / env / timeout）
    const patched = applyScriptPatch(
      { ...base, args: ['check'], env: { CI: '1' } },
      { cwd: 'C:/r' },
    )
    expect(patched).toEqual({ ...base, args: ['check'], env: { CI: '1' }, cwd: 'C:/r' })

    // 没有脚本时按默认补齐：连接留空等表单选（保存前的校验会指出）
    expect(applyScriptPatch(null, { args: ['check'] })).toEqual({
      ...defaultScript(''),
      args: ['check'],
    })
    expect(applyScriptPatch(undefined, {})).toEqual(defaultScript(''))
  })

  it('cleanScript：只留当前契约的字段，老数据里的 command 键脱落（命令以运行时为准）', () => {
    // 老数据 / 外部写入带 command：保存时由这里清掉，不留看不见也改不动的第二份命令
    const legacy = {
      runtimeId: 'rt-1',
      command: 'pnpm',
      args: ['check'],
      cwd: null,
      env: { CI: '1' },
      timeoutMs: null,
    } as unknown as StageScript
    expect(cleanScript(legacy)).toEqual({
      runtimeId: 'rt-1',
      args: ['check'],
      cwd: null,
      env: { CI: '1' },
      timeoutMs: null,
    })
    expect(cleanScript(legacy)).not.toHaveProperty('command')
    // 缺省字段归一：args / env / cwd / timeoutMs 缺的补空，不把 undefined 提交出去
    expect(cleanScript({ runtimeId: 'rt-2' } as unknown as StageScript)).toEqual({
      runtimeId: 'rt-2',
      args: [],
      cwd: null,
      env: {},
      timeoutMs: null,
    })
    expect(cleanScript(null)).toBeNull()
    expect(cleanScript(undefined)).toBeNull()
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
