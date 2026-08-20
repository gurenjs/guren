import { createMarkdownRenderer } from '@guren/plugin-markdown'
import { createShikiHighlight } from '@guren/plugin-markdown/shiki'

import { MARKDOWN_CODE_THEMES, SITE_ALERT_LABELS } from '../../../../config/markdown.js'

// Theme pair shared with the docs pipeline via config/markdown.ts. Grammars
// and themes are passed as explicit module thunks: the Workers bundler must
// see every import statically (never the full 'shiki' entry, which would
// pull every grammar plus the oniguruma WASM blob), and thunks keep the load
// lazy — importing this module (e.g. from routes) costs nothing until the
// first render. The theme thunk paths below must name the same themes as
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

// The plugin sanitizes by default — the rendered HTML is later injected with
// dangerouslySetInnerHTML, so sanitization at save time stays mandatory. The
// plugin's default allowlist is a deliberate superset of the one this module
// used to carry: it additionally admits div, heading ids, and the alert
// classes, because posts now render alerts and heading anchors like docs do.
// Alert labels use the site vocabulary so blog and docs pages sharing one
// stylesheet cannot label the same directive differently.
const renderer = createMarkdownRenderer({
  highlight,
  alertLabels: SITE_ALERT_LABELS,
})

/** Render post markdown to HTML once, at save time — the read path serves stored HTML. */
export async function renderPostMarkdown(markdown: string): Promise<string> {
  return renderer.render(markdown)
}
