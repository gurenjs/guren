import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { Router } from '../../src/mvc/Router'
import { deriveAgentTools, type DerivedAgentTool } from '../../src/agent/derive'
import { advertisesStructuredOutput, buildToolRequest, mapToolResponse } from '../../src/agent/dispatch'
import { createApp } from '../../src/http/Application'
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
  async function dispatch(register: (router: Router) => void, name: string, args: Record<string, unknown> = {}) {
    const app = createApp({ routes: register })
    await app.boot()
    const { tools } = deriveAgentTools(app.router.definitions())
    const tool = tools.find((candidate) => candidate.toolName === name)!
    const built = buildToolRequest(tool, args)
    if (!('request' in built)) throw new Error('request not built')
    const response = await app.fetch(built.request)
    return { app, outcome: await mapToolResponse(tool, response) }
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

  test('should still redirect a browser request to the same route', async () => {
    const { app } = await dispatch(guarded, 'secret.show')

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
