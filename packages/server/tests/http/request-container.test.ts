import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Application } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import {
  CONTAINER_CONTEXT_KEY,
  getRequestContainer,
  tryGetRequestContainer,
} from '../../src/http/request-container'

describe('the request container stamp', () => {
  afterEach(() => {
    resetDefaultApplication()
  })

  it('hands a route the container of the Application serving it', async () => {
    const app = new Application()
    app.router.get('/probe', (c) => c.json({ own: getRequestContainer(c) === app.container }))
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/probe'))

    expect(await response.json()).toEqual({ own: true })
  })

  it('runs ahead of middleware an app registers before boot', async () => {
    const app = new Application()
    let seen: unknown = 'unset'
    app.use('*', async (c, next) => {
      seen = c.get(CONTAINER_CONTEXT_KEY)
      await next()
    })
    app.router.get('/probe', (c) => c.text('ok'))
    await app.boot()

    await app.fetch(new Request('http://example.com/probe'))

    expect(seen).toBe(app.container)
  })

  it('keeps two applications in one process apart', async () => {
    const first = new Application()
    const second = new Application()
    for (const app of [first, second]) {
      app.router.get('/probe', (c) => c.json({ first: getRequestContainer(c) === first.container }))
      await app.boot()
    }

    const fromFirst = await first.fetch(new Request('http://example.com/probe'))
    const fromSecond = await second.fetch(new Request('http://example.com/probe'))

    expect(await fromFirst.json()).toEqual({ first: true })
    expect(await fromSecond.json()).toEqual({ first: false })
  })

  it('is absent on a bare Hono app', async () => {
    const hono = new Hono()
    hono.get('/probe', (c) => {
      expect(tryGetRequestContainer(c)).toBeUndefined()
      expect(() => getRequestContainer(c)).toThrow('No Application container on this request')
      return c.text('ok')
    })

    const response = await hono.request('/probe')

    expect(response.status).toBe(200)
  })
})
