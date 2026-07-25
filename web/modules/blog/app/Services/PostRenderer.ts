import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// Same theme pair as the docs pipeline (MarkdownRenderer.ts) so blog posts
// inherit the docs light/dark code styling.
const POST_THEMES = {
  light: 'rose-pine-dawn',
  dark: 'rose-pine-moon',
} as const
const PLAIN_LANGUAGE = 'text'

let highlighterPromise: Promise<HighlighterCore> | undefined

// Fine-grained shiki bundle rendered in the Worker at save time: only the
// grammars blog posts use, with the JavaScript regex engine instead of the
// oniguruma WASM blob. Deliberately NOT the full 'shiki' entry — that would
// pull every grammar into the Workers bundle. Lazy so importing this module
// (e.g. from routes) costs nothing until the first render.
function loadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import('shiki/dist/themes/rose-pine-dawn.mjs'),
      import('shiki/dist/themes/rose-pine-moon.mjs'),
    ],
    langs: [
      import('shiki/dist/langs/typescript.mjs'),
      import('shiki/dist/langs/tsx.mjs'),
      import('shiki/dist/langs/javascript.mjs'),
      import('shiki/dist/langs/json.mjs'),
      import('shiki/dist/langs/bash.mjs'),
      import('shiki/dist/langs/sql.mjs'),
      import('shiki/dist/langs/html.mjs'),
      import('shiki/dist/langs/css.mjs'),
    ],
    engine: createJavaScriptRegexEngine(),
  })
  return highlighterPromise
}

async function highlight(code: string, lang?: string): Promise<string> {
  const highlighter = await loadHighlighter()
  const requested = lang?.trim().toLowerCase() || PLAIN_LANGUAGE
  const resolved = highlighter.getLoadedLanguages().includes(requested) ? requested : PLAIN_LANGUAGE
  return highlighter.codeToHtml(code, {
    lang: resolved,
    themes: POST_THEMES,
    defaultColor: 'light',
  })
}

const marked = new Marked()
marked.setOptions({ gfm: true, breaks: false, async: true })
marked.use(markedHighlight({ async: true, highlight }))

/** Render post markdown to HTML once, at save time — the read path serves stored HTML. */
export async function renderPostMarkdown(markdown: string): Promise<string> {
  const rendered = await marked.parse(markdown, { async: true })
  return typeof rendered === 'string' ? rendered : ''
}
