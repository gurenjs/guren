import type { TranslationMessages } from './types'

const INJECTED_TRANSLATIONS_HINT =
  'It must hold the lang/ catalogs as JSON ({ locale: { namespace: messages } }); deploy plugins inject it at build time.'

/**
 * The `lang/` catalogs a deploy build injected for runtimes that ship no `lang/`
 * directory (Workers, Lambda, Vercel). Fails loudly on a value that is set but
 * not a catalog: falling through to the filesystem would warn about a missing
 * `lang/` rather than about the variable that is actually broken.
 */
export function injectedTranslations(): Record<string, TranslationMessages> | undefined {
  // This one exact member expression on purpose: the Vercel plugin substitutes
  // it with a bundler `define`, which matches nothing else. Pinned by
  // tests/env-gate-form.test.ts.
  const raw = process.env.GUREN_TRANSLATIONS
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`GUREN_TRANSLATIONS is set but is not valid JSON. ${INJECTED_TRANSLATIONS_HINT}`, {
      cause: error,
    })
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`GUREN_TRANSLATIONS is set but does not hold a catalog object. ${INJECTED_TRANSLATIONS_HINT}`)
  }

  return parsed as Record<string, TranslationMessages>
}
