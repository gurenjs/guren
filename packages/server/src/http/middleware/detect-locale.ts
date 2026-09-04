import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { parseAccept } from 'hono/utils/accept'
import { tryGetI18n, type I18nManager, type Translator } from '../../i18n'

/** Context key for the resolved request locale (read by Inertia for `<html lang>`). */
export const LOCALE_CONTEXT_KEY = 'locale'

/** Request-scoped translator surface bound by {@link detectLocaleMiddleware}. */
export type TranslatorBinding = { t: Translator['t']; tc: Translator['tc'] }

/** Reads the `locale` context variable, whoever set it. */
export function getRequestLocale(c: Context): string | undefined {
  const locale = (c.var as Record<string, unknown> | undefined)?.[LOCALE_CONTEXT_KEY]
  return typeof locale === 'string' && locale.length > 0 ? locale : undefined
}

/** The request-scoped translator bound by {@link detectLocaleMiddleware}. */
export function getRequestTranslator(c: Context): TranslatorBinding | undefined {
  const vars = c.var as Record<string, unknown> | undefined
  const t = vars?.['t']
  const tc = vars?.['tc']
  return typeof t === 'function' && typeof tc === 'function'
    ? ({ t, tc } as TranslatorBinding)
    : undefined
}

export type LocaleSource = 'query' | 'cookie' | 'header'

/** Context variables set by {@link detectLocaleMiddleware}, for typing Hono apps. */
export type DetectLocaleVariables = {
  locale: string
  t?: Translator['t']
  tc?: Translator['tc']
}

export interface DetectLocaleOptions {
  /** Locales the app supports. Detection only ever resolves to one of these. */
  supported: readonly string[]
  /** Locale used when no source matches (defaults to the first supported locale). */
  fallback?: string
  /** Detection order (defaults to `['query', 'cookie', 'header']`). */
  sources?: readonly LocaleSource[]
  /** Query parameter to read (defaults to `locale`). */
  queryParam?: string
  /** Cookie to read (defaults to `locale`). */
  cookieName?: string
  /**
   * Manager backing the request-scoped `t`/`tc` helpers. Defaults to the
   * global one registered via `setI18n()`; `false` skips the binding.
   */
  i18n?: I18nManager | false
}

const DEFAULT_SOURCES: readonly LocaleSource[] = ['query', 'cookie', 'header']

/**
 * Resolves the request locale from the query string, a cookie, or
 * `Accept-Language`, restricted to the `supported` allowlist, and stores it as
 * the `locale` context variable that Inertia reads for `<html lang>`.
 */
export function detectLocaleMiddleware(options: DetectLocaleOptions) {
  const supported = options.supported.map((locale) => locale.trim()).filter(Boolean)

  if (supported.length === 0) {
    throw new Error('detectLocaleMiddleware requires at least one supported locale.')
  }

  const fallback = options.fallback ?? supported[0]!
  const sources = options.sources ?? DEFAULT_SOURCES
  const queryParam = options.queryParam ?? 'locale'
  const cookieName = options.cookieName ?? 'locale'

  // Case-insensitive lookup, built once: exact match wins over the primary
  // subtag (`ja-JP` → `ja`). Values keep the casing from `supported`.
  const byLowerCase = new Map(supported.map((locale) => [locale.toLowerCase(), locale]))

  const match = (candidate: string | undefined): string | undefined => {
    const value = candidate?.trim().toLowerCase()
    if (!value) {
      return undefined
    }
    return byLowerCase.get(value) ?? byLowerCase.get(value.split('-')[0]!)
  }

  const matchHeader = (header: string | undefined): string | undefined => {
    if (!header) {
      return undefined
    }
    // parseAccept returns entries sorted by descending quality.
    for (const accept of parseAccept(header)) {
      if (accept.type === '*' || accept.q <= 0) {
        continue
      }
      const matched = match(accept.type)
      if (matched) {
        return matched
      }
    }
    return undefined
  }

  // Only supported, already-loaded locales are cached, so an unvalidated
  // override from downstream middleware cannot grow the map without bound.
  // Messages added to the manager after a locale is cached are not picked up.
  const translators = new Map<string, TranslatorBinding>()
  const supportedSet = new Set(supported)

  const bindingFor = (locale: string, i18n: I18nManager): TranslatorBinding => {
    const cached = translators.get(locale)
    if (cached) {
      return cached
    }

    const translator = i18n.forLocale(locale)
    const binding: TranslatorBinding = {
      t: translator.t.bind(translator),
      tc: translator.tc.bind(translator),
    }
    if (supportedSet.has(locale) && i18n.isLocaleLoaded(locale)) {
      translators.set(locale, binding)
    }
    return binding
  }

  return createMiddleware<{ Variables: DetectLocaleVariables }>(async (c, next) => {
    const readers: Record<LocaleSource, () => string | undefined> = {
      query: () => match(c.req.query(queryParam)),
      cookie: () => match(getCookie(c, cookieName)),
      header: () => matchHeader(c.req.header('Accept-Language')),
    }

    let resolved = fallback
    for (const source of sources) {
      const matched = readers[source]()
      if (matched) {
        resolved = matched
        break
      }
    }

    c.set(LOCALE_CONTEXT_KEY, resolved)

    const i18n = options.i18n === false ? undefined : options.i18n ?? tryGetI18n()
    if (i18n) {
      await i18n.loadLocale(resolved).catch(() => {})

      // Per call, not per request: middleware running after detection may
      // override the `locale` context variable, and t/tc must follow it.
      const current = () => bindingFor(getRequestLocale(c) ?? resolved, i18n)
      c.set('t', (key, replacements) => current().t(key, replacements))
      c.set('tc', (key, count, replacements) => current().tc(key, count, replacements))
    }

    await next()
  })
}
