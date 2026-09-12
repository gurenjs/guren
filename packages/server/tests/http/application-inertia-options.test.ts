import { afterEach, describe, expect, it } from 'bun:test'
import { Controller } from '../../src/mvc/Controller'
import { createApp } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { setInertiaDocument, setInertiaSsrRenderer } from '../../src/mvc/inertia/InertiaEngine'

class PageController extends Controller {
  async show() {
    return this.inertia('Docs/Show', { page: 1 })
  }

  async showWithOwnRenderer() {
    return this.inertia('Docs/Show', { page: 1 }, {
      ssr: { render: async () => ({ head: [], body: '<div id="app">per-call</div>' }) },
    })
  }
}

async function render(app: ReturnType<typeof createApp>, action: 'show' | 'showWithOwnRenderer' = 'show'): Promise<string> {
  app.router.get('/page', [PageController, action])
  await app.boot()
  const response = await app.fetch(new Request('http://example.com/page', { headers: { Accept: 'text/html' } }))
  return response.text()
}

describe('createApp({ inertia })', () => {
  afterEach(() => {
    setInertiaDocument(undefined)
    setInertiaSsrRenderer(undefined)
    resetDefaultApplication()
  })

  it('binds the document defaults on the container and renders from them', async () => {
    const app = createApp({ inertia: { document: { head: '<meta name="app" content="bound">' } } })

    expect(app.container.make('inertia.document')).toEqual({ head: '<meta name="app" content="bound">' })
    expect(await render(app)).toContain('<meta name="app" content="bound">')
  })

  it('wins over the process-wide setInertiaDocument() for its own app only', async () => {
    setInertiaDocument({ head: '<meta name="app" content="global">' })
    const bound = createApp({ inertia: { document: { head: '<meta name="app" content="bound">' } } })
    const plain = createApp()

    const boundHtml = await render(bound)
    const plainHtml = await render(plain)

    expect(boundHtml).toContain('content="bound"')
    expect(boundHtml).not.toContain('content="global"')
    expect(plainHtml).toContain('content="global"')
  })

  it('binds the SSR renderer and uses it, with a per-call renderer still winning', async () => {
    const app = createApp({
      inertia: { ssrRenderer: async () => ({ head: [], body: '<div id="app">bound</div>' }) },
    })

    expect(app.container.has('inertia.ssrRenderer')).toBe(true)
    expect(await render(app)).toContain('<div id="app">bound</div>')

    const second = createApp({
      inertia: { ssrRenderer: async () => ({ head: [], body: '<div id="app">bound</div>' }) },
    })
    expect(await render(second, 'showWithOwnRenderer')).toContain('<div id="app">per-call</div>')
  })

  it('binds nothing without the option', () => {
    const app = createApp()

    expect(app.container.has('inertia.document')).toBe(false)
    expect(app.container.has('inertia.ssrRenderer')).toBe(false)
  })
})
