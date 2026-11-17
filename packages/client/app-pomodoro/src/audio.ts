/**
 * 响铃：Web Audio 振荡器合成三声上行短音，不引入音频资源文件。
 * AudioContext 惰性创建（首次 play 时），避免自动播放策略拦截。
 */

/** 结构化的最小 AudioContext 接口，测试可注入假实现 */
export interface RingAudioContext {
  currentTime: number
  destination: AudioContext['destination']
  resume(): Promise<void>
  createOscillator(): OscillatorNode
  createGain(): GainNode
}

export type AudioContextFactory = () => RingAudioContext

export interface RingPlayer {
  /** 播放一段提示音；重复调用复用同一上下文 */
  play(): void
}

const NOTES_HZ = [880, 1108.73, 1318.51] // A5 → C#6 → E6，上行三连音
const NOTE_GAP_S = 0.16
const NOTE_DUR_S = 0.14

function defaultFactory(): RingAudioContext {
  return new AudioContext()
}

function tone(ctx: RingAudioContext, frequency: number, startAt: number, durationS: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(0.35, startAt + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startAt)
  osc.stop(startAt + durationS + 0.05)
}

export function createRingPlayer(factory: AudioContextFactory = defaultFactory): RingPlayer {
  let ctx: RingAudioContext | null = null

  return {
    play(): void {
      ctx ??= factory()
      void ctx.resume()
      const t0 = ctx.currentTime + 0.05
      NOTES_HZ.forEach((frequency, i) => {
        tone(ctx!, frequency, t0 + i * NOTE_GAP_S, NOTE_DUR_S)
      })
    },
  }
}
