import { describe, test, expect } from 'bun:test'
import type { ThemeInput } from 'shiki/core'

import { createMarkdownRenderer } from './renderer'
import { createShikiHighlight } from './shiki'

const THEMES = { light: 'rose-pine-dawn', dark: 'rose-pine-moon' } as const

describe('createShikiHighlight', () => {
  test('should highlight a loaded language with dual-theme output', async () => {
    const highlight = createShikiHighlight({ themes: THEMES, langs: ['typescript'] })
    const html = await highlight('const a: number = 1', 'typescript')

    expect(html).toContain('shiki')
    expect(html).toContain('style=')
    // Dark palette rides along in custom properties for the stylesheet toggle.
    expect(html).toContain('--shiki-dark')
  })

  test('should fall back to plain text for unloaded languages', async () => {
    const highlight = createShikiHighlight({ themes: THEMES, langs: ['typescript'] })
    const html = await highlight('SELECT 1', 'sql')

    expect(html).toContain('SELECT 1')
    expect(html).not.toContain('class="keyword"')
  })

  test('should load explicit language modules for bundle-static targets', async () => {
    const highlight = createShikiHighlight({
      themes: THEMES,
      langModules: [import('shiki/dist/langs/json.mjs')],
    })
    const html = await highlight('{"a": 1}', 'json')

    expect(html).toContain('shiki')
    expect(html).toContain('--shiki-dark')
  })

  test('should survive the default sanitizer end to end without double wrapping', async () => {
    const renderer = createMarkdownRenderer({
      highlight: createShikiHighlight({ themes: THEMES, langs: ['typescript'] }),
    })
    const html = await renderer.render('```typescript\nconst a = 1\n```')

    // The sanitizer must keep shiki's wrapper, classes, and color styles.
    expect(html).toContain('shiki')
    expect(html).toContain('color:#')
    expect(html).toContain('--shiki-dark')
    // shiki returns a complete <pre> block; the renderer must emit it as-is
    // instead of nesting it inside marked's default <pre><code>.
    expect(html.startsWith('<pre')).toBe(true)
    expect(html).not.toContain('<pre><code class="language-')
  })

  test('should retry after a transient highlighter load failure', async () => {
    let calls = 0
    const failOnce = () => {
      calls++
      return calls === 1
        ? Promise.reject(new Error('transient chunk failure'))
        : import('shiki/dist/themes/rose-pine-dawn.mjs')
    }
    const highlight = createShikiHighlight({
      themes: THEMES,
      themeModules: [failOnce as ThemeInput, import('shiki/dist/themes/rose-pine-moon.mjs')],
      langModules: [import('shiki/dist/langs/json.mjs')],
    })

    await expect(highlight('{"a": 1}', 'json')).rejects.toThrow('transient chunk failure')
    // The failed attempt must not stay cached: the next call reloads.
    const html = await highlight('{"a": 1}', 'json')
    expect(html).toContain('shiki')
  })
})
