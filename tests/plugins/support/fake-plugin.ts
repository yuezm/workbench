/**
 * 测试夹具：假协议执行器插件（T8 端到端验收用）。
 *
 * 它只实现 `ExecutorPlugin` 契约，不碰内核 / 宿主：
 * - `run` 先发两帧文本，再返回成功回执（`leaseId` / `turn` 原样带回，D15）；
 * - `probe` 给 ready 常量、`models` 给空目录、`detect` 给一条固定候选。
 *
 * 放在 `tests/` 而不是 `src/plugins/executors/` 是有意的：T8 证明的是
 * 「新增协议 = 只写插件 + registry 一行」。夹具作为「新写的插件」被验收用例
 * 直接拼进注册表清单，不需要（也不应该）进内置注册表。
 */
import type { PluginManifest } from '../../../src/protocol/manifest'
import type {
  DetectedRuntime,
  RuntimeModelOption,
  RuntimeProbe,
} from '../../../src/protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../src/protocol/executor'
import type { ExecutorContext, ExecutorPlugin } from '../../../src/sdk/types'

/** 假协议 manifest：id 即运行时配置里的 `executorKey`。 */
export const fakeManifest: PluginManifest = {
  id: 'fake',
  kind: 'executor',
  name: 'Fake 协议',
  version: '1.0.0',
  description: '测试用假协议：两帧文本 + 成功回执，不启动任何进程',
  capabilities: ['spawn'],
}

/** 两帧的文本内容（用例按它断言帧顺序）。 */
export const FAKE_FRAME_TEXTS = ['第一帧', '第二帧'] as const

export const fakePlugin: ExecutorPlugin = {
  async probe(): Promise<RuntimeProbe> {
    return {
      state: 'ready',
      path: '/fake/fake-cli',
      cliVersion: '1.0.0',
      protocolVersion: 2,
      pluginVersion: '1.0.0',
      error: null,
      output: '',
      elapsedMs: 0,
      checkedAt: '2026-01-01T00:00:00.000Z',
    }
  },

  async models(): Promise<RuntimeModelOption[]> {
    return []
  },

  detect(): DetectedRuntime[] {
    // `executorKey` / `supported` 由注册表汇总时填，插件只报本机命令
    return [
      {
        command: 'fake-cli',
        label: 'Fake 协议',
        path: '/fake/fake-cli',
        executorKey: '',
        supported: false,
      },
    ]
  },

  async run(_ctx: ExecutorContext, turn: Turn, io: ExecutorIO): Promise<Receipt> {
    // 本地 seq 故意从 7 起：宿主会丢弃执行器本地 seq，按 run 重新分配全局单调 seq（D6/D7）
    io.emit({ seq: 7, type: 'text', text: FAKE_FRAME_TEXTS[0] })
    io.emit({ seq: 8, type: 'text', text: FAKE_FRAME_TEXTS[1] })
    return {
      status: 'succeeded',
      leaseId: turn.leaseId,
      turn: turn.turn,
      output: FAKE_FRAME_TEXTS.join(''),
      exitCode: 0,
      durationMs: 1,
      sessionId: 'fake-session-1',
    }
  },
}

/**
 * 一条可直接拼进宿主注册表清单的 entry：结构兼容 `host/executor-registry` 的
 * `ExecutorPluginEntry`，但用内联 `satisfies` 表达，夹具本身不 import 宿主层。
 */
export const fakePluginEntry = {
  key: fakeManifest.id,
  label: fakeManifest.name,
  manifest: fakeManifest,
  plugin: fakePlugin,
} satisfies {
  key: string
  label: string
  manifest: PluginManifest
  plugin: ExecutorPlugin
}
