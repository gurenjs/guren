/**
 * Shiki integration for `@guren/plugin-markdown` (RFC 0012), on its own subpath
 * so the root export has no dependency on shiki (an optional peer). The default
 * shape is the Workers-safe fine-grained bundle — `shiki/core` with an explicit
 * grammar list and the JavaScript regex engine — never the full `shiki` entry,
 * which pulls every grammar plus the oniguruma WASM blob.
 */
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemeInput,
} from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import type { HighlightFn } from './renderer'

const PLAIN_LANGUAGE = 'text'

export interface CreateShikiHighlightOptions {
  /**
   * Dual-theme output: the light palette renders inline, the dark palette rides
   * in `--shiki-dark` custom properties the reference stylesheet switches on.
   */
  themes: { light: string; dark: string }
  /**
   * Grammar names, resolved via `import('shiki/dist/langs/<name>.mjs')` at
   * runtime. Bundlers that must see every import statically (Workers builds)
   * need `langModules` instead.
   */
  langs?: string[]
  /**
   * Explicit grammar modules for bundle-size-critical targets. Loaded grammars
   * register their own names, so fences resolve without a separate name list.
   */
  langModules?: LanguageInput[]
  /**
   * Explicit theme modules, same rationale as `langModules`. When omitted,
   * both `themes` names are dynamically imported. When given, the loaded
   * themes must include both `themes` names.
   */
  themeModules?: ThemeInput[]
}

/**
 * Builds a `highlight` function for `createMarkdownRenderer`. The highlighter is
 * created lazily on first use and shared across renders; a fence whose language
 * is not loaded falls back to plain text rather than throwing.
 */
export function createShikiHighlight(options: CreateShikiHighlightOptions): HighlightFn {
  const { themes, langs = [], langModules, themeModules } = options

  interface LoadedHighlighter {
    highlighter: HighlighterCore
    // Snapshot of getLoadedLanguages(): the grammar set is fixed at creation
    // time, and shiki rebuilds the array on every call — per fence otherwise.
    loadedLangs: Set<string>
  }

  let highlighterPromise: Promise<LoadedHighlighter> | undefined
  const loadHighlighter = (): Promise<LoadedHighlighter> => {
    if (!highlighterPromise) {
      const attempt = createHighlighterCore({
        themes:
          themeModules ??
          [themes.light, themes.dark].map(
            (name) => import(`shiki/dist/themes/${name}.mjs`) as unknown as ThemeInput,
          ),
        langs:
          langModules ??
          langs.map((name) => import(`shiki/dist/langs/${name}.mjs`) as unknown as LanguageInput),
        engine: createJavaScriptRegexEngine(),
      }).then((highlighter) => ({
        highlighter,
        loadedLangs: new Set(highlighter.getLoadedLanguages()),
      }))
      // A rejected attempt must not stay cached — a transient load failure
      // would disable highlighting for the renderer's lifetime. Guarded by
      // attempt identity so a later retry cannot be cleared by this failure.
      attempt.catch(() => {
        if (highlighterPromise === attempt) {
          highlighterPromise = undefined
        }
      })
      highlighterPromise = attempt
    }
    return highlighterPromise
  }

  return async (code: string, lang?: string): Promise<string> => {
    const { highlighter, loadedLangs } = await loadHighlighter()
    const requested = lang?.trim().toLowerCase() || PLAIN_LANGUAGE
    const resolved = loadedLangs.has(requested) ? requested : PLAIN_LANGUAGE
    return highlighter.codeToHtml(code, {
      lang: resolved,
      themes: { light: themes.light, dark: themes.dark },
      defaultColor: 'light',
    })
  }
}
