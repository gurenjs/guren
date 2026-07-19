import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'

export type LocaleSource = 'query' | 'cookie' | 'header'

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
   * Bind request-scoped translator helpers (`t`, `tc`) when the i18n manager
   * is available in the container (defaults to `true`).
   */
  translator?: boolean
}

interface I18nLike {
  loadLocale?: (locale: string) => Promise<void>
  forLocale?: (locale: string) => {
    t: (key: string, params?: Record<string, unknown>) => string
    tc: (key: string, count: number, params?: Record<string, unknown>) => string
  }
}

const DEFAULT_SOURCES: readonly LocaleSource[] = ['query', 'cookie', 'header']

/**
 * Middleware that resolves the request locale from the query string, a cookie,
 * or the `Accept-Language` header — in that order by default — restricted to
 * the `supported` allowlist.
 *
 * The result is stored as the `locale` context variable, which Inertia
 * responses pick up for the root `<html lang>` attribute. When the i18n
 * manager is bound in the container, request-scoped `t`/`tc` translator
 * helpers are attached as well.
 *
 * @example
 * ```ts
 * import { detectLocaleMiddleware } from '@guren/core'
 *
 * app.use('*', detectLocaleMiddleware({ supported: ['en', 'ja'] }))
 * ```
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
  const bindTranslator = options.translator !== false

  return createMiddleware(async (c, next) => {
    let locale: string | undefined

    for (const source of sources) {
      if (source === 'query') {
        locale = matchSupported(supported, c.req.query(queryParam))
      } else if (source === 'cookie') {
        locale = matchSupported(supported, getCookie(c, cookieName))
      } else {
        locale = matchAcceptLanguage(supported, c.req.header('Accept-Language'))
      }

      if (locale) {
        break
      }
    }

    const resolved = locale ?? fallback
    c.set('locale' as never, resolved as never)

    if (bindTranslator) {
      const i18n = resolveI18n(c.var)

      if (i18n?.forLocale) {
        await i18n.loadLocale?.(resolved).catch(() => {})
        const translator = i18n.forLocale(resolved)
        c.set('t' as never, translator.t.bind(translator) as never)
        c.set('tc' as never, translator.tc.bind(translator) as never)
      }
    }

    await next()
  })
}

function resolveI18n(vars: unknown): I18nLike | undefined {
  const container = (vars as { container?: { has?: (key: string) => boolean; make?: (key: string) => unknown } } | undefined)
    ?.container

  if (!container?.has?.('i18n')) {
    return undefined
  }

  return container.make?.('i18n') as I18nLike | undefined
}

/** Match a candidate against the allowlist: exact first, then primary subtag (`ja-JP` → `ja`). */
function matchSupported(supported: readonly string[], candidate: string | undefined): string | undefined {
  const value = candidate?.trim()

  if (!value) {
    return undefined
  }

  const lower = value.toLowerCase()
  const exact = supported.find((locale) => locale.toLowerCase() === lower)
  if (exact) {
    return exact
  }

  const primary = lower.split('-')[0]!
  return supported.find((locale) => locale.toLowerCase() === primary)
}

/** Pick the highest-quality supported locale from an `Accept-Language` header. */
function matchAcceptLanguage(supported: readonly string[], header: string | undefined): string | undefined {
  if (!header) {
    return undefined
  }

  const candidates = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';')
      const qParam = params.map((param) => param.trim()).find((param) => param.startsWith('q='))
      const quality = qParam ? Number.parseFloat(qParam.slice(2)) : 1
      return { tag: tag?.trim() ?? '', quality: Number.isNaN(quality) ? 0 : quality }
    })
    .filter((candidate) => candidate.tag.length > 0 && candidate.quality > 0)
    .sort((a, b) => b.quality - a.quality)

  for (const candidate of candidates) {
    if (candidate.tag === '*') {
      continue
    }

    const match = matchSupported(supported, candidate.tag)
    if (match) {
      return match
    }
  }

  return undefined
}
