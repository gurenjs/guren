process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  createSessionMiddleware,
  getSessionFromContext,
  MemorySessionStore,
} from '../../src/http/middleware/session'

describe('Session flash data', () => {
  function createApp(store: MemorySessionStore) {
    const app = new Hono()
    app.use('*', createSessionMiddleware({ store, cookieSecure: false }))
    return app
  }

  it('flash data is readable on the next request via getFlash', async () => {
    const store = new MemorySessionStore()
    const app = createApp(store)

    app.post('/flash', (ctx) => {
      const session = getSessionFromContext(ctx)!
      session.flash('message', 'Hello!')
      return ctx.json({ ok: true })
    })

    app.get('/read', (ctx) => {
      const session = getSessionFromContext(ctx)!
      const message = session.getFlash<string>('message')
      return ctx.json({ message })
    })

    const res1 = await app.request('/flash', { method: 'POST' })
    expect(res1.status).toBe(200)
    const cookie = res1.headers.get('set-cookie')!

    const res2 = await app.request('/read', {
      headers: { Cookie: cookie.split(';')[0] },
    })
    const body2 = await res2.json() as { message: string | undefined }
    expect(body2.message).toBe('Hello!')

    const res3 = await app.request('/read', {
      headers: { Cookie: cookie.split(';')[0] },
    })
    const body3 = await res3.json() as { message: string | undefined }
    expect(body3.message).toBeUndefined()
  })

  it('getFlash returns undefined when no flash data exists', async () => {
    const store = new MemorySessionStore()
    const app = createApp(store)

    app.get('/read', (ctx) => {
      const session = getSessionFromContext(ctx)!
      const message = session.getFlash<string>('nonexistent')
      return ctx.json({ message })
    })

    const res = await app.request('/read')
    const body = await res.json() as { message: string | undefined }
    expect(body.message).toBeUndefined()
  })

  it('reflash keeps all flash data for another request', async () => {
    const store = new MemorySessionStore()
    const app = createApp(store)

    app.post('/flash', (ctx) => {
      const session = getSessionFromContext(ctx)!
      session.flash('notice', 'Saved!')
      return ctx.json({ ok: true })
    })

    app.get('/reflash', (ctx) => {
      const session = getSessionFromContext(ctx)!
      session.reflash()
      const notice = session.getFlash<string>('notice')
      return ctx.json({ notice })
    })

    app.get('/read', (ctx) => {
      const session = getSessionFromContext(ctx)!
      const notice = session.getFlash<string>('notice')
      return ctx.json({ notice })
    })

    const res1 = await app.request('/flash', { method: 'POST' })
    const cookie = res1.headers.get('set-cookie')!.split(';')[0]

    const res2 = await app.request('/reflash', {
      headers: { Cookie: cookie },
    })
    const body2 = await res2.json() as { notice: string | undefined }
    expect(body2.notice).toBe('Saved!')

    const res3 = await app.request('/read', {
      headers: { Cookie: cookie },
    })
    const body3 = await res3.json() as { notice: string | undefined }
    expect(body3.notice).toBe('Saved!')

    const res4 = await app.request('/read', {
      headers: { Cookie: cookie },
    })
    const body4 = await res4.json() as { notice: string | undefined }
    expect(body4.notice).toBeUndefined()
  })

  it('keep() preserves only specified keys', async () => {
    const store = new MemorySessionStore()
    const app = createApp(store)

    app.post('/flash', (ctx) => {
      const session = getSessionFromContext(ctx)!
      session.flash('keep-me', 'yes')
      session.flash('drop-me', 'no')
      return ctx.json({ ok: true })
    })

    app.get('/keep', (ctx) => {
      const session = getSessionFromContext(ctx)!
      session.keep('keep-me')
      return ctx.json({
        kept: session.getFlash<string>('keep-me'),
        dropped: session.getFlash<string>('drop-me'),
      })
    })

    app.get('/read', (ctx) => {
      const session = getSessionFromContext(ctx)!
      return ctx.json({
        kept: session.getFlash<string>('keep-me'),
        dropped: session.getFlash<string>('drop-me'),
      })
    })

    const res1 = await app.request('/flash', { method: 'POST' })
    const cookie = res1.headers.get('set-cookie')!.split(';')[0]

    const res2 = await app.request('/keep', { headers: { Cookie: cookie } })
    const body2 = await res2.json() as { kept: string; dropped: string }
    expect(body2.kept).toBe('yes')
    expect(body2.dropped).toBe('no')

    const res3 = await app.request('/read', { headers: { Cookie: cookie } })
    const body3 = await res3.json() as { kept: string | undefined; dropped: string | undefined }
    expect(body3.kept).toBe('yes')
    expect(body3.dropped).toBeUndefined()
  })

  it('flash data does not interfere with regular session data', async () => {
    const store = new MemorySessionStore()
    const app = createApp(store)

    app.post('/set', (ctx) => {
      const session = getSessionFromContext(ctx)!
      session.set('permanent', 'value')
      session.flash('temporary', 'flash-value')
      return ctx.json({ ok: true })
    })

    app.get('/read', (ctx) => {
      const session = getSessionFromContext(ctx)!
      return ctx.json({
        permanent: session.get<string>('permanent'),
        temporary: session.getFlash<string>('temporary'),
      })
    })

    const res1 = await app.request('/set', { method: 'POST' })
    const cookie = res1.headers.get('set-cookie')!.split(';')[0]

    const res2 = await app.request('/read', { headers: { Cookie: cookie } })
    const body2 = await res2.json() as { permanent: string; temporary: string }
    expect(body2.permanent).toBe('value')
    expect(body2.temporary).toBe('flash-value')

    const res3 = await app.request('/read', { headers: { Cookie: cookie } })
    const body3 = await res3.json() as { permanent: string; temporary: string | undefined }
    expect(body3.permanent).toBe('value')
    expect(body3.temporary).toBeUndefined()
  })
})
