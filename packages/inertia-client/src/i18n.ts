import { useMemo } from 'react'
import { usePage } from '@inertiajs/react'

/**
 * Client-side translation for the `_i18n` shared prop injected by
 * `createApp({ i18n })` on the server.
 *
 * The translation semantics (dot-notation keys, `:name`/`{name}`
 * interpolation, `|`-separated plural forms, fallback-locale lookup,
 * missing keys echoing the key) intentionally mirror the server's
 * Translator so `useTranslation().t(...)` and `this.t(...)` in a
 * controller agree on every input. The parity suite in
 * `tests/i18n.test.ts` runs both implementations against shared fixtures —
 * extend it when touching anything here.
 */

export type TranslationMessages = {
  [key: string]: string | TranslationMessages
}

export type ReplacementValues = Record<string, string | number>

/** Shape of the `_i18n` Inertia shared prop (see the server's InertiaI18nProps). */
export interface I18nPageProps {
  locale: string
  fallbackLocale: string
  messages: Record<string, TranslationMessages>
}

export interface Translation {
  /** The locale resolved for the current request. */
  locale: string
  /** Translate a key, with optional `:name`/`{name}` interpolation. */
  t: (key: string, replacements?: ReplacementValues) => string
  /** Translate a key with a count for pluralization (`one|other` forms). */
  tc: (key: string, count: number, replacements?: ReplacementValues) => string
}

type PluralizationRule = (count: number) => number

/**
 * Mirrors packages/server/src/i18n/pluralization.ts — keep the two tables in
 * sync (covered by the parity test).
 */
const pluralizationRules: Record<string, PluralizationRule> = {
  en: (count) => (count === 1 ? 0 : 1),
  de: (count) => (count === 1 ? 0 : 1),
  es: (count) => (count === 1 ? 0 : 1),
  it: (count) => (count === 1 ? 0 : 1),
  pt: (count) => (count === 1 ? 0 : 1),
  nl: (count) => (count === 1 ? 0 : 1),
  fr: (count) => (count <= 1 ? 0 : 1),
  'pt-BR': (count) => (count <= 1 ? 0 : 1),
  ja: () => 0,
  zh: () => 0,
  ko: () => 0,
  vi: () => 0,
  th: () => 0,
  ru: (count) => {
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 === 1 && mod100 !== 11) return 0
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1
    return 2
  },
  uk: (count) => {
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 === 1 && mod100 !== 11) return 0
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1
    return 2
  },
  pl: (count) => {
    if (count === 1) return 0
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1
    return 2
  },
  cs: (count) => {
    if (count === 1) return 0
    if (count >= 2 && count <= 4) return 1
    return 2
  },
  sk: (count) => {
    if (count === 1) return 0
    if (count >= 2 && count <= 4) return 1
    return 2
  },
  ar: (count) => {
    if (count === 0) return 0
    if (count === 1) return 1
    if (count === 2) return 2
    const mod100 = count % 100
    if (mod100 >= 3 && mod100 <= 10) return 3
    if (mod100 >= 11) return 4
    return 5
  },
}

function getPluralizationRule(locale: string): PluralizationRule {
  return (
    pluralizationRules[locale] ??
    pluralizationRules[locale.split('-')[0]!] ??
    pluralizationRules.en!
  )
}

function getRawTranslation(
  messages: Record<string, TranslationMessages>,
  locale: string,
  key: string,
): string | undefined {
  const catalog = messages[locale]
  if (!catalog) return undefined

  let result: string | TranslationMessages | undefined = catalog
  for (const part of key.split('.')) {
    if (result === undefined || typeof result === 'string') {
      return undefined
    }
    result = result[part]
  }

  return typeof result === 'string' ? result : undefined
}

// Interpolation patterns are deterministic per replacement key, so compile
// them once (bounded by the app's distinct placeholder names). A `g`-flagged
// regex used with String#replace carries no state between calls.
const replacementPatterns = new Map<string, [RegExp, RegExp]>()

function patternsFor(key: string): [RegExp, RegExp] {
  let patterns = replacementPatterns.get(key)
  if (!patterns) {
    patterns = [new RegExp(`:${key}`, 'g'), new RegExp(`\\{${key}\\}`, 'g')]
    replacementPatterns.set(key, patterns)
  }
  return patterns
}

function applyReplacements(translation: string, replacements?: ReplacementValues): string {
  if (!replacements) return translation

  let result = translation
  for (const [key, value] of Object.entries(replacements)) {
    const [colon, braced] = patternsFor(key)
    const replacement = String(value)
    result = result.replace(colon, replacement).replace(braced, replacement)
  }
  return result
}

/**
 * Build a {@link Translation} from `_i18n` page props. Pure — use directly
 * outside React components, or through {@link useTranslation} inside them.
 */
export function createTranslator(props: I18nPageProps): Translation {
  const { locale, fallbackLocale, messages } = props
  const pluralRule = getPluralizationRule(locale)

  const raw = (key: string): string | undefined =>
    getRawTranslation(messages, locale, key) ?? getRawTranslation(messages, fallbackLocale, key)

  return {
    locale,
    t(key, replacements) {
      const translation = raw(key)
      if (translation === undefined) return key
      return applyReplacements(translation, replacements)
    },
    tc(key, count, replacements) {
      const translation = raw(key)
      if (translation === undefined) return key

      const forms = translation.split('|')
      const pluralized = forms[pluralRule(Math.abs(count))] ?? forms[forms.length - 1]!

      return applyReplacements(pluralized, { count, ...replacements })
    },
  }
}

let warnedMissingProps = false

const identityTranslation: Translation = {
  locale: '',
  t: (key) => key,
  tc: (key) => key,
}

/**
 * Translate with the locale and messages the server shared for this request.
 *
 * ```tsx
 * const { t, tc, locale } = useTranslation()
 * t('messages.welcome', { name: user.name })
 * tc('messages.items', items.length)
 * ```
 *
 * Requires `createApp({ i18n })` on the server (with `share` left enabled).
 * When the `_i18n` prop is absent, keys are returned untranslated and a
 * warning is logged once.
 */
export function useTranslation(): Translation {
  const i18n = usePage().props._i18n as I18nPageProps | undefined

  return useMemo(() => {
    if (!i18n) {
      if (!warnedMissingProps) {
        warnedMissingProps = true
        console.warn(
          '[guren] useTranslation(): no _i18n page prop found. ' +
            'Configure createApp({ i18n }) on the server (and keep i18n.share enabled).',
        )
      }
      return identityTranslation
    }

    return createTranslator(i18n)
  }, [i18n])
}
