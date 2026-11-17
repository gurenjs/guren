import { describe, test, expect } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { Router } from '../../src/mvc/Router'
import { deriveAgentTools, type DerivedAgentTool } from '../../src/agent/derive'
import { advertisesStructuredOutput, buildToolRequest, mapToolResponse } from '../../src/agent/dispatch'
import { createAgentInvocationPipeline } from '../../src/agent/pipeline'
import { createApp } from '../../src/http/Application'
import { markDispatchedToolRequest, readDispatchedToolRoute } from '../../src/internal/dispatched-request'
import { attachAuthContext, requireAuthenticated, requireGuest } from '../../src/http/middleware/auth'
import { requireVerifiedEmail } from '../../src/auth/email-verification'
import { createMockAuthContext } from '@guren/testing'

function toolFor(register: (router: Router) => void, name: string): DerivedAgentTool {
  const router = new Router()
  register(router)
  const { tools } = deriveAgentTools(router.definitions())
  const tool = tools.find((candidate) => candidate.toolName === name)
  expect(tool).toBeDefined()
  return tool!
}

const handler = () => new Response('ok')

describe('buildToolRequest', () => {
  test('should split arguments along their contract sources', async () => {
    const tool = toolFor((router) => {
      router
        .post(
          '/posts/:id/comments',
          {
            params: z.object({ id: z.coerce.number() }),
            query: z.object({ notify: z.coerce.boolean().optional() }),
            body: z.object({ text: z.string() }),
          },
          handler,
        )
        .name('comments.store')
        .agent({})
    }, 'comments.store')

    const built = buildToolRequest(tool, { id: 7, notify: true, text: 'hello' })
    expect('request' in built).toBe(true)
    const request = ('request' in built ? built : undefined)!.request

    const url = new URL(request.url)
    expect(url.pathname).toBe('/posts/7/comments')
    expect(url.searchParams.get('notify')).toBe('true')
    expect(request.method).toBe('POST')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(request.headers.get('Accept')).toBe('application/json')
    expect(await request.json()).toEqual({ text: 'hello' })
  })

  test('should send everything as query on a GET', () => {
    const tool = toolFor((router) => {
      router
        .get('/posts', { query: z.object({ page: z.coerce.number().optional() }) }, handler)
        .name('posts.index')
        .agent({})
    }, 'posts.index')

    const built = buildToolRequest(tool, { page: 2, stray: 'x' })
    const request = ('request' in built ? built : undefined)!.request
    const url = new URL(request.url)
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('stray')).toBe('x')
    expect(request.body).toBeNull()
  })

  test('should forward an undeclared key in the body of a body-carrying method', async () => {
    const tool = toolFor((router) => {
      router
        .post('/posts', { body: z.object({ title: z.string() }) }, handler)
        .name('posts.store')
        .agent({})
    }, 'posts.store')

    const built = buildToolRequest(tool, { title: 'T', unexpected: 1 })
    const request = ('request' in built ? built : undefined)!.request
    expect(await request.json()).toEqual({ title: 'T', unexpected: 1 })
  })

  test('should send a nested body verbatim', async () => {
    const tool = toolFor((router) => {
      router.post('/bulk', { body: z.array(z.number()) }, handler).name('bulk.store').agent({})
    }, 'bulk.store')

    const built = buildToolRequest(tool, { body: [1, 2, 3] })
    const request = ('request' in built ? built : undefined)!.request
    expect(await request.json()).toEqual([1, 2, 3])
  })

  test('should report missing path parameters instead of building a URL', () => {
    const tool = toolFor((router) => {
      router.get('/posts/:id', handler).name('posts.show').agent({})
    }, 'posts.show')

    const built = buildToolRequest(tool, {})
    expect(built).toEqual({ missing: ['id'] })
  })

  test('should URL-encode substituted path values', () => {
    const tool = toolFor((router) => {
      router.get('/files/:name', handler).name('files.show').agent({})
    }, 'files.show')

    const built = buildToolRequest(tool, { name: 'a b/c' })
    const request = ('request' in built ? built : undefined)!.request
    expect(new URL(request.url).pathname).toBe('/files/a%20b%2Fc')
  })

  test('should forward the Authorization header verbatim', () => {
    const tool = toolFor((router) => {
      router.get('/posts', handler).name('posts.index').agent({})
    }, 'posts.index')

    const built = buildToolRequest(tool, {}, { authorization: 'Bearer 1|tok' })
    const request = ('request' in built ? built : undefined)!.request
    expect(request.headers.get('Authorization')).toBe('Bearer 1|tok')
  })

  test('should keep a __proto__ argument as an own body property', async () => {
    const tool = toolFor((router) => {
      router
        .post('/odd', { body: z.object({ ok: z.boolean() }) }, handler)
        .name('odd.store')
        .agent({})
    }, 'odd.store')

    const built = buildToolRequest(tool, JSON.parse('{"ok": true, "__proto__": {"x": 1}}'))
    const request = ('request' in built ? built : undefined)!.request
    const body = (await request.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(Object.hasOwn(body, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype)
  })
})

describe('mapToolResponse', () => {
  const jsonResponse = (payload: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })

  function outputTool(): DerivedAgentTool {
    return toolFor((router) => {
      router
        // An output contract's handler returns the data the schema validates,
        // not a Response.
        .get('/posts', { output: z.object({ posts: z.array(z.unknown()) }) }, () => ({ posts: [] }))
        .name('posts.index')
        .agent({})
    }, 'posts.index')
  }

  function plainTool(): DerivedAgentTool {
    return toolFor((router) => {
      router.get('/posts', handler).name('posts.index').agent({})
    }, 'posts.index')
  }

  test('should attach structuredContent when the tool advertises an output schema', async () => {
    const outcome = await mapToolResponse(outputTool(), jsonResponse({ posts: [] }))
    expect(outcome.structuredContent).toEqual({ posts: [] })
    expect(outcome.isError).toBeUndefined()
    expect(outcome.status).toBe(200)
  })

  test('should unwrap Inertia page props for a tool with no output schema', async () => {
    const page = { component: 'posts/Index', props: { posts: [1] }, url: '/posts', version: 'v' }
    const response = new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
    })

    const outcome = await mapToolResponse(plainTool(), response)
    expect(JSON.parse(outcome.content[0]!.text)).toEqual({ posts: [1] })
  })

  test('should describe a redirect without treating it as an error', async () => {
    const response = new Response(null, { status: 302, headers: { Location: '/posts/1' } })
    const outcome = await mapToolResponse(plainTool(), response)
    expect(outcome.isError).toBeUndefined()
    expect(outcome.content[0]!.text).toContain('302')
    expect(outcome.content[0]!.text).toContain('/posts/1')
  })

  test('should mark a 422 as an error carrying the validation body', async () => {
    const body = { message: 'Validation failed', errors: { title: ['required'] } }
    const outcome = await mapToolResponse(plainTool(), jsonResponse(body, { status: 422 }))
    expect(outcome.isError).toBe(true)
    expect(outcome.content[0]!.text).toContain('Validation failed')
    expect(outcome.status).toBe(422)
  })

  test('should pass through non-JSON as text', async () => {
    const response = new Response('<html>hi</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
    const outcome = await mapToolResponse(plainTool(), response)
    expect(outcome.content[0]!.text).toBe('<html>hi</html>')
  })
})

describe('buildToolRequest security and collision fixes', () => {
  test('should reject a dot-segment path value instead of substituting it', () => {
    const tool = toolFor((router) => {
      router.get('/files/:name/meta', handler).name('files.meta').agent({})
    }, 'files.meta')

    expect(buildToolRequest(tool, { name: '..' })).toEqual({ invalidPath: ['name'] })
    expect(buildToolRequest(tool, { name: '.' })).toEqual({ invalidPath: ['name'] })
    // A dot inside a longer value is fine — it is not a whole segment.
    const ok = buildToolRequest(tool, { name: 'a.b' })
    expect('request' in ok).toBe(true)
  })

  test('should stamp the request with the route the tool was derived from, by route name', () => {
    const tool = toolFor((router) => {
      router.get('/posts/:id', handler).name('posts.show').agent({ toolName: 'posts_show' })
    }, 'posts_show')

    const built = buildToolRequest(tool, { id: 7 })
    const request = ('request' in built ? built : undefined)!.request
    expect(readDispatchedToolRoute(request)).toEqual({ method: 'GET', path: '/posts/:id', name: 'posts.show' })
    expect(readDispatchedToolRoute(new Request(request))).toBeUndefined()
  })

  test('should forward the inbound origin into the synthesized URL', () => {
    const tool = toolFor((router) => {
      router.get('/posts', handler).name('posts.index').agent({})
    }, 'posts.index')

    const built = buildToolRequest(tool, {}, { origin: 'https://app.example.com' })
    const request = ('request' in built ? built : undefined)!.request
    expect(new URL(request.url).origin).toBe('https://app.example.com')
  })

  test('should keep a body-owned collision key in the body while filling the path', async () => {
    const tool = toolFor((router) => {
      router
        .post(
          '/posts/:id',
          { body: z.object({ id: z.coerce.number(), title: z.string() }) },
          handler,
        )
        .name('posts.update')
        .agent({})
    }, 'posts.update')

    // The derivation resolves `id` to the body (it merges last), so the value
    // fills the URL AND rides in the body the route validates.
    const built = buildToolRequest(tool, { id: 7, title: 'T' })
    const request = ('request' in built ? built : undefined)!.request
    expect(new URL(request.url).pathname).toBe('/posts/7')
    expect(await request.json()).toEqual({ id: 7, title: 'T' })
  })

  test('should keep a params-owned path key out of the body', async () => {
    const tool = toolFor((router) => {
      router
        .post(
          '/posts/:id',
          { params: z.object({ id: z.coerce.number() }), body: z.object({ title: z.string() }) },
          handler,
        )
        .name('posts.update')
        .agent({})
    }, 'posts.update')

    const built = buildToolRequest(tool, { id: 7, title: 'T' })
    const request = ('request' in built ? built : undefined)!.request
    expect(new URL(request.url).pathname).toBe('/posts/7')
    expect(await request.json()).toEqual({ title: 'T' })
  })
})

describe('mapToolResponse structured-output reconciliation', () => {
  function structuredTool(): DerivedAgentTool {
    return toolFor((router) => {
      router
        .post('/posts', { output: z.object({ id: z.number() }) }, () => ({ id: 1 }))
        .name('posts.store')
        .agent({})
    }, 'posts.store')
  }

  function arrayOutputTool(): DerivedAgentTool {
    return toolFor((router) => {
      router
        .get('/nums', { output: z.array(z.number()) }, () => [1, 2])
        .name('nums.index')
        .agent({})
    }, 'nums.index')
  }

  test('should not advertise a non-object output schema as structured', () => {
    expect(advertisesStructuredOutput(arrayOutputTool())).toBe(false)
    expect(advertisesStructuredOutput(structuredTool())).toBe(true)
  })

  test('should error a 204 for a tool that advertises an object output schema', async () => {
    const outcome = await mapToolResponse(structuredTool(), new Response(null, { status: 204 }))
    expect(outcome.isError).toBe(true)
    expect(outcome.content[0]!.text).toContain('output schema')
  })

  test('should error a non-object success body for a structured tool', async () => {
    const response = new Response(JSON.stringify([1, 2]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const outcome = await mapToolResponse(structuredTool(), response)
    expect(outcome.isError).toBe(true)
    expect(outcome.content[0]!.text).toContain('JSON array')
  })

  test('should pass a non-object output tool result through as text', async () => {
    const response = new Response(JSON.stringify([1, 2]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const outcome = await mapToolResponse(arrayOutputTool(), response)
    expect(outcome.isError).toBeUndefined()
    expect(outcome.structuredContent).toBeUndefined()
    expect(JSON.parse(outcome.content[0]!.text)).toEqual([1, 2])
  })
})

/**
 * A redirect from an auth middleware is a refusal a tool caller cannot follow
 * (RFC 0016 §3.4), so it must reach the agent as an error result. Driven through
 * a booted application: the refusal's shape is decided by the middleware, and
 * only the real wiring shows the dispatcher's marker reaching it.
 */
describe('auth refusals on a tool call', () => {
  async function boot(register: (router: Router) => void) {
    const app = createApp({ routes: register })
    await app.boot()
    return app
  }

  async function dispatch(register: (router: Router) => void, name: string, options: { preflight?: boolean } = {}) {
    const app = await boot(register)
    const tool = deriveAgentTools(app.router.definitions()).tools.find((candidate) => candidate.toolName === name)!
    const built = buildToolRequest(tool, {}, options)
    if (!('request' in built)) throw new Error('request not built')
    return { outcome: await mapToolResponse(tool, await app.fetch(built.request)) }
  }

  const guarded = (router: Router) => {
    router.middleware(requireAuthenticated({ redirectTo: '/login' })).group((auth) => {
      auth.get('/secret', () => Response.json({ secret: true })).name('secret.show').agent({})
    })
  }

  test('should come back as a 401 error result, not a redirect', async () => {
    const { outcome } = await dispatch(guarded, 'secret.show')

    expect(outcome.status).toBe(401)
    expect(outcome.isError).toBe(true)
    expect(JSON.parse(outcome.content[0]!.text)).toEqual({ message: 'Unauthorized' })
  })

  test('should come back as a 401 error result from a preflight', async () => {
    const { outcome } = await dispatch(guarded, 'secret.show', { preflight: true })

    expect(outcome.status).toBe(401)
    expect(outcome.isError).toBe(true)
    expect(outcome.preflightVerdict).toBeUndefined()
  })

  test('should still redirect a browser request to the same route', async () => {
    const app = await boot(guarded)

    const response = await app.fetch(new Request('http://localhost/secret'))

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/login')
  })

  test('should come back as a 403 error result from a guest-only route', async () => {
    const { outcome } = await dispatch((router) => {
      router
        .middleware(
          attachAuthContext(() => createMockAuthContext({ isAuthenticated: true })),
          requireGuest({ redirectTo: '/dashboard' }),
        )
        .group((guest) => {
          guest.get('/login-form', () => Response.json({ form: true })).name('login.show').agent({})
        })
    }, 'login.show')

    expect(outcome.status).toBe(403)
    expect(outcome.isError).toBe(true)
  })

  test('should come back as a 403 error result for an unverified address', async () => {
    const { outcome } = await dispatch((router) => {
      router.middleware(requireVerifiedEmail({ getUser: async () => ({ emailVerifiedAt: null }) })).group((verified) => {
        verified.get('/billing', () => Response.json({ plan: 'pro' })).name('billing.show').agent({})
      })
    }, 'billing.show')

    expect(outcome.status).toBe(403)
    expect(outcome.isError).toBe(true)
  })

  test('should keep a redirect the handler itself answers as a success', async () => {
    const { outcome } = await dispatch((router) => {
      router
        .post('/posts', () => new Response(null, { status: 303, headers: { Location: '/posts/1' } }))
        .name('posts.store')
        .agent({})
    }, 'posts.store')

    expect(outcome.status).toBe(303)
    expect(outcome.isError).toBeUndefined()
    expect(outcome.content[0]!.text).toBe('HTTP 303 (Location: /posts/1)')
  })
})

/**
 * A path value equal to an earlier route's literal segment (`new` on
 * `/posts/:id`, behind `/posts/new`) must not run that route: the scope and
 * approval gates judged the tool, not it. `reached` records every part of the
 * other route that ran, its own middleware included.
 */
describe('a tool call whose path resolves to another route', () => {
  async function boot(extra?: (router: Router, reached: string[]) => void) {
    const reached: string[] = []
    const createMiddleware: MiddlewareHandler = async (_c, next) => {
      reached.push('create middleware')
      await next()
    }
    const app = createApp({
      routes: (router) => {
        extra?.(router, reached)
        router
          .get('/posts/new', () => {
            reached.push('create')
            return Response.json({ page: 'create' })
          }, createMiddleware)
          .name('posts.create')
        router
          .get('/posts/:id', (c) => Response.json({ id: c.req.param('id') }))
          .name('posts.show')
          .agent({ toolName: 'posts_show' })
      },
    })
    await app.boot()
    const tool = deriveAgentTools(app.router.definitions()).tools.find((candidate) => candidate.toolName === 'posts_show')!
    return { app, tool, reached }
  }

  async function call(args: Record<string, unknown>, options: { preflight?: boolean } = {}) {
    const { app, tool, reached } = await boot()
    const built = buildToolRequest(tool, args, options)
    if (!('request' in built)) throw new Error('request not built')
    return { outcome: await mapToolResponse(tool, await app.fetch(built.request)), reached }
  }

  test('should refuse a value that lands on an earlier literal route without running any of it', async () => {
    const { outcome, reached } = await call({ id: 'new' })

    expect(outcome.status).toBe(400)
    expect(outcome.isError).toBe(true)
    expect(JSON.parse(outcome.content[0]!.text).message).toContain(
      'reached a different route than the tool\'s own (GET /posts/:id)',
    )
    expect(reached).toEqual([])
  })

  test('should refuse the same value on a preflight rather than run the other route', async () => {
    const { outcome, reached } = await call({ id: 'new' }, { preflight: true })

    expect(outcome.status).toBe(400)
    expect(outcome.preflightVerdict).toBeUndefined()
    expect(reached).toEqual([])
  })

  test('should still answer a value the tool\'s own route matches', async () => {
    const { outcome, reached } = await call({ id: '7' })

    expect(outcome.status).toBe(200)
    expect(JSON.parse(outcome.content[0]!.text)).toEqual({ id: '7' })
    expect(reached).toEqual([])
  })

  test('should leave a request a client sent to the literal route alone', async () => {
    const { app, reached } = await boot()

    const response = await app.fetch(new Request('http://localhost/posts/new', { headers: { Accept: 'application/json' } }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ page: 'create' })
    expect(reached).toEqual(['create middleware', 'create'])
  })

  test('should refuse a same-path route registered ahead of the tool\'s under another name', async () => {
    const { app, tool, reached } = await boot((router, seen) => {
      router.get('/posts/:id', () => {
        seen.push('legacy')
        return Response.json({ legacy: true })
      }).name('posts.legacy')
    })

    const built = buildToolRequest(tool, { id: '7' })
    if (!('request' in built)) throw new Error('request not built')
    const outcome = await mapToolResponse(tool, await app.fetch(built.request))

    expect(outcome.status).toBe(400)
    expect(reached).toEqual([])
  })

  test('should refuse it on a call the invocation pipeline scope-gated and handed a principal', async () => {
    const { app, tool, reached } = await boot()
    const pipeline = createAgentInvocationPipeline({
      app,
      principal: { kind: 'user', id: 7 },
      abilities: ['tool:posts_show'],
      surface: 'mcp',
      handoff: 'seam',
    })

    const result = await pipeline.invoke({ tool, args: { id: 'new' } })

    if (result.status !== 'executed') throw new Error(`expected an executed call, got ${result.status}`)
    expect(result.outcome.status).toBe(400)
    expect(result.outcome.isError).toBe(true)
    expect(reached).toEqual([])
  })

  async function bootWithHono(register: (hono: Hono, reached: string[]) => void) {
    const reached: string[] = []
    const app = createApp({
      boot: (hono) => register(hono, reached),
      routes: (router) => {
        router
          .get('/posts/:id', (c) => Response.json({ id: c.req.param('id') }))
          .name('posts.show')
          .agent({ toolName: 'posts_show' })
      },
    })
    await app.boot()
    const tool = deriveAgentTools(app.router.definitions()).tools.find((candidate) => candidate.toolName === 'posts_show')!
    return { app, tool, reached }
  }

  // `boot` runs before the routes mount, so a route it adds to Hono matches ahead of the tool's.
  test('should refuse a value that lands on a route the boot callback added straight to Hono', async () => {
    const { app, tool, reached } = await bootWithHono((hono, seen) => {
      hono.get('/posts/new', (c) => {
        seen.push('boot route')
        return c.json({ page: 'create' })
      })
    })

    const built = buildToolRequest(tool, { id: 'new' })
    if (!('request' in built)) throw new Error('request not built')
    const outcome = await mapToolResponse(tool, await app.fetch(built.request))

    expect(outcome.status).toBe(400)
    expect(reached).toEqual([])
    const direct = await app.fetch(new Request('http://localhost/posts/new'))
    expect(direct.status).toBe(200)
    expect(reached).toEqual(['boot route'])
  })

  test('should let a tool call through middleware the boot callback added with hono.use()', async () => {
    const { app, tool, reached } = await bootWithHono((hono, seen) => {
      hono.use('/posts/*', async (_c, next) => {
        seen.push('boot middleware')
        await next()
      })
    })

    const built = buildToolRequest(tool, { id: '7' })
    if (!('request' in built)) throw new Error('request not built')
    const outcome = await mapToolResponse(tool, await app.fetch(built.request))

    expect(outcome.status).toBe(200)
    expect(JSON.parse(outcome.content[0]!.text)).toEqual({ id: '7' })
    expect(reached).toEqual(['boot middleware'])
  })
})

/**
 * The guard rides on each route's first handler: a handler of its own would add
 * a Hono route entry per route and take a single-handler route off Hono's
 * one-handler path, which is the path a bare Hono app takes here.
 */
describe('the dispatched-route guard on a bare Hono app', () => {
  const showRoute = { method: 'GET', path: '/posts/:id', name: 'posts.show' }

  function mount(register: (router: Router) => void): Hono {
    const router = new Router()
    register(router)
    const app = new Hono()
    router.mount(app)
    return app
  }

  test('should keep one Hono route entry per handler, with the first handler\'s name and arity', () => {
    const answer: MiddlewareHandler = async function answer(c) {
      return c.text('answered')
    }
    const app = mount((router) => {
      router.get('/single', handler).name('single')
      router.get('/answered', handler, answer).name('answered')
    })

    const single = app.routes.filter((route) => route.path === '/single')
    expect(single).toHaveLength(1)
    expect(single[0]!.handler.name).toBe('')
    const answered = app.routes.filter((route) => route.path === '/answered')
    expect(answered).toHaveLength(2)
    expect(answered[0]!.handler.name).toBe('answer')
    expect(answered[0]!.handler.length).toBe(1)
  })

  test('should refuse a request built for another route on a single-handler route', async () => {
    const reached: string[] = []
    const app = mount((router) => {
      router.get('/posts/new', () => {
        reached.push('create')
        return new Response('create')
      }).name('posts.create')
    })

    const refused = await app.fetch(markDispatchedToolRequest(new Request('http://localhost/posts/new'), showRoute))
    expect(refused.status).toBe(400)
    expect(reached).toEqual([])

    const plain = await app.fetch(new Request('http://localhost/posts/new'))
    expect(plain.status).toBe(200)
    expect(reached).toEqual(['create'])
  })

  test('should run a single-handler route for a request built for it', async () => {
    const app = mount((router) => {
      router.get('/posts/:id', (c) => new Response(c.req.param('id'))).name('posts.show')
    })

    const response = await app.fetch(markDispatchedToolRequest(new Request('http://localhost/posts/7'), showRoute))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('7')
  })
})

describe('mapToolResponse facts for MCP Apps (RFC 0038)', () => {
  function plainTool(): DerivedAgentTool {
    return toolFor((router) => {
      router.get('/posts', handler).name('posts.index').agent({})
    }, 'posts.index')
  }

  test('carries a redirect location as a field', async () => {
    const response = new Response(null, { status: 303, headers: { Location: '/posts/12' } })
    const outcome = await mapToolResponse(plainTool(), response)
    expect(outcome.location).toBe('/posts/12')
  })

  test('resolves a relative location against the dispatched request', async () => {
    const response = new Response(null, { status: 303, headers: { Location: '../13' } })
    const outcome = await mapToolResponse(plainTool(), response, 'http://app.test/posts/12/edit')
    expect(outcome.location).toBe('http://app.test/posts/13')
  })

  test('keeps the location on a tool whose output schema a redirect cannot satisfy', async () => {
    const outputTool = toolFor((router) => {
      router.post('/posts', { output: z.object({ ok: z.boolean() }) }, () => ({ ok: true })).name('posts.store').agent({})
    }, 'posts.store')
    const response = new Response(null, { status: 303, headers: { Location: '/posts/12' } })
    const outcome = await mapToolResponse(outputTool, response)
    expect(outcome.isError).toBe(true)
    expect(outcome.location).toBe('/posts/12')
  })

  test('carries the errors object of a 422', async () => {
    const response = new Response(JSON.stringify({ message: 'Invalid', errors: { title: ['Required'] } }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    })
    const outcome = await mapToolResponse(plainTool(), response)
    expect(outcome.errors).toEqual({ title: ['Required'] })
  })

  test('keeps the whole Inertia page beside the unwrapped props for a ui page tool only', async () => {
    const page = { component: 'posts/Index', props: { posts: [1] }, url: '/posts', version: 'v' }
    const inertiaResponse = () => new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
    })
    const uiTool = toolFor((router) => {
      router.get('/posts', handler).name('posts.index').agent({ ui: 'posts/Index' })
    }, 'posts.index')

    const outcome = await mapToolResponse(uiTool, inertiaResponse())
    expect(outcome.inertiaPage).toEqual(page)
    expect(JSON.parse(outcome.content[0]!.text)).toEqual({ posts: [1] })
    expect((await mapToolResponse(plainTool(), inertiaResponse())).inertiaPage).toBeUndefined()
  })
})
