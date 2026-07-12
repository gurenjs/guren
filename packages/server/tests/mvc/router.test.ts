import { describe, expect, it } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { Router } from '../../src/mvc/Router'
import { Controller } from '../../src/mvc/Controller'

class StubController extends Controller {
  async index() { return new Response('index') }
  async create() { return new Response('create') }
  async store() { return new Response('store') }
  async show() { return new Response('show') }
  async edit() { return new Response('edit') }
  async update() { return new Response('update') }
  async destroy() { return new Response('destroy') }
}

describe('Router resource', () => {
  it('registers standard CRUD routes', () => {
    const router = new Router()
    router.resource('/posts', StubController)

    const defs = router.definitions()
    const paths = defs.map((d) => `${d.method} ${d.path}`)

    expect(paths).toContain('GET /posts')
    expect(paths).toContain('GET /posts/create')
    expect(paths).toContain('POST /posts')
    expect(paths).toContain('GET /posts/:id')
    expect(paths).toContain('GET /posts/:id/edit')
    expect(paths).toContain('PUT /posts/:id')
    expect(paths).toContain('DELETE /posts/:id')
  })

  it('/create is registered before /:id', () => {
    const router = new Router()
    router.resource('/posts', StubController)

    const defs = router.definitions()
    const getPaths = defs.filter((d) => d.method === 'GET').map((d) => d.path)
    const createIndex = getPaths.indexOf('/posts/create')
    const showIndex = getPaths.indexOf('/posts/:id')

    expect(createIndex).toBeGreaterThan(-1)
    expect(showIndex).toBeGreaterThan(-1)
    expect(createIndex).toBeLessThan(showIndex)
  })

  it('respects except option', () => {
    const router = new Router()
    router.resource('/posts', StubController, { except: ['create', 'edit'] })

    const defs = router.definitions()
    const paths = defs.map((d) => `${d.method} ${d.path}`)

    expect(paths).not.toContain('GET /posts/create')
    expect(paths).not.toContain('GET /posts/:id/edit')
    expect(paths).toContain('GET /posts')
    expect(paths).toContain('GET /posts/:id')
  })
})

describe('Router route contract metadata', () => {
  it('includes OpenAPI metadata in route definitions for inline handlers', () => {
    const router = new Router()
    const body = z.object({ title: z.string().min(1) })
    const output = z.object({ id: z.number(), title: z.string() })

    router.post('/posts', {
      name: 'posts.store',
      body,
      output,
      summary: 'Create post',
      description: 'Creates a post resource.',
      tags: ['Posts'],
      operationId: 'postsStore',
      deprecated: true,
    }, async ({ body: payload }) => ({ id: 1, title: payload.title }))

    expect(router.definitions()).toEqual([
      {
        method: 'POST',
        path: '/posts',
        name: 'posts.store',
        schemas: {
          body,
          output,
          params: undefined,
          query: undefined,
        },
        middlewareNames: [],
        hasInlineMiddleware: false,
        controller: undefined,
        summary: 'Create post',
        description: 'Creates a post resource.',
        tags: ['Posts'],
        operationId: 'postsStore',
        deprecated: true,
      },
    ])
  })

  it('treats metadata-only contracts as route contract options', () => {
    const router = new Router()

    router.get('/health', {
      summary: 'Health check',
    }, async () => ({ ok: true }))

    expect(router.definitions()).toEqual([
      {
        method: 'GET',
        path: '/health',
        name: undefined,
        schemas: {
          body: undefined,
          output: undefined,
          params: undefined,
          query: undefined,
        },
        middlewareNames: [],
        hasInlineMiddleware: false,
        controller: undefined,
        summary: 'Health check',
        description: undefined,
        tags: undefined,
        operationId: undefined,
        deprecated: undefined,
      },
    ])
  })
})

describe('Router definition introspection', () => {
  it('exposes controller binding for controller action routes', () => {
    const router = new Router()
    router.post('/posts', [StubController, 'store'])

    const [def] = router.definitions()
    expect(def!.controller).toEqual({ name: 'StubController', action: 'store' })
    expect(def!.hasInlineMiddleware).toBe(false)
  })

  it('exposes named middleware applied via middleware groups', () => {
    const router = new Router<'auth'>()
    router.aliasMiddleware('auth', async (_c, next) => { await next() })
    router.middleware('auth').group((auth) => {
      auth.delete('/posts/:id', [StubController, 'destroy'])
    })

    const [def] = router.definitions()
    expect(def!.middlewareNames).toEqual(['auth'])
  })

  it('exposes named middleware applied via the route builder', () => {
    const router = new Router<'auth'>()
    router.aliasMiddleware('auth', async (_c, next) => { await next() })
    router.delete('/posts/:id', [StubController, 'destroy']).middleware('auth')

    const [def] = router.definitions()
    expect(def!.middlewareNames).toEqual(['auth'])
  })

  it('reports inline middleware presence', () => {
    const router = new Router()
    router.post('/posts', async (_c) => null, async (_c, next) => { await next() })

    const [def] = router.definitions()
    expect(def!.hasInlineMiddleware).toBe(true)
  })
})

describe('Router middleware as terminal handler', () => {
  it('accepts a Hono MiddlewareHandler as the route handler', async () => {
    const middleware: MiddlewareHandler = async (c) => {
      return c.text('from middleware')
    }

    const router = new Router()
    router.get('/events', middleware)

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/events')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('from middleware')
  })

  it('honors a response set via c.res instead of synthesizing a 204', async () => {
    const middleware: MiddlewareHandler = async (c, next) => {
      await next()
      c.res = new Response('finalized', { status: 201 })
    }

    const router = new Router()
    router.get('/finalized', middleware)

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/finalized')
    expect(response.status).toBe(201)
    expect(await response.text()).toBe('finalized')
  })

  it('still converts undefined returns from plain handlers into 204', async () => {
    const router = new Router()
    router.get('/empty', () => undefined)

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/empty')
    expect(response.status).toBe(204)
  })
})
