/**
 * RFC 0023 Part 2: the module-level accessors warn once and write the ambient
 * app's container, while the functional helpers built on them stay silent.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { Application, createApp } from '../../src/http/Application'
import { Controller } from '../../src/mvc/Controller'
import { detectLocaleMiddleware } from '../../src/http/middleware/detect-locale'
import { createGate, defineGate, can, getGate, setGate } from '../../src/authorization/Gate'
import { createEncrypter, decrypt, encrypt, generateKey, getEncrypter, setEncrypter } from '../../src/encryption'
import { createI18n, getI18n, setI18n, t, tryGetI18n } from '../../src/i18n/I18nManager'
import { createLogManager, getLogManager, setLogManager } from '../../src/logging/LogManager'
import { getContainer, setContainer, createContainer } from '../../src/container/Container'
import { setInertiaDocument, setInertiaSsrRenderer } from '../../src/mvc/inertia/InertiaEngine'
import { resetDefaultApplication } from '../../src/http/default-application'
import { resetWarnOnce } from '../../src/support/warn-once'


function i18n() {
  return createI18n({ locale: 'en', fallbackLocale: 'en', messages: { en: { hello: 'Hello' } } })
}

describe('the deprecated service accessors', () => {
  let warn: ReturnType<typeof spyOn>

  /** Every `console.warn` message this test has seen, as strings. */
  const warned = (): string[] => (warn.mock.calls as unknown[][]).map((call) => String(call[0]))

  beforeEach(() => {
    resetDefaultApplication()
    resetWarnOnce()
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    resetDefaultApplication()
    resetWarnOnce()
    setInertiaDocument(undefined)
    setInertiaSsrRenderer(undefined)
  })

  it('warns once per symbol, in the deprecation policy format', () => {
    const app = new Application()
    setGate(createGate())
    setGate(createGate())
    getGate()

    const messages = warned()
    expect(messages.filter((message: string) => message.includes('setGate()'))).toHaveLength(1)
    expect(messages.filter((message: string) => message.includes('getGate()'))).toHaveLength(1)
    expect(messages[0]).toContain('[guren] Deprecation (global-service-setters): setGate() is deprecated')
    expect(messages[0]).toContain('since 2.23.0, will be removed in 3.0.0.')
    expect(app.container.has('gate')).toBe(true)
  })

  it('binds the value on the ambient container, leaving no slot behind', () => {
    const app = new Application()
    const gate = createGate()
    setGate(gate)

    expect(app.container.make('gate')).toBe(gate)

    // Nothing is left in the module slot for a later app to inherit.
    resetDefaultApplication()
    expect(() => getGate()).toThrow('Gate not initialized')
  })

  it('falls back to the module slot when no application exists yet', () => {
    const gate = createGate()
    setGate(gate)

    expect(getGate()).toBe(gate)
  })

  it('keeps the locale middleware silent on its last-resort read', async () => {
    // No `i18n` option and no container binding, so the fallback every request
    // would otherwise warn from is the one actually taken.
    const hono = new Hono()
    hono.use(detectLocaleMiddleware({ supported: ['en'] }))
    hono.get('/', (c) => c.text('ok'))

    await hono.request('/', { headers: { 'accept-language': 'en' } })

    expect(warned().filter((message) => message.includes('Deprecation'))).toEqual([])
  })

  it('keeps a controller silent when its container binds no i18n', async () => {
    class LocaleController extends Controller {
      async show() {
        try {
          return this.json({ text: this.t('hello') })
        } catch {
          return this.json({ text: null })
        }
      }
    }

    const app = createApp({
      routes: (router) => {
        router.get('/locale', [LocaleController, 'show'])
      },
    })
    await app.boot()

    // Whether the ambient read finds a manager depends on what else ran in this
    // process; that it is reached at all is what this asserts, and the app's own
    // container binds no i18n for it to short-circuit on.
    expect((await app.hono.request('/locale')).status).toBe(200)
    expect(warned().filter((message) => message.includes('Deprecation'))).toEqual([])
  })

  it('keeps the functional helpers silent', async () => {
    const app = new Application()
    app.container.instance('encrypter', createEncrypter({ key: generateKey() }))
    app.container.instance('gate', createGate())
    app.container.instance('i18n', i18n())

    defineGate('enter', () => true)
    expect(await can('enter')).toBe(true)
    expect(decrypt<string>(encrypt('secret'))).toBe('secret')
    expect(t('hello')).toBe('Hello')

    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a booted application silent', async () => {
    const app = new Application()
    await app.boot()

    expect(warned().filter((message: string) => message.includes('Deprecation'))).toEqual([])
  })

  it('warns for every accessor an app can still call', () => {
    const app = new Application()
    setEncrypter(createEncrypter({ key: generateKey() }))
    getEncrypter()
    setI18n(i18n())
    getI18n()
    tryGetI18n()
    setLogManager(createLogManager({ default: 'null', channels: { null: { driver: 'null' } } }))
    getLogManager()
    setContainer(createContainer())
    getContainer()
    setInertiaDocument({ head: '<meta name="x" content="y">' })
    setInertiaSsrRenderer(undefined)

    const symbols = warned()
      .filter((message: string) => message.includes('Deprecation'))
      .map((message: string) => message.match(/\): (\w+)\(\)/)?.[1])

    expect(new Set(symbols)).toEqual(
      new Set([
        'setEncrypter',
        'getEncrypter',
        'setI18n',
        'getI18n',
        'tryGetI18n',
        'setLogManager',
        'getLogManager',
        'setContainer',
        'getContainer',
        'setInertiaDocument',
        'setInertiaSsrRenderer',
      ]),
    )
    expect(app.container.has('encrypter')).toBe(true)
  })
})
