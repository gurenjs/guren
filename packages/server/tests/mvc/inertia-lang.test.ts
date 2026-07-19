import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Controller } from '../../src/mvc/Controller'
import { Container } from '../../src/container/Container'
import { createI18n } from '../../src/i18n'
import { detectLocaleMiddleware } from '../../src/http/middleware/detect-locale'

class PageController extends Controller {
  async page() {
    return this.inertia('Docs/Show', {}, {})
  }

  async pageWithLang() {
    return this.inertia('Docs/Show', {}, { lang: 'fr' })
  }
}

function createApp(options: {
  requestLocale?: string
  i18nLocale?: string
  action?: 'page' | 'pageWithLang'
} = {}) {
  const app = new Hono()

  app.get('/page', async (c) => {
    if (options.requestLocale) {
      c.set('locale' as never, options.requestLocale as never)
    }

    if (options.i18nLocale) {
      const container = new Container()
      container.singleton('i18n', () => createI18n({ locale: options.i18nLocale! }))
      c.set('container' as never, container as never)
    }

    const ctrl = new PageController()
    ctrl.setContext(c)
    return ctrl[options.action ?? 'page']()
  })

  return app
}

async function htmlLangOf(app: Hono): Promise<string | undefined> {
  const response = await app.request('/page', { headers: { Accept: 'text/html' } })
  const html = await response.text()
  return html.match(/<html lang="([^"]+)"/u)?.[1]
}

describe('Inertia html lang resolution', () => {
  test('defaults to en without locale context or i18n binding', async () => {
    expect(await htmlLangOf(createApp())).toBe('en')
  })

  test('explicit options.lang wins over everything', async () => {
    const app = createApp({ requestLocale: 'ja', i18nLocale: 'de', action: 'pageWithLang' })
    expect(await htmlLangOf(app)).toBe('fr')
  })

  test('uses the request-scoped locale context variable', async () => {
    expect(await htmlLangOf(createApp({ requestLocale: 'ja' }))).toBe('ja')
  })

  test('request-scoped locale wins over the app-wide i18n locale', async () => {
    expect(await htmlLangOf(createApp({ requestLocale: 'ja', i18nLocale: 'de' }))).toBe('ja')
  })

  test('falls back to the i18n container locale', async () => {
    expect(await htmlLangOf(createApp({ i18nLocale: 'ja' }))).toBe('ja')
  })

  test('detectLocaleMiddleware feeds html lang end to end', async () => {
    const app = new Hono()
    app.use('*', detectLocaleMiddleware({ supported: ['en', 'ja'] }))
    app.get('/page', async (c) => {
      const ctrl = new PageController()
      ctrl.setContext(c)
      return ctrl.page()
    })

    const response = await app.request('/page', {
      headers: { Accept: 'text/html', 'Accept-Language': 'ja-JP' },
    })
    const html = await response.text()

    expect(html).toContain('<html lang="ja"')
  })
})
