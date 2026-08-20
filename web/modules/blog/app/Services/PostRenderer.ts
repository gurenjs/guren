import { createMarkdownRenderer } from '@guren/plugin-markdown'
import { createShikiHighlight } from '@guren/plugin-markdown/shiki'

// Same theme pair as the docs pipeline (MarkdownRenderer.ts) so blog posts
// inherit the docs light/dark code styling. Grammars and themes are passed as
// explicit module thunks: the Workers bundler must see every import
// statically (never the full 'shiki' entry, which would pull every grammar
// plus the oniguruma WASM blob), and thunks keep the load lazy — importing
// this module (e.g. from routes) costs nothing until the first render.
const highlight = createShikiHighlight({
  themes: { light: 'rose-pine-dawn', dark: 'rose-pine-moon' },
  themeModules: [
    () => import('shiki/dist/themes/rose-pine-dawn.mjs'),
    () => import('shiki/dist/themes/rose-pine-moon.mjs'),
  ],
  langModules: [
    () => import('shiki/dist/langs/typescript.mjs'),
    () => import('shiki/dist/langs/tsx.mjs'),
    () => import('shiki/dist/langs/javascript.mjs'),
    () => import('shiki/dist/langs/json.mjs'),
    () => import('shiki/dist/langs/bash.mjs'),
    () => import('shiki/dist/langs/sql.mjs'),
    () => import('shiki/dist/langs/html.mjs'),
    () => import('shiki/dist/langs/css.mjs'),
  ],
})

// The plugin sanitizes by default with the allowlist this module used to
// carry — the rendered HTML is later injected with dangerouslySetInnerHTML,
// so sanitization at save time stays mandatory.
const renderer = createMarkdownRenderer({ highlight })

/** Render post markdown to HTML once, at save time — the read path serves stored HTML. */
export async function renderPostMarkdown(markdown: string): Promise<string> {
  return renderer.render(markdown)
}
