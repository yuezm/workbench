// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { StageScript } from '@workbench/protocol/entities'
import {
  addStep,
  applyScriptPatch,
  cleanScript,
  defaultScript,
  emptyStep,
  formatArgLines,
  formatEnvLines,
  parseArgLines,
  parseEnvLines,
  patchStep,
  removeStep,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  SCRIPT_MAX_STEPS,
  SCRIPT_TIMEOUT_CHOICES,
} from '@workbench/client-app-ai-workflow/model/stage-script'

describe('model/stage-script（M40 / M42）', () => {
  it('默认脚本配置：一步空参数 + 整轮跑完 + 10 分钟超时 + 给定运行时（没有命令字段）', () => {
    expect(defaultScript('rt-1')).toEqual({
      runtimeId: 'rt-1',
      steps: [{ label: '', args: [] }],
      cwd: null,
      env: {},
      timeoutMs: SCRIPT_DEFAULT_TIMEOUT_MS,
      runAll: true,
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
    const steps = [{ label: '门禁', args: ['check'] }]
    expect(applyScriptPatch(base, { steps })).toEqual({ ...base, steps })
    // 只改一项不动其它项（浅合并，不重置 steps / env / timeout）
    const patched = applyScriptPatch({ ...base, steps, env: { CI: '1' } }, { cwd: 'C:/r' })
    expect(patched).toEqual({ ...base, steps, env: { CI: '1' }, cwd: 'C:/r' })

    // 没有脚本时按默认补齐：连接留空等表单选（保存前的校验会指出）
    expect(applyScriptPatch(null, { steps })).toEqual({ ...defaultScript(''), steps })
    expect(applyScriptPatch(undefined, {})).toEqual(defaultScript(''))
  })

  it('cleanScript：只留当前契约的字段，老数据里的 command / args 脱落（命令以运行时为准）', () => {
    // 老数据（M40 的一条 args）：保存时就地升级成「一步」，不留两个执行配置源
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
      steps: [{ label: '', args: ['check'] }],
      cwd: null,
      env: { CI: '1' },
      timeoutMs: null,
      runAll: true,
    })
    expect(cleanScript(legacy)).not.toHaveProperty('command')
    expect(cleanScript(legacy)).not.toHaveProperty('args')
    // 缺省字段归一：steps / env / cwd / timeoutMs 缺的补空，不把 undefined 提交出去
    expect(cleanScript({ runtimeId: 'rt-2' } as unknown as StageScript)).toEqual({
      runtimeId: 'rt-2',
      steps: [{ label: '', args: [] }],
      cwd: null,
      env: {},
      timeoutMs: null,
      runAll: true,
    })
    expect(cleanScript(null)).toBeNull()
    expect(cleanScript(undefined)).toBeNull()
    // 脏数据：步骤缺 label / args 时补空串与空数组（外部写入 / 手工改库）
    expect(cleanScript({ runtimeId: 'rt-3', steps: [{}] } as unknown as StageScript)).toEqual({
      runtimeId: 'rt-3',
      steps: [{ label: '', args: [] }],
      cwd: null,
      env: {},
      timeoutMs: null,
      runAll: true,
    })
  })

  it('步骤增删改：上限 8 步、至少留一步、越界位置原样返回', () => {
    const one = [emptyStep()]
    expect(addStep(one)).toEqual([
      { label: '', args: [] },
      { label: '', args: [] },
    ])
    const full = Array.from({ length: SCRIPT_MAX_STEPS }, () => emptyStep())
    expect(addStep(full)).toHaveLength(SCRIPT_MAX_STEPS)
    expect(removeStep(one, 0)).toEqual(one)
    expect(removeStep(full, SCRIPT_MAX_STEPS - 1)).toHaveLength(SCRIPT_MAX_STEPS - 1)
    expect(removeStep(full, 99)).toHaveLength(SCRIPT_MAX_STEPS)
    expect(patchStep([{ label: 'a', args: ['x'] }], 0, { label: 'b' })).toEqual([
      { label: 'b', args: ['x'] },
    ])
    // 越界：原样返回（不造半截步骤）
    expect(patchStep([{ label: 'a', args: ['x'] }], 3, { label: 'b' })).toEqual([
      { label: 'a', args: ['x'] },
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
