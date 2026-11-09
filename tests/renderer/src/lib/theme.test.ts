import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_STORAGE_KEY,
  getResolvedTheme,
  getThemePreference,
  initTheme,
  isThemePreference,
  resetThemeForTest,
  resolveTheme,
  setThemePreference,
  subscribeTheme,
  systemPrefersDark,
  useTheme,
} from '../../../../src/renderer/src/lib/theme'

/**
 * matchMedia 替身：主题模块只缓存首个 MediaQueryList，
 * 所以这里让每次调用返回同一个「可改状态」的对象，
 * 既能读当前 matches，也能手动派发 change 事件。
 */
interface MediaStub {
  matches: boolean
  listeners: Set<(event: MediaQueryListEvent) => void>
}

const mediaStub: MediaStub = {
  matches: false,
  listeners: new Set(),
}

/** 手动派发系统色变化事件 */
function fireSystemChange(): void {
  for (const listener of [...mediaStub.listeners]) {
    listener({ matches: mediaStub.matches } as MediaQueryListEvent)
  }
}

window.matchMedia = ((): MediaQueryList => {
  const list = {
    get matches() {
      return mediaStub.matches
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      mediaStub.listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      mediaStub.listeners.delete(listener)
    },
    dispatchEvent: () => true,
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      mediaStub.listeners.add(listener)
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      mediaStub.listeners.delete(listener)
    },
  }
  return list as unknown as MediaQueryList
}) as unknown as typeof window.matchMedia

beforeEach(() => {
  mediaStub.matches = false
  window.localStorage.clear()
  resetThemeForTest()
  // 挂一次系统色监听：主题模块只在首次调用时注册，之后复用同一个 MediaQueryList
  initTheme()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetThemeForTest()
})

describe('resolveTheme（偏好 + 系统色 → 生效主题）', () => {
  it('显式偏好不受系统色影响', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('跟随系统时由系统色决定', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('isThemePreference（挡脏值）', () => {
  it('三种合法偏好都认', () => {
    expect(isThemePreference('light')).toBe(true)
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('system')).toBe(true)
  })

  it('脏值一律不认', () => {
    expect(isThemePreference('sepia')).toBe(false)
    expect(isThemePreference('Light')).toBe(false)
    expect(isThemePreference('')).toBe(false)
    expect(isThemePreference(null)).toBe(false)
    expect(isThemePreference(undefined)).toBe(false)
    expect(isThemePreference(42)).toBe(false)
    expect(isThemePreference({ preference: 'dark' })).toBe(false)
  })
})

describe('setThemePreference（落盘 + 换 html 类名）', () => {
  it('写入 localStorage 并把 html 类名切成 dark', () => {
    setThemePreference('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(THEME_STORAGE_KEY).toBe('workbench.theme')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(getThemePreference()).toBe('dark')
    expect(getResolvedTheme()).toBe('dark')
  })

  it('写入 light 时把 dark 类名摘掉', () => {
    setThemePreference('dark')
    setThemePreference('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(getResolvedTheme()).toBe('light')
  })

  it('写盘失败（隐私模式）不报错，内存态仍然生效', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    setThemePreference('dark')
    expect(getThemePreference()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('跟随系统：按 matchMedia 决定生效主题', () => {
  it('系统偏好暗色时生效 dark', () => {
    mediaStub.matches = true
    setThemePreference('system')
    expect(getResolvedTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('系统偏好亮色时生效 light', () => {
    mediaStub.matches = false
    setThemePreference('system')
    expect(getResolvedTheme()).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('系统色变化时重新解析并换类名', () => {
    setThemePreference('system')
    expect(getResolvedTheme()).toBe('light')
    mediaStub.matches = true
    fireSystemChange()
    expect(getResolvedTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('偏好不是 system 时，系统色变化不重新解析', () => {
    setThemePreference('light')
    mediaStub.matches = true
    fireSystemChange()
    expect(getResolvedTheme()).toBe('light')
  })

  it('systemPrefersDark 读 matchMedia 的 matches', () => {
    mediaStub.matches = true
    expect(systemPrefersDark()).toBe(true)
    mediaStub.matches = false
    expect(systemPrefersDark()).toBe(false)
  })
})

describe('subscribeTheme（订阅与退订）', () => {
  it('偏好变化时通知订阅者', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTheme(listener)
    setThemePreference('dark')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('退订后不再收到通知', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTheme(listener)
    unsubscribe()
    setThemePreference('dark')
    expect(listener).not.toHaveBeenCalled()
  })

  it('多个订阅者各自收到通知', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = subscribeTheme(first)
    const unsubscribeSecond = subscribeTheme(second)
    setThemePreference('light')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    unsubscribeFirst()
    unsubscribeSecond()
  })
})

describe('initTheme（渲染前落地）', () => {
  it('按当前偏好给 html 补上类名', () => {
    setThemePreference('dark')
    document.documentElement.classList.remove('dark', 'light')
    initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('useTheme（Hook 读快照 + 切换）', () => {
  it('返回当前偏好与生效主题，并可切换', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.preference).toBe('system')
    expect(result.current.resolved).toBe('light')
    act(() => {
      result.current.setPreference('dark')
    })
    expect(result.current.preference).toBe('dark')
    expect(result.current.resolved).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('降级路径（脏存储 / 存储不可用 / 无 matchMedia）', () => {
  /** 重新载入一份全新的主题模块（模块级状态重来一遍） */
  const importFreshTheme = async () => {
    vi.resetModules()
    return import('../../../../src/renderer/src/lib/theme')
  }

  it('存储里是脏值时按跟随系统回落', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    const fresh = await importFreshTheme()
    expect(fresh.getThemePreference()).toBe('system')
  })

  it('存储里是合法偏好时读回来', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const fresh = await importFreshTheme()
    expect(fresh.getThemePreference()).toBe('dark')
    expect(fresh.getResolvedTheme()).toBe('dark')
  })

  it('localStorage 读失败时按跟随系统回落', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied')
    })
    const fresh = await importFreshTheme()
    expect(fresh.getThemePreference()).toBe('system')
  })

  it('没有 matchMedia 时按亮色处理，且不挂系统色监听', async () => {
    const saved = window.matchMedia
    window.matchMedia = undefined as unknown as typeof window.matchMedia
    try {
      const fresh = await importFreshTheme()
      expect(fresh.systemPrefersDark()).toBe(false)
      expect(() => fresh.initTheme()).not.toThrow()
      expect(fresh.getResolvedTheme()).toBe('light')
    } finally {
      window.matchMedia = saved
    }
  })

  it('没有 document 时不写类名，也不报错', async () => {
    vi.stubGlobal('document', undefined)
    const fresh = await importFreshTheme()
    expect(() => fresh.setThemePreference('dark')).not.toThrow()
    expect(fresh.getResolvedTheme()).toBe('dark')
    vi.unstubAllGlobals()
  })
})
