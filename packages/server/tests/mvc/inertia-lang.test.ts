import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
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
  middleware?: MiddlewareHandler
} = {}) {
  const app = new Hono()

  if (options.middleware) {
    app.use('*', options.middleware)
  }

  app.get('/page', async (c) => {
    if (options.requestLocale) {
      c.set('locale' as never, options.requestLocale as never)
    }

    const ctrl = new PageController()
    ctrl.setContext(c)

    if (options.i18nLocale) {
      // Mirror the router: the container is injected into the controller.
      const container = new Container()
      container.singleton('i18n', () => createI18n({ locale: options.i18nLocale! }))
      ctrl.setContainer(container)
    }

    return ctrl[options.action ?? 'page']()
  })

  return app
}

async function htmlLangOf(app: Hono, headers: Record<string, string> = {}): Promise<string | undefined> {
  const response = await app.request('/page', { headers: { Accept: 'text/html', ...headers } })
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

  test('falls back to the router-injected container i18n locale', async () => {
    expect(await htmlLangOf(createApp({ i18nLocale: 'ja' }))).toBe('ja')
  })

  test('detectLocaleMiddleware feeds html lang end to end', async () => {
    const app = createApp({ middleware: detectLocaleMiddleware({ supported: ['en', 'ja'] }) })
    expect(await htmlLangOf(app, { 'Accept-Language': 'ja-JP' })).toBe('ja')
  })
})
