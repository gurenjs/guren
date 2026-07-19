import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { detectLocaleMiddleware, type DetectLocaleOptions } from './detect-locale'
import { Container } from '../../container/Container'
import { createI18n } from '../../i18n'

function createApp(options: DetectLocaleOptions, withI18n = false) {
  const app = new Hono()

  if (withI18n) {
    app.use('*', async (c, next) => {
      const container = new Container()
      container.singleton('i18n', () =>
        createI18n({
          locale: 'en',
          fallbackLocale: 'en',
          messages: {
            en: { greeting: 'Hello' },
            ja: { greeting: 'こんにちは' },
          },
        }),
      )
      c.set('container' as never, container as never)
      await next()
    })
  }

  app.use('*', detectLocaleMiddleware(options))
  app.get('/page', (c) =>
    c.json({
      locale: c.get('locale' as never) as string,
      greeting: (c.get('t' as never) as ((key: string) => string) | undefined)?.('greeting'),
    }),
  )

  return app
}

async function resolve(
  app: Hono,
  init: { path?: string; headers?: Record<string, string> } = {},
): Promise<{ locale: string; greeting?: string }> {
  const response = await app.request(init.path ?? '/page', { headers: init.headers })
  return response.json() as Promise<{ locale: string; greeting?: string }>
}

describe('detectLocaleMiddleware', () => {
  const supported = { supported: ['en', 'ja'] }

  test('falls back to the first supported locale when nothing matches', async () => {
    expect((await resolve(createApp(supported))).locale).toBe('en')
  })

  test('honors an explicit fallback', async () => {
    const app = createApp({ supported: ['en', 'ja'], fallback: 'ja' })
    expect((await resolve(app)).locale).toBe('ja')
  })

  test('reads the locale query parameter first', async () => {
    const app = createApp(supported)
    const result = await resolve(app, {
      path: '/page?locale=ja',
      headers: { 'Accept-Language': 'en' },
    })
    expect(result.locale).toBe('ja')
  })

  test('ignores unsupported query values', async () => {
    expect((await resolve(createApp(supported), { path: '/page?locale=fr' })).locale).toBe('en')
  })

  test('reads the locale cookie', async () => {
    const result = await resolve(createApp(supported), { headers: { Cookie: 'locale=ja' } })
    expect(result.locale).toBe('ja')
  })

  test('matches Accept-Language with region subtags and q-values', async () => {
    const result = await resolve(createApp(supported), {
      headers: { 'Accept-Language': 'fr-FR, ja-JP;q=0.8, en;q=0.5' },
    })
    expect(result.locale).toBe('ja')
  })

  test('skips wildcard Accept-Language entries', async () => {
    const result = await resolve(createApp(supported), { headers: { 'Accept-Language': '*' } })
    expect(result.locale).toBe('en')
  })

  test('respects a custom source order', async () => {
    const app = createApp({ supported: ['en', 'ja'], sources: ['header', 'query'] })
    const result = await resolve(app, {
      path: '/page?locale=ja',
      headers: { 'Accept-Language': 'en' },
    })
    expect(result.locale).toBe('en')
  })

  test('binds request-scoped translator helpers when i18n is available', async () => {
    const app = createApp(supported, true)
    const result = await resolve(app, { path: '/page?locale=ja' })
    expect(result.locale).toBe('ja')
    expect(result.greeting).toBe('こんにちは')
  })

  test('skips translator binding when disabled', async () => {
    const app = createApp({ supported: ['en', 'ja'], translator: false }, true)
    const result = await resolve(app, { path: '/page?locale=ja' })
    expect(result.greeting).toBeUndefined()
  })

  test('throws when no supported locales are given', () => {
    expect(() => detectLocaleMiddleware({ supported: [] })).toThrow()
  })
})
