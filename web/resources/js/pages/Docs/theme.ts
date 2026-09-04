import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { COLOR_MODE_STORAGE_KEY as STORAGE_KEY } from '../../../../config/theme.js'

export const docsTheme = {
  fontFamily: 'system-ui, sans-serif',
  surfaces: {
    page: 'var(--docs-surface-page)',
    panel: 'var(--docs-surface-panel)',
    raised: 'var(--docs-surface-raised)',
  },
  text: {
    primary: 'var(--docs-text-primary)',
    secondary: 'var(--docs-text-secondary)',
    muted: 'var(--docs-text-muted)',
    heading: 'var(--docs-heading)',
  },
  border: {
    soft: 'var(--docs-border-soft)',
    strong: 'var(--docs-border-strong)',
  },
  accent: {
    base: 'var(--docs-accent)',
    strong: 'var(--docs-accent-strong)',
    tint: 'var(--docs-accent-tint)',
  },
  shadow: {
    card: 'var(--docs-shadow-card)',
    floating: 'var(--docs-shadow-floating)',
  },
} as const

export type DocsTheme = typeof docsTheme

export type ColorMode = 'light' | 'dark' | 'system'

function getStoredMode(): ColorMode {
  if (typeof window === 'undefined') return 'system'
  return (localStorage.getItem(STORAGE_KEY) as ColorMode) || 'system'
}

function getResolvedDark(mode: ColorMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyMode(mode: ColorMode): void {
  if (typeof document === 'undefined') return
  const isDark = getResolvedDark(mode)
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
}

let listeners: Array<() => void> = []

function subscribe(cb: () => void) {
  listeners.push(cb)
  return () => {
    listeners = listeners.filter((l) => l !== cb)
  }
}

function emitChange() {
  listeners.forEach((l) => l())
}

if (typeof window !== 'undefined') {
  applyMode(getStoredMode())

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getStoredMode() === 'system') {
      applyMode('system')
      emitChange()
    }
  })
}

export function useColorMode(): { mode: ColorMode; isDark: boolean; setMode: (m: ColorMode) => void } {
  const mode = useSyncExternalStore(
    subscribe,
    getStoredMode,
    () => 'system' as ColorMode,
  )

  // Starts at `false`, what the server render resolves to, so the first client
  // render matches; the real value arrives in a useEffect.
  const [isDark, setIsDark] = useState<boolean>(false)

  useEffect(() => {
    setIsDark(getResolvedDark(getStoredMode()))
  }, [mode])

  useEffect(() => {
    return subscribe(() => {
      setIsDark(getResolvedDark(getStoredMode()))
    })
  }, [])

  const setMode = useCallback((m: ColorMode) => {
    localStorage.setItem(STORAGE_KEY, m)
    applyMode(m)
    emitChange()
  }, [])

  return { mode, isDark, setMode }
}
