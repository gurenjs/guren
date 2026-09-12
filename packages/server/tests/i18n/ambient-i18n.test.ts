import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createApp } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { detectLocaleMiddleware, getRequestTranslator } from '../../src/http/middleware/detect-locale'
import { MemoryLoader, createI18n, setI18n, t, tc } from '../../src/i18n'
import { clearGlobalManager } from '../support/globals'

const loader = () => new MemoryLoader({
  en: { hello: 'Hello', items: 'One item|:count items' },
  fr: { hello: 'Bonjour' },
})

describe('i18n resolved through the container (RFC 0023 §4)', () => {
  afterEach(() => {
    resetDefaultApplication()
    clearGlobalManager(setI18n)
  })

  it('makes t() and tc() work in a createApp({ i18n }) app that never called setI18n()', async () => {
    const app = createApp({ i18n: { supported: ['en', 'fr'], loader: loader() } })
    await app.boot()

    expect(t('hello')).toBe('Hello')
    expect(tc('items', 3)).toBe('3 items')
  })

  it('binds the request translator from the serving app rather than the global manager', async () => {
    setI18n(createI18n({ locale: 'en', messages: { en: { hello: 'GLOBAL' } } }))
    const app = createApp({ i18n: { supported: ['en', 'fr'], loader: loader(), detect: false } })
    app.use('*', detectLocaleMiddleware({ supported: ['en', 'fr'] }))
    app.router.get('/hello', (c) => c.text(getRequestTranslator(c)!.t('hello')))
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/hello?locale=fr'))

    expect(await response.text()).toBe('Bonjour')
  })

  it('falls back to the global manager on a bare Hono app', async () => {
    setI18n(createI18n({ locale: 'en', messages: { en: { hello: 'GLOBAL' } } }))
    const hono = new Hono()
    hono.use('*', detectLocaleMiddleware({ supported: ['en'] }))
    hono.get('/hello', (c) => c.text(getRequestTranslator(c)!.t('hello')))

    const response = await hono.request('/hello')

    expect(await response.text()).toBe('GLOBAL')
  })
})
