import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import {
  detectLocaleMiddleware,
  type DetectLocaleOptions,
  type DetectLocaleVariables,
} from './detect-locale'
import { createI18n } from '../../i18n'

const baseOptions: DetectLocaleOptions = { supported: ['en', 'ja'] }

function createTestI18n() {
  return createI18n({
    locale: 'en',
    fallbackLocale: 'en',
    messages: {
      en: { greeting: 'Hello' },
      ja: { greeting: 'こんにちは' },
    },
  })
}

function createApp(options: DetectLocaleOptions) {
  const app = new Hono<{ Variables: DetectLocaleVariables }>()

  app.use('*', detectLocaleMiddleware(options))
  app.get('/page', (c) =>
    c.json({
      locale: c.get('locale'),
      greeting: c.get('t')?.('greeting'),
    }),
  )

  return app
}

async function resolve(
  app: Hono<{ Variables: DetectLocaleVariables }>,
  init: { path?: string; headers?: Record<string, string> } = {},
): Promise<{ locale: string; greeting?: string }> {
  const response = await app.request(init.path ?? '/page', { headers: init.headers })
  return response.json() as Promise<{ locale: string; greeting?: string }>
}

describe('detectLocaleMiddleware', () => {
  test('falls back to the first supported locale when nothing matches', async () => {
    expect((await resolve(createApp(baseOptions))).locale).toBe('en')
  })

  test('honors an explicit fallback', async () => {
    const app = createApp({ ...baseOptions, fallback: 'ja' })
    expect((await resolve(app)).locale).toBe('ja')
  })

  test('reads the locale query parameter first', async () => {
    const result = await resolve(createApp(baseOptions), {
      path: '/page?locale=ja',
      headers: { 'Accept-Language': 'en' },
    })
    expect(result.locale).toBe('ja')
  })

  test('ignores unsupported query values', async () => {
    expect((await resolve(createApp(baseOptions), { path: '/page?locale=fr' })).locale).toBe('en')
  })

  test('reads the locale cookie', async () => {
    const result = await resolve(createApp(baseOptions), { headers: { Cookie: 'locale=ja' } })
    expect(result.locale).toBe('ja')
  })

  test('matches Accept-Language with region subtags and q-values', async () => {
    const result = await resolve(createApp(baseOptions), {
      headers: { 'Accept-Language': 'fr-FR, ja-JP;q=0.8, en;q=0.5' },
    })
    expect(result.locale).toBe('ja')
  })

  test('skips wildcard Accept-Language entries', async () => {
    const result = await resolve(createApp(baseOptions), { headers: { 'Accept-Language': '*' } })
    expect(result.locale).toBe('en')
  })

  test('respects a custom source order', async () => {
    const app = createApp({ ...baseOptions, sources: ['header', 'query'] })
    const result = await resolve(app, {
      path: '/page?locale=ja',
      headers: { 'Accept-Language': 'en' },
    })
    expect(result.locale).toBe('en')
  })

  test('binds request-scoped translator helpers from the i18n option', async () => {
    const app = createApp({ ...baseOptions, i18n: createTestI18n() })
    const result = await resolve(app, { path: '/page?locale=ja' })
    expect(result.locale).toBe('ja')
    expect(result.greeting).toBe('こんにちは')
  })

  test('reuses the cached translator binding across requests', async () => {
    const app = createApp({ ...baseOptions, i18n: createTestI18n() })

    const first = await resolve(app, { path: '/page?locale=ja' })
    const second = await resolve(app, { path: '/page?locale=ja' })
    expect(first.greeting).toBe('こんにちは')
    expect(second.greeting).toBe('こんにちは')
  })

  test('skips translator binding when disabled', async () => {
    const app = createApp({ ...baseOptions, i18n: false })
    const result = await resolve(app, { path: '/page?locale=ja' })
    expect(result.locale).toBe('ja')
    expect(result.greeting).toBeUndefined()
  })

  test('throws when no supported locales are given', () => {
    expect(() => detectLocaleMiddleware({ supported: [] })).toThrow()
  })
})
