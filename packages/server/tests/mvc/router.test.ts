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
        capabilities: {},
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
        capabilities: {},
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

describe('prepared headers on raw Response returns', () => {
  it('merges c.header() values from middleware into controller responses', async () => {
    const router = new Router()
    router.get('/posts', [StubController, 'index'])

    const app = new Hono()
    app.use(async (c, next) => {
      c.header('X-Locale', 'ja')
      c.header('Set-Cookie', 'locale=ja; Path=/', { append: true })
      await next()
    })
    router.mount(app)

    const response = await app.request('/posts')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('index')
    expect(response.headers.get('X-Locale')).toBe('ja')
    expect(response.headers.getSetCookie()).toContain('locale=ja; Path=/')
  })

  it('merges c.header() values into raw Response returns from inline handlers', async () => {
    const router = new Router()
    router.get('/raw', () => new Response('raw body', { headers: { 'X-From-Handler': 'yes' } }))

    const app = new Hono()
    app.use(async (c, next) => {
      c.header('X-Locale', 'en')
      await next()
    })
    router.mount(app)

    const response = await app.request('/raw')

    expect(response.headers.get('X-Locale')).toBe('en')
    expect(response.headers.get('X-From-Handler')).toBe('yes')
    expect(await response.text()).toBe('raw body')
  })

  it('lets the handler response win on header conflicts', async () => {
    const router = new Router()
    router.get('/conflict', () => new Response('ok', { headers: { 'X-Locale': 'handler' } }))

    const app = new Hono()
    app.use(async (c, next) => {
      c.header('X-Locale', 'middleware')
      await next()
    })
    router.mount(app)

    const response = await app.request('/conflict')
    expect(response.headers.get('X-Locale')).toBe('handler')
  })
})

describe('route contract array query params (#12)', () => {
  it('preserves repeated query keys as arrays for inline contract handlers', async () => {
    const router = new Router()
    router.get('/search', {
      query: z.object({
        tag: z.array(z.string()),
        page: z.coerce.number().default(1),
      }),
    }, async ({ query }) => ({ tags: query.tag, page: query.page }))

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/search?tag=a&tag=b&page=2')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tags: ['a', 'b'], page: 2 })
  })

  it('keeps single occurrences as plain strings', async () => {
    const router = new Router()
    router.get('/filter', {
      query: z.object({ status: z.string() }),
    }, async ({ query }) => ({ status: query.status }))

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/filter?status=open')
    expect(await response.json()).toEqual({ status: 'open' })
  })

  it('accepts arrays through controller-action contract validation middleware', async () => {
    class SearchController extends Controller {
      async index() {
        return new Response('ok')
      }
    }

    const router = new Router()
    router.get('/posts', {
      query: z.object({ tag: z.array(z.string()).min(2) }),
    }, [SearchController, 'index'])

    const app = new Hono()
    app.onError((err, c) => c.json({ message: err.message }, 422))
    router.mount(app)

    const ok = await app.request('/posts?tag=a&tag=b')
    expect(ok.status).toBe(200)

    const bad = await app.request('/posts?tag=a')
    expect(bad.status).toBe(422)
  })
})

describe('route contract output validation for Response-returning handlers', () => {
  /** Emits `{"id":1}` with a Content-Length and ETag that describe exactly those bytes. */
  const staleHeaderController = () => class StaleHeaderController extends Controller {
    async index() {
      const body = JSON.stringify({ id: 1 })
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          ETag: 'W/"original"',
        },
      })
    }
  }

  it('applies schema defaults to the body of a controller action response', async () => {
    class EchoController extends Controller {
      async index() {
        return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
      }
    }

    const router = new Router()
    router.get('/echo', {
      output: z.object({ body: z.string().default('') }),
    }, [EchoController, 'index'])

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/echo')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ body: '' })
  })

  it('preserves status and custom headers when rebuilding a controller action response', async () => {
    class CreatedController extends Controller {
      async store() {
        return new Response(JSON.stringify({ id: 1 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' },
        })
      }
    }

    const router = new Router()
    router.post('/created', {
      output: z.object({ id: z.number() }),
    }, [CreatedController, 'store'])

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/created', { method: 'POST' })

    expect(response.status).toBe(201)
    expect(response.headers.get('X-Custom')).toBe('value')
    expect(response.headers.get('Content-Type')).toBe('application/json')
  })

  // Headers describing the replaced body must not survive the rebuild. Hono's `c.res`
  // setter re-copies headers off the response it replaces, so dropping them before
  // the assignment is not enough.
  it('drops Content-Length and ETag that no longer describe the rebuilt body', async () => {
    const router = new Router()
    router.get('/stale', {
      output: z.object({ id: z.number(), padding: z.string().default('xxxxxxxxxxxxxxxxxxxx') }),
    }, [staleHeaderController(), 'index'])

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/stale')
    const text = await response.text()

    expect(text).toBe(JSON.stringify({ id: 1, padding: 'xxxxxxxxxxxxxxxxxxxx' }))
    expect(response.headers.get('Content-Length')).toBeNull()
    expect(response.headers.get('ETag')).toBeNull()
  })

  it('passes the response through untouched when parsing changes nothing', async () => {
    const router = new Router()
    router.get('/stale', {
      output: z.object({ id: z.number() }),
    }, [staleHeaderController(), 'index'])

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/stale')

    // No rebuild, so the handler's own Content-Length and ETag still describe the body.
    expect(await response.text()).toBe(JSON.stringify({ id: 1 }))
    expect(response.headers.get('Content-Length')).toBe('8')
    expect(response.headers.get('ETag')).toBe('W/"original"')
  })

  it('skips validation for non-JSON controller action responses', async () => {
    class PlainController extends Controller {
      async index() {
        return new Response('plain text')
      }
    }

    const router = new Router()
    router.get('/plain', {
      output: z.object({ body: z.string() }),
    }, [PlainController, 'index'])

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/plain')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('plain text')
  })

  it('rejects a controller action response that fails output validation', async () => {
    class InvalidController extends Controller {
      async index() {
        return new Response(JSON.stringify({ id: 'not-a-number' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    const router = new Router()
    router.get('/invalid', {
      output: z.object({ id: z.number() }),
    }, [InvalidController, 'index'])

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/invalid')

    expect(response.status).toBe(500)
    const json = await response.json() as { message: string }
    expect(json.message).toBe('Response validation failed')
  })

  // The typed handler signature forbids returning a Response when `output` is set,
  // so this branch is only reachable from untyped (JS) callers.
  it('applies schema defaults when an untyped inline handler returns a Response', async () => {
    const router = new Router()
    router.get('/inline', {
      output: z.object({ body: z.string().default('') }),
    }, (async () => new Response(JSON.stringify({}))) as never)

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/inline')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ body: '' })
  })
})

describe('Router capability aggregation', () => {
  const noop: MiddlewareHandler = async (_ctx, next) => { await next() }

  function stamped(mode: 'required' | 'guest-only'): MiddlewareHandler {
    const handler: MiddlewareHandler = async (_ctx, next) => { await next() }
    Object.defineProperty(handler, Symbol.for('guren.capabilities'), {
      value: { authentication: { mode } },
      enumerable: false,
    })
    return handler
  }

  it('always emits capabilities, empty when nothing is recognized', () => {
    const router = new Router()
    router.get('/plain', () => 'ok')
    router.post('/inline', () => 'ok', noop)

    const defs = router.definitions()
    expect(defs[0]!.capabilities).toEqual({})
    expect(defs[1]!.capabilities).toEqual({})
  })

  it('reads stamps from inline middleware', () => {
    const router = new Router()
    router.post('/posts', () => 'ok', stamped('required'))

    expect(router.definitions()[0]!.capabilities).toEqual({
      authentication: { mode: 'required' },
    })
  })

  it('reads stamps through aliases and groups', () => {
    const router = new Router<'member' | 'web'>()
    router.aliasMiddleware('member', stamped('required'))
    router.groupMiddleware('web', ['member'])
    router.post('/direct', () => 'ok').middleware('member')
    router.post('/grouped', () => 'ok').middleware('web')

    const defs = router.definitions()
    expect(defs[0]!.capabilities?.authentication?.mode).toBe('required')
    expect(defs[1]!.capabilities?.authentication?.mode).toBe('required')
  })

  it('skips unregistered middleware names instead of throwing', () => {
    // Declared but never aliased: the name typechecks while staying
    // unregistered at runtime, which is the case under test.
    const router = new Router<'auth'>()
    router.post('/posts', () => 'ok').middleware('auth')

    expect(router.definitions()[0]!.capabilities).toEqual({})
  })

  it('lets required win over guest-only', () => {
    const router = new Router()
    router.post('/odd', () => 'ok', stamped('guest-only'), stamped('required'))

    expect(router.definitions()[0]!.capabilities?.authentication?.mode).toBe('required')
  })

  it('requireAuthenticated and requireGuest carry their stamps', async () => {
    const { requireAuthenticated, requireGuest } = await import('../../src/http/middleware/auth')
    const { capabilitiesOf } = await import('../../src/http/middleware/capabilities')

    expect(capabilitiesOf(requireAuthenticated())).toEqual({ authentication: { mode: 'required' } })
    expect(capabilitiesOf(requireGuest())).toEqual({ authentication: { mode: 'guest-only' } })
  })
})
