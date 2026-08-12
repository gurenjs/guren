import { describe, expect, it } from 'vitest'
import { TestApp } from './test-app'

/**
 * Minimal ApplicationLike whose fetch reads instance state, mirroring
 * @guren/server's Application — an unbound `app.fetch` reference throws.
 * Its `boot()` is idempotent for the same reason the real one is.
 */
class FakeApplication {
  bootCalls = 0
  failNextBoot = false
  private booted = false
  private response = 'not booted'

  async boot(): Promise<void> {
    if (this.failNextBoot) {
      this.failNextBoot = false
      throw new Error('database unavailable')
    }
    if (this.booted) return

    this.bootCalls++
    this.response = 'ok'
    this.booted = true
  }

  fetch(request: Request): Response {
    return new Response(`${this.response} ${new URL(request.url).pathname}`)
  }
}

describe('TestApp.fromApp', () => {
  it('boots the app and binds fetch to the instance', async () => {
    const app = new FakeApplication()

    const http = await TestApp.fromApp(app)
    const response = await http.get('/posts')

    expect(app.bootCalls).toBe(1)
    expect(await response.text()).toBe('ok /posts')
  })

  it('leaves booting to the app, so repeated calls boot once', async () => {
    const app = new FakeApplication()

    await TestApp.fromApp(app)
    await TestApp.fromApp(app)

    expect(app.bootCalls).toBe(1)
  })

  it('propagates a boot failure instead of returning an unbooted TestApp', async () => {
    const app = new FakeApplication()
    app.failNextBoot = true

    await expect(TestApp.fromApp(app)).rejects.toThrow('database unavailable')

    const http = await TestApp.fromApp(app)
    await http.get('/').assertOk()
  })

  it('respects a custom base URL', async () => {
    const app = new FakeApplication()
    let seenUrl: string | undefined
    app.fetch = (request: Request) => {
      seenUrl = request.url
      return new Response('ok')
    }

    const http = await TestApp.fromApp(app, 'http://example.test')
    await http.get('/x')

    expect(seenUrl).toBe('http://example.test/x')
  })

  it('enables GUREN_TESTING before booting, so boot-time code sees test mode', async () => {
    delete process.env.GUREN_TESTING
    let seenDuringBoot: string | undefined

    const app = new FakeApplication()
    const originalBoot = app.boot.bind(app)
    app.boot = async () => {
      seenDuringBoot = process.env.GUREN_TESTING
      await originalBoot()
    }

    await TestApp.fromApp(app)

    expect(seenDuringBoot).toBe('1')
  })
})

describe('TestApp.query', () => {
  it('sends a QUERY request with a JSON body', async () => {
    const app = {
      async boot(): Promise<void> {},
      async fetch(request: Request): Promise<Response> {
        return Response.json({
          method: request.method,
          contentType: request.headers.get('content-type'),
          body: await request.json(),
        })
      },
    }

    const http = await TestApp.fromApp(app)
    const response = await http.query('/search', { q: 'hello', limit: 10 })

    expect(await response.json()).toEqual({
      method: 'QUERY',
      contentType: 'application/json',
      body: { q: 'hello', limit: 10 },
    })
  })
})
