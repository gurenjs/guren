import { describe, expect, it } from 'bun:test'
import { Application } from '../src'

/**
 * An Application that boots twice mounts security middleware and routes twice,
 * so every request runs a duplicated middleware chain. `boot()` therefore
 * reuses its first call — these tests pin that for the sequential and the
 * concurrent case, and for the retry after a boot that threw.
 */
function createCountingApp() {
  let bootCallbackCalls = 0
  let middlewareCalls = 0

  const app = new Application({
    boot: (hono) => {
      bootCallbackCalls++
      hono.use('*', async (_c, next) => {
        middlewareCalls++
        await next()
      })
      hono.get('/ping', (c) => c.text('pong'))
    },
  })

  return {
    app,
    get bootCallbackCalls() {
      return bootCallbackCalls
    },
    get middlewareCalls() {
      return middlewareCalls
    },
  }
}

describe('Application.boot idempotency', () => {
  it('runs the boot callback once when booted twice in sequence', async () => {
    const counting = createCountingApp()

    await counting.app.boot()
    await counting.app.boot()

    expect(counting.bootCallbackCalls).toBe(1)
  })

  it('runs the boot callback once when two callers boot concurrently', async () => {
    const counting = createCountingApp()

    await Promise.all([counting.app.boot(), counting.app.boot()])

    expect(counting.bootCallbackCalls).toBe(1)
  })

  it('mounts each middleware and route on Hono only once', async () => {
    const counting = createCountingApp()

    await counting.app.boot()
    const mountedAfterFirstBoot = counting.app.hono.routes.length
    await counting.app.boot()

    expect(counting.app.hono.routes.length).toBe(mountedAfterFirstBoot)
  })

  it('serves requests normally after a repeated boot', async () => {
    const counting = createCountingApp()

    await counting.app.boot()
    await counting.app.boot()
    const response = await counting.app.fetch(new Request('http://localhost/ping'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('pong')
    expect(counting.middlewareCalls).toBe(1)
  })

  it('attempts boot again after a boot that threw', async () => {
    let attempts = 0
    const app = new Application({
      boot: () => {
        attempts++
        if (attempts === 1) {
          throw new Error('database unavailable')
        }
      },
    })

    await expect(app.boot()).rejects.toThrow('database unavailable')
    await app.boot()

    expect(attempts).toBe(2)
  })
})
