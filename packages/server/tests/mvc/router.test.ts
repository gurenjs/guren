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

// `RouterMiddlewareGroupBuilder` mirrors `Router`'s per-verb overloads by hand,
// and drifting out of sync is exactly the bug these tests were added for. This
// assignment fails to compile the moment the builder stops accepting everything
// `Router` does — including overloads added long after this was written, which a
// per-call test can never anticipate. Root `tsc --noEmit` covers this directory.
const _verbParityGuard: Pick<Router<'auth'>, 'get' | 'post' | 'put' | 'patch' | 'delete' | 'query' | 'on'> =
  new Router<'auth'>().aliasMiddleware('auth', async (_c, next) => { await next() }).middleware('auth')
void _verbParityGuard

describe('Router middleware group builder with contract options', () => {
  const body = z.object({ title: z.string().min(1) })

  it('accepts a controller action alongside contract options on every verb', () => {
    // The alias name is inferred from the captured aliasMiddleware() return —
    // the form the routing docs teach — rather than declared as `new Router<'auth'>()`.
    const router = new Router().aliasMiddleware('auth', async (_c, next) => { await next() })

    const scoped = router.middleware('auth')
    scoped.get('/posts/:id/edit', { name: 'posts.edit' }, [StubController, 'edit'])
    scoped.post('/posts', { name: 'posts.store', body }, [StubController, 'store'])
    scoped.put('/posts/:id', { name: 'posts.update', body }, [StubController, 'update'])
    scoped.patch('/posts/:id', { name: 'posts.patch', body }, [StubController, 'update'])
    scoped.delete('/posts/:id', { name: 'posts.destroy' }, [StubController, 'destroy'])

    expect(router.definitions().map((d) => `${d.method} ${d.path}`)).toEqual([
      'GET /posts/:id/edit',
      'POST /posts',
      'PUT /posts/:id',
      'PATCH /posts/:id',
      'DELETE /posts/:id',
    ])

    const post = router.definitions()[1]
    expect(post!.name).toBe('posts.store')
    expect(post!.middlewareNames).toEqual(['auth'])
    expect(post!.schemas?.body).toBe(body)
    expect(post!.controller).toEqual({ name: 'StubController', action: 'store' })
  })

  it('routes the request through the aliased middleware', async () => {
    const router = new Router<'auth'>()
    const seen: string[] = []
    router.aliasMiddleware('auth', async (_c, next) => { seen.push('auth'); await next() })
    router.middleware('auth').post('/posts', { name: 'posts.store', body }, [StubController, 'store'])

    const app = new Hono()
    router.mount(app)
    const response = await app.request('/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello' }),
    })

    expect(response.status).toBe(200)
    expect(seen).toEqual(['auth'])
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

  it('keeps handlers passed to middleware() out of middlewareNames', () => {
    const router = new Router<'auth'>()
    router.aliasMiddleware('auth', async (_c, next) => { await next() })
    router.middleware('auth', async (_c, next) => { await next() }).group((scoped) => {
      scoped.post('/posts', [StubController, 'store']).middleware(async (_c, next) => { await next() })
    })

    const [def] = router.definitions()
    expect(def!.middlewareNames).toEqual(['auth'])
    expect(def!.hasInlineMiddleware).toBe(true)
  })

  it('does not report a group-scoped handler as inline middleware on its routes', () => {
    const router = new Router()
    router.middleware(async (_c, next) => { await next() }).group((scoped) => {
      scoped.post('/posts', [StubController, 'store'])
    })

    // `guren audit` warns per route on this flag, so a handler the route never
    // attached must not set it.
    const [def] = router.definitions()
    expect(def!.hasInlineMiddleware).toBe(false)
  })

  it('aggregates capabilities from a group-scoped handler', async () => {
    const { requireAuthenticated } = await import('../../src/http/middleware/auth')

    const router = new Router()
    router.middleware(requireAuthenticated()).group((scoped) => {
      scoped.post('/posts', [StubController, 'store'])
    })

    const [def] = router.definitions()
    expect(def!.capabilities?.authentication).toEqual({ mode: 'required' })
  })
})

describe('Router inline middleware via middleware()', () => {
  const tap = (calls: string[], label: string): MiddlewareHandler => async (_c, next) => {
    calls.push(label)
    await next()
  }

  it('runs a handler passed to the route builder', async () => {
    const calls: string[] = []
    const router = new Router()
    router.get('/limited', () => 'ok').middleware(tap(calls, 'inline'))

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/limited')
    expect(response.status).toBe(200)
    expect(calls).toEqual(['inline'])
  })

  it('runs a handler scoped to a group across every route in it', async () => {
    const calls: string[] = []
    const router = new Router()
    router.middleware(tap(calls, 'scoped')).group((scoped) => {
      scoped.get('/a', () => 'a')
      scoped.get('/b', () => 'b')
    })
    router.get('/outside', () => 'outside')

    const app = new Hono()
    router.mount(app)

    await app.request('/a')
    await app.request('/b')
    await app.request('/outside')
    expect(calls).toEqual(['scoped', 'scoped'])
  })

  it('nests group scopes outer-to-inner', async () => {
    const calls: string[] = []
    const router = new Router()
    router.middleware(tap(calls, 'outer')).group((outer) => {
      outer.middleware(tap(calls, 'inner')).group((inner) => {
        inner.get('/nested', () => 'ok')
      })
      outer.get('/outer-only', () => 'ok')
    })

    const app = new Hono()
    router.mount(app)

    await app.request('/nested')
    expect(calls).toEqual(['outer', 'inner'])

    calls.length = 0
    await app.request('/outer-only')
    expect(calls).toEqual(['outer'])
  })

  it('composes group-scoped handlers before route-level ones', async () => {
    const calls: string[] = []
    const router = new Router()
    router.middleware(tap(calls, 'group')).group((scoped) => {
      scoped.get('/nested', () => 'ok').middleware(tap(calls, 'route'))
    })

    const app = new Hono()
    router.mount(app)

    await app.request('/nested')
    expect(calls).toEqual(['group', 'route'])
  })

  it('runs named middleware before inline handlers in a mixed call', async () => {
    const calls: string[] = []
    const router = new Router<'auth'>()
    router.aliasMiddleware('auth', tap(calls, 'auth'))
    router.middleware('auth', tap(calls, 'inline')).group((scoped) => {
      scoped.get('/mixed', () => 'ok')
    })

    const app = new Hono()
    router.mount(app)

    await app.request('/mixed')
    expect(calls).toEqual(['auth', 'inline'])
  })

  it('does not leak inline scope between routers after clear()', async () => {
    const calls: string[] = []
    const router = new Router()
    router.middleware(tap(calls, 'scoped')).group((scoped) => {
      scoped.get('/first', () => 'first')
    })

    router.clear()
    router.get('/second', () => 'second')

    const app = new Hono()
    router.mount(app)

    await app.request('/second')
    expect(calls).toEqual([])
  })

  it('aggregates capabilities from a handler passed to middleware()', async () => {
    const { requireAuthenticated } = await import('../../src/http/middleware/auth')

    const router = new Router()
    router.post('/posts', [StubController, 'store']).middleware(requireAuthenticated())

    const [def] = router.definitions()
    expect(def!.capabilities?.authentication).toEqual({ mode: 'required' })
  })
})

describe('Router group callbacks must be synchronous', () => {
  // Scopes unwind synchronously, so an async callback registers its routes
  // after the pop — silently dropping the guard the group was opened with.
  it('rejects an async middleware group callback', () => {
    const router = new Router()
    expect(() =>
      router.middleware(async (_c, next) => { await next() }).group((async (scoped: Router) => {
        scoped.post('/admin', [StubController, 'store'])
      }) as unknown as (r: Router) => void),
    ).toThrow(/applied synchronously/)
  })

  it('rejects an async prefix group callback', () => {
    const router = new Router()
    expect(() =>
      router.group('/api', (async (scoped: Router) => {
        scoped.post('/admin', [StubController, 'store'])
      }) as unknown as (r: Router) => void),
    ).toThrow(/applied synchronously/)
  })

  it('unwinds the prefix scope when the callback throws', () => {
    const router = new Router()
    expect(() => router.group('/api', () => { throw new Error('boom') })).toThrow('boom')

    router.get('/outside', () => 'ok')
    expect(router.definitions()[0]!.path).toBe('/outside')
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

describe('Router QUERY method (RFC 10008)', () => {
  it('query() registers a QUERY route with contract metadata', () => {
    const body = z.object({ q: z.string().min(1) })
    const router = new Router()
    router.query('/posts/search', { name: 'posts.search', body }, [StubController, 'index'])

    const [def] = router.definitions()
    expect(def!.method).toBe('QUERY')
    expect(def!.path).toBe('/posts/search')
    expect(def!.name).toBe('posts.search')
    expect(def!.schemas?.body).toBe(body)
    expect(def!.controller).toEqual({ name: 'StubController', action: 'index' })
  })

  it('dispatches QUERY requests with a validated body through mount()', async () => {
    const router = new Router()
    router.query('/search', {
      body: z.object({ q: z.string(), limit: z.number().default(10) }),
    }, async ({ body }) => ({ q: body.q, limit: body.limit }))

    const app = new Hono()
    router.mount(app)

    const response = await app.request('/search', {
      method: 'QUERY',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'hello' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ q: 'hello', limit: 10 })
  })

  it('middleware group builder supports query()', async () => {
    const router = new Router<'auth'>()
    const seen: string[] = []
    router.aliasMiddleware('auth', async (_c, next) => { seen.push('auth'); await next() })
    router.middleware('auth').query('/search', { name: 'search' }, async () => ({ ok: true }))

    const [def] = router.definitions()
    expect(def!.method).toBe('QUERY')
    expect(def!.middlewareNames).toEqual(['auth'])

    const app = new Hono()
    router.mount(app)
    const response = await app.request('/search', { method: 'QUERY' })
    expect(response.status).toBe(200)
    expect(seen).toEqual(['auth'])
  })

  it('middleware group builder supports on() for arbitrary methods', () => {
    const router = new Router<'auth'>()
    router.aliasMiddleware('auth', async (_c, next) => { await next() })
    router.middleware('auth').on('QUERY', '/reports', { name: 'reports.query' }, async () => ({ ok: true }))

    const [def] = router.definitions()
    expect(def!.method).toBe('QUERY')
    expect(def!.middlewareNames).toEqual(['auth'])
  })
})

describe('Router route() with Hono path modifiers', () => {
  it.each([
    ['a regex-constrained param', '/items/:id{[0-9]+}', { id: 7 }, '/items/7'],
    ['an optional param', '/archive/:slug?', { slug: 'news' }, '/archive/news'],
    ['an optional regex-constrained param', '/tags/:code{[a-z]+}?', { code: 'abc' }, '/tags/abc'],
    ['a constraint containing a slash character class', '/docs/:path{[^/]+}/meta', { path: 'intro' }, '/docs/intro/meta'],
    ['a constraint with nested braces', '/at/:t{[0-9]{2}}', { t: 12 }, '/at/12'],
    ['a trailing * with the token', '/files/:slug*', { slug: 'intro' }, '/files/intro'],
    ['a hyphenated param label', '/inventory/:item-id', { 'item-id': 7 }, '/inventory/7'],
    ['params sharing a prefix, without clobbering', '/posts/:id/:idx', { id: 1, idx: 2 }, '/posts/1/2'],
  ] as const)('substitutes %s', (_case, path, params, expected) => {
    const router = new Router()
    router.get(path, [StubController, 'show']).name('case.show')

    expect(router.route('case.show', params as Record<string, string | number>)).toBe(expected)
  })

  it('leaves the whole token in place when the param is not supplied', () => {
    const router = new Router()
    router.get('/items/:id{[0-9]+}', [StubController, 'show']).name('items.show')

    expect(router.route('items.show', {})).toBe('/items/:id{[0-9]+}')
  })

  it('treats a mid-segment colon as a literal, as Hono does', () => {
    const router = new Router()
    router.get('/status/foo:bar', [StubController, 'show']).name('status.show')

    expect(router.route('status.show', { bar: 9 })).toBe('/status/foo:bar')
  })
})

describe('Router binding introspection with Hono path modifiers', () => {
  class FakeModel {
    static findOrFail(): never {
      throw new Error('not reached')
    }
  }

  it('does not invent a binding for a colon inside a regex constraint', () => {
    const router = new Router()
    router.bind('kind', FakeModel as never)
    router.bind('b', FakeModel as never)
    router.get('/x/:kind{(?:a|:b)}/y', [StubController, 'show']).name('x.show')

    const [def] = router.definitions()
    expect(def!.bindings).toEqual({ kind: 'FakeModel' })
  })

  it('serializes a router-level binding for a hyphenated param', () => {
    const router = new Router()
    router.bind('item-id', FakeModel as never)
    router.get('/inventory/:item-id', [StubController, 'show']).name('inventory.show')

    const [def] = router.definitions()
    expect(def!.bindings).toEqual({ 'item-id': 'FakeModel' })
  })
})
