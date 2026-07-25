import { describe, expect, it } from 'vitest'
import { TestApp } from './test-app'

describe('TestApp.fromWorkers', () => {
  it('passes request, env, and ctx through to the handler', async () => {
    const env = { SOME_BINDING: 'value' }
    let receivedEnv: unknown
    let receivedCtx: unknown
    let receivedRequest: Request | undefined

    const app = TestApp.fromWorkers(
      {
        fetch(request, handlerEnv, ctx) {
          receivedRequest = request
          receivedEnv = handlerEnv
          receivedCtx = ctx
          return new Response('ok')
        },
      },
      { env },
    )

    await app.get('/anything')

    expect(receivedEnv).toBe(env)
    expect(receivedCtx).toHaveProperty('waitUntil')
    expect(typeof (receivedCtx as { waitUntil: unknown }).waitUntil).toBe('function')
    expect(receivedRequest?.url).toBe('http://localhost/anything')
  })

  it('request helpers reach the handler with the correct URL', async () => {
    const app = TestApp.fromWorkers(
      {
        fetch(request) {
          return new Response(null, { status: request.url.endsWith('/x') ? 200 : 404 })
        },
      },
      { baseUrl: 'http://example.test' },
    )

    await app.get('/x').assertOk()
  })

  it('collects promises passed to ctx.waitUntil', async () => {
    let resolveDeferred!: () => void
    const deferred = new Promise<void>((resolve) => {
      resolveDeferred = resolve
    })

    const app = TestApp.fromWorkers({
      fetch(_request, _env, ctx) {
        ctx.waitUntil(deferred)
        return new Response('ok')
      },
    })

    await app.get('/')

    expect(app.workers.waitUntilPromises).toHaveLength(1)
    resolveDeferred()
    await expect(app.workers.waitUntilPromises[0]).resolves.toBeUndefined()
  })

  it('keeps the workers context across builder-method copies', async () => {
    const app = TestApp.fromWorkers({
      fetch(_request, _env, ctx) {
        ctx.waitUntil(Promise.resolve('done'))
        return new Response('ok')
      },
    })

    const chained = app.actingAs({ id: 1 }).withHeaders({ 'X-Extra': '1' })

    await chained.get('/')

    expect(chained.workers).toBe(app.workers)
    expect(app.workers.waitUntilPromises).toHaveLength(1)
  })

  it('defaults env to an empty object when options.env is omitted', async () => {
    let receivedEnv: unknown

    const app = TestApp.fromWorkers({
      fetch(_request, env) {
        receivedEnv = env
        return new Response('ok')
      },
    })

    await app.get('/')

    expect(receivedEnv).toEqual({})
  })
})
