import { createMarkdownRenderer } from '@guren/plugin-markdown'
import { createShikiHighlight } from '@guren/plugin-markdown/shiki'

import { MARKDOWN_CODE_THEMES, SITE_ALERT_LABELS } from '../../../../config/markdown.js'

// Grammars and themes are explicit module thunks: the Workers bundler must see
// every import statically (never the full 'shiki' entry, which pulls every
// grammar plus the oniguruma WASM blob), and thunks keep the load lazy until
// the first render. The thunk paths must name the same themes as
// MARKDOWN_CODE_THEMES; the shared constant cannot make the imports follow.
const highlight = createShikiHighlight({
  themes: MARKDOWN_CODE_THEMES,
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

// The rendered HTML is later injected with dangerouslySetInnerHTML, so the
// plugin's default sanitization stays mandatory; its allowlist admits div,
// heading ids and the alert classes posts need. Alert labels use the site
// vocabulary, so blog and docs sharing a stylesheet cannot disagree.
const renderer = createMarkdownRenderer({
  highlight,
  alertLabels: SITE_ALERT_LABELS,
})

/** Render post markdown to HTML once, at save time — the read path serves stored HTML. */
export async function renderPostMarkdown(markdown: string): Promise<string> {
  return renderer.render(markdown)
}
