import { describe, expect, it } from 'vitest'
import { TestApp } from './test-app'

/**
 * Minimal ApplicationLike whose fetch reads instance state, mirroring
 * @guren/server's Application — an unbound `app.fetch` reference throws.
 */
class FakeApplication {
  bootCalls = 0
  booted?: boolean
  private response = 'not booted'

  constructor(withBootedFlag: boolean) {
    if (withBootedFlag) {
      this.booted = false
    }
  }

  async boot(): Promise<void> {
    this.bootCalls++
    this.response = 'ok'
    if (this.booted !== undefined) {
      this.booted = true
    }
  }

  fetch(request: Request): Response {
    return new Response(`${this.response} ${new URL(request.url).pathname}`)
  }
}

describe('TestApp.fromApp', () => {
  it('boots the app and binds fetch to the instance', async () => {
    const app = new FakeApplication(true)

    const http = await TestApp.fromApp(app)
    const response = await http.get('/posts')

    expect(app.bootCalls).toBe(1)
    expect(await response.text()).toBe('ok /posts')
  })

  it('does not boot again when the app reports booted: true', async () => {
    const app = new FakeApplication(true)
    await app.boot()

    await TestApp.fromApp(app)

    expect(app.bootCalls).toBe(1)
  })

  it('boots an app without a booted property at most once across calls', async () => {
    const app = new FakeApplication(false)

    await TestApp.fromApp(app)
    await TestApp.fromApp(app)

    expect(app.bootCalls).toBe(1)
  })

  it('retries boot on a later call when the first boot throws', async () => {
    const app = new FakeApplication(false)
    let failFirstBoot = true
    const originalBoot = app.boot.bind(app)
    app.boot = async () => {
      if (failFirstBoot) {
        failFirstBoot = false
        throw new Error('database unavailable')
      }
      await originalBoot()
    }

    await expect(TestApp.fromApp(app)).rejects.toThrow('database unavailable')

    const http = await TestApp.fromApp(app)
    await http.get('/').assertOk()
    expect(app.bootCalls).toBe(1)
  })

  it('respects a custom base URL', async () => {
    const app = new FakeApplication(true)
    let seenUrl: string | undefined
    app.fetch = (request: Request) => {
      seenUrl = request.url
      return new Response('ok')
    }

    const http = await TestApp.fromApp(app, 'http://example.test')
    await http.get('/x')

    expect(seenUrl).toBe('http://example.test/x')
  })

  it('enables GUREN_TESTING so actingAs works against the app', async () => {
    delete process.env.GUREN_TESTING

    await TestApp.fromApp(new FakeApplication(true))

    expect(process.env.GUREN_TESTING).toBe('1')
  })
})
