import { useEffect } from 'react'

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
  },
} as const

export type DocsTheme = typeof docsTheme

export function useDocsPageTheme() {
  useEffect(() => {
    document.body.classList.add('docs-theme')
    return () => {
      document.body.classList.remove('docs-theme')
    }
  }, [])
}
