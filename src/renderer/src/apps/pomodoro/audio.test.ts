import { vi } from 'vitest'
import { describe, expect, it } from 'vitest'
import { createRingPlayer, type RingAudioContext } from './audio'

interface RecordedOscillator {
  type: string
  frequency: number
  startedAt: number | undefined
  stoppedAt: number | undefined
}

/** 假 AudioContext：记录被调度的振荡器，不发出任何真实声音 */
function fakeContext() {
  const oscillators: RecordedOscillator[] = []
  const resume = vi.fn(async () => {})

  const ctx: RingAudioContext = {
    currentTime: 42,
    destination: {} as AudioContext['destination'],
    resume,
    createOscillator() {
      const record: RecordedOscillator = {
        type: '',
        frequency: 0,
        startedAt: undefined,
        stoppedAt: undefined
      }
      const osc = {
        type: '',
        frequency: { value: 0 },
        connect: vi.fn(),
        start(at?: number) {
          record.type = osc.type
          record.frequency = osc.frequency.value
          record.startedAt = at
        },
        stop(at?: number) {
          record.stoppedAt = at
        }
      }
      oscillators.push(record)
      return osc as unknown as OscillatorNode
    },
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn()
        },
        connect: vi.fn()
      } as unknown as GainNode
    }
  }

  return { ctx, oscillators, resume }
}

describe('createRingPlayer', () => {
  it('惰性创建：play 之前不创建 AudioContext', () => {
    const fake = fakeContext()
    const factory = vi.fn(() => fake.ctx)
    createRingPlayer(factory)
    expect(factory).not.toHaveBeenCalled()
  })

  it('play 时创建上下文、resume 并调度三声上行音', () => {
    const fake = fakeContext()
    const player = createRingPlayer(() => fake.ctx)

    player.play()

    expect(fake.resume).toHaveBeenCalled()
    expect(fake.oscillators).toHaveLength(3)
    const freqs = fake.oscillators.map((o) => o.frequency)
    expect(freqs[0]).toBeLessThan(freqs[1])
    expect(freqs[1]).toBeLessThan(freqs[2])
    for (const osc of fake.oscillators) {
      expect(osc.startedAt).toBeDefined()
      expect(osc.stoppedAt).toBeGreaterThan(osc.startedAt!)
    }
  })

  it('重复 play 复用同一个 AudioContext', () => {
    const fake = fakeContext()
    const factory = vi.fn(() => fake.ctx)
    const player = createRingPlayer(factory)

    player.play()
    player.play()

    expect(factory).toHaveBeenCalledTimes(1)
  })
})
