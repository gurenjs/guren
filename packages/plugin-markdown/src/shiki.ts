/**
 * Shiki integration for `@guren/plugin-markdown` (RFC 0012), kept on its own
 * subpath so the root export has no dependency on shiki. `shiki` is an
 * optional peer dependency: importing `@guren/plugin-markdown/shiki` without
 * it installed fails with the runtime's module-not-found error naming shiki.
 *
 * The default shape is the Workers-safe fine-grained bundle: `shiki/core`
 * with an explicit grammar list and the JavaScript regex engine — never the
 * full `shiki` entry, which pulls every grammar plus the oniguruma WASM blob.
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
   * Theme names for dual-theme output: the light palette renders inline, the
   * dark palette rides along in `--shiki-dark` custom properties that the
   * reference stylesheet switches on.
   */
  themes: { light: string; dark: string }
  /**
   * Grammar names to load, resolved via `import('shiki/dist/langs/<name>.mjs')`
   * at runtime. Convenient on server runtimes; bundlers that must see every
   * import statically (Workers builds) should use `langModules` instead.
   */
  langs?: string[]
  /**
   * Explicit grammar modules for bundle-size-critical targets, e.g.
   * `[import('shiki/dist/langs/typescript.mjs')]`. Loaded grammars register
   * their own names, so fences resolve without a separate name list.
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
 * Builds a `highlight` function for `createMarkdownRenderer`. The
 * highlighter is created lazily on first use and shared across renders;
 * fences whose language is not loaded fall back to plain text rather than
 * throwing.
 */
export function createShikiHighlight(options: CreateShikiHighlightOptions): HighlightFn {
  const { themes, langs = [], langModules, themeModules } = options

  let highlighterPromise: Promise<HighlighterCore> | undefined
  const loadHighlighter = (): Promise<HighlighterCore> => {
    highlighterPromise ??= createHighlighterCore({
      themes:
        themeModules ??
        [themes.light, themes.dark].map(
          (name) => import(`shiki/dist/themes/${name}.mjs`) as unknown as ThemeInput,
        ),
      langs:
        langModules ??
        langs.map((name) => import(`shiki/dist/langs/${name}.mjs`) as unknown as LanguageInput),
      engine: createJavaScriptRegexEngine(),
    })
    return highlighterPromise
  }

  return async (code: string, lang?: string): Promise<string> => {
    const highlighter = await loadHighlighter()
    const requested = lang?.trim().toLowerCase() || PLAIN_LANGUAGE
    const resolved = highlighter.getLoadedLanguages().includes(requested)
      ? requested
      : PLAIN_LANGUAGE
    return highlighter.codeToHtml(code, {
      lang: resolved,
      themes: { light: themes.light, dark: themes.dark },
      defaultColor: 'light',
    })
  }
}
