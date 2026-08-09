import { describe, test, expect, afterEach } from 'bun:test'
import { Controller, createApp, MemoryLoader, I18nServiceProvider, type I18nManager, type I18nPluginOptions } from '../../src'
import { setInertiaSharedProps } from '../../src/mvc/inertia/shared'

const MESSAGES = {
  en: {
    messages: {
      hello: 'Hello',
      welcome: 'Welcome, :name!',
      items: 'One item|:count items',
      enOnly: 'English only',
    },
  },
  ja: {
    messages: {
      hello: 'こんにちは',
      welcome: 'ようこそ、:nameさん！',
      items: ':count個',
    },
  },
}

class GreetingController extends Controller {
  async show() {
    return this.json({
      locale: this.locale,
      hello: this.t('messages.hello'),
      welcome: this.t('messages.welcome', { name: 'Guren' }),
      many: this.tc('messages.items', 5),
      fallback: this.t('messages.enOnly'),
    })
  }
}

class PageController extends Controller {
  async show() {
    return this.inertia('Docs/Show', {})
  }
}

function makeApp(overrides: Partial<I18nPluginOptions> = {}) {
  const app = createApp({
    i18n: {
      supported: ['en', 'ja'],
      loader: new MemoryLoader(structuredClone(MESSAGES)),
      ...overrides,
    },
  })
  app.router.get('/greet', [GreetingController, 'show'])
  app.router.get('/page', [PageController, 'show'])
  return app
}

async function greet(app: ReturnType<typeof makeApp>, path = '/greet', headers: Record<string, string> = {}) {
  const response = await app.fetch(new Request(`http://example.com${path}`, { headers }))
  expect(response.status).toBe(200)
  return response.json() as Promise<Record<string, string>>
}

async function inertiaPageProps(app: ReturnType<typeof makeApp>, path = '/page'): Promise<Record<string, any>> {
  const response = await app.fetch(
    new Request(`http://example.com${path}`, {
      headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' },
    }),
  )
  expect(response.status).toBe(200)
  const page = (await response.json()) as { props: Record<string, any> }
  return page.props
}

afterEach(() => {
  // The Inertia shared-props resolver is module-global state; each booted
  // app's I18nServiceProvider appends to it.
  setInertiaSharedProps(null)
})

describe('createApp({ i18n })', () => {
  test('preloads every supported locale during boot', async () => {
    const app = makeApp()
    await app.boot()

    const manager = app.container.make<I18nManager>('i18n')
    expect(manager.isLocaleLoaded('en')).toBe(true)
    expect(manager.isLocaleLoaded('ja')).toBe(true)
  })

  test('throws when supported is empty', async () => {
    const app = makeApp({ supported: [] })
    await expect(app.boot()).rejects.toThrow('at least one supported locale')
  })

  test('controller t/tc/locale use the fallback locale by default', async () => {
    const app = makeApp()
    await app.boot()

    expect(await greet(app)).toEqual({
      locale: 'en',
      hello: 'Hello',
      welcome: 'Welcome, Guren!',
      many: '5 items',
      fallback: 'English only',
    })
  })

  test('locale detection resolves the query parameter and translates per request', async () => {
    const app = makeApp()
    await app.boot()

    expect(await greet(app, '/greet?locale=ja')).toEqual({
      locale: 'ja',
      hello: 'こんにちは',
      welcome: 'ようこそ、Gurenさん！',
      many: '5個',
      fallback: 'English only',
    })
  })

  test('locale detection resolves Accept-Language', async () => {
    const app = makeApp()
    await app.boot()

    const body = await greet(app, '/greet', { 'Accept-Language': 'ja-JP,ja;q=0.9' })
    expect(body.locale).toBe('ja')
    expect(body.hello).toBe('こんにちは')
  })

  test('detect: false skips the locale detection middleware', async () => {
    const app = makeApp({ detect: false })
    await app.boot()

    const body = await greet(app, '/greet?locale=ja')
    expect(body.locale).toBe('en')
    expect(body.hello).toBe('Hello')
  })

  test('shares _i18n with Inertia pages for the resolved locale', async () => {
    const app = makeApp()
    await app.boot()

    const props = await inertiaPageProps(app, '/page?locale=ja')
    expect(props._i18n.locale).toBe('ja')
    expect(props._i18n.fallbackLocale).toBe('en')
    expect(Object.keys(props._i18n.messages)).toEqual(['en', 'ja'])
    expect(props._i18n.messages.ja.messages.hello).toBe('こんにちは')
  })

  test('shares only the fallback messages when it is the resolved locale', async () => {
    const app = makeApp()
    await app.boot()

    const props = await inertiaPageProps(app)
    expect(props._i18n.locale).toBe('en')
    expect(Object.keys(props._i18n.messages)).toEqual(['en'])
  })

  test('share: false leaves Inertia props untouched', async () => {
    const app = makeApp({ share: false })
    await app.boot()

    const props = await inertiaPageProps(app)
    expect(props._i18n).toBeUndefined()
  })

  test('fallback option overrides the first supported locale', async () => {
    const app = makeApp({ supported: ['en', 'ja'], fallback: 'ja' })
    await app.boot()

    const body = await greet(app)
    expect(body.locale).toBe('ja')
    expect(body.hello).toBe('こんにちは')
  })

  test('a user-supplied I18nServiceProvider subclass owns the wiring', async () => {
    let registered = 0

    class CustomI18nProvider extends I18nServiceProvider {
      override register(): void {
        registered += 1
        super.register()
      }
    }

    const app = createApp({
      i18n: { supported: ['en'], loader: new MemoryLoader(structuredClone(MESSAGES)) },
      providers: [CustomI18nProvider],
    })
    app.router.get('/greet', [GreetingController, 'show'])
    await app.boot()

    expect(registered).toBe(1)
    const body = await greet(app)
    expect(body.hello).toBe('Hello')
  })

  test('a downstream locale override is honored by t/tc, locale, and _i18n alike', async () => {
    // Simulates middleware running after locale detection that replaces the
    // request locale (e.g. a per-user preference read from the session).
    const app = createApp({
      i18n: { supported: ['en', 'ja'], loader: new MemoryLoader(structuredClone(MESSAGES)) },
      boot: (hono) => {
        hono.use('*', async (c, next) => {
          c.set('locale' as never, 'ja' as never)
          await next()
        })
      },
    })
    app.router.get('/greet', [GreetingController, 'show'])
    app.router.get('/page', [PageController, 'show'])
    await app.boot()

    const body = await greet(app)
    expect(body.locale).toBe('ja')
    expect(body.hello).toBe('こんにちは')

    const props = await inertiaPageProps(app)
    expect(props._i18n.locale).toBe('ja')
  })

  test('rejects a fallback that is not in supported', async () => {
    const app = makeApp({ fallback: 'fr' })
    await expect(app.boot()).rejects.toThrow('fallback')
  })

  test('loads lang/<locale>/*.json fixtures through the default JsonLoader path', async () => {
    const app = createApp({
      i18n: { supported: ['en', 'ja'], path: new URL('./fixtures/lang', import.meta.url).pathname },
    })
    app.router.get('/greet', [GreetingController, 'show'])
    await app.boot()

    const body = await greet(app, '/greet?locale=ja')
    expect(body.hello).toBe('こんにちは')
    expect(body.fallback).toBe('English only')
  })
})
