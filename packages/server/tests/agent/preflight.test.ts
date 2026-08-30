process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { Router, AGENT_PREFLIGHT_HEADER } from '../../src/mvc/Router'
import { Controller } from '../../src/mvc/Controller'
import { createApp } from '../../src/http/Application'
import { deriveAgentTools } from '../../src/agent/derive'
import { buildToolRequest } from '../../src/agent/dispatch'

/**
 * The preflight seam (RFC 0016 §5.4): a verdict instead of an execution.
 *
 * Driven through a mounted router rather than by calling the middleware
 * directly — what the seam promises is about its *position* in the chain (the
 * handler must not run, and everything in front of it must have), which a
 * unit call cannot show.
 */
let created = 0

class PostController extends Controller {
  async store() {
    created += 1
    return this.json({ created })
  }
}

/**
 * A real application, not a bare Hono: the exception handler is what turns a
 * validation failure into a 422, and a test mounting the router alone would
 * report 500 for the case this seam exists to get right.
 */
async function mount(register: (router: Router) => void) {
  const app = createApp({ routes: register })
  await app.boot()
  return { request: (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init)) }
}

const preflight = { [AGENT_PREFLIGHT_HEADER]: '1', 'Content-Type': 'application/json' }

describe('agent preflight', () => {
  test('reports a verdict without running the handler', async () => {
    created = 0
    const app = await mount((router) => {
      router
        .post('/posts', { body: z.object({ title: z.string().min(3) }) }, [PostController, 'store'])
        .name('posts.store')
        .agent({})
    })

    const response = await app.request('/posts', {
      method: 'POST',
      headers: preflight,
      body: JSON.stringify({ title: 'hello' }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { preflight: boolean; validated: string[]; route: string }
    expect(body.preflight).toBe(true)
    expect(body.validated).toEqual(['body'])
    expect(body.route).toBe('posts.store')
    expect(created).toBe(0)
  })

  test('runs the handler when the header is absent', async () => {
    created = 0
    const app = await mount((router) => {
      router.post('/posts', [PostController, 'store']).name('posts.store').agent({})
    })

    const response = await app.request('/posts', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(created).toBe(1)
  })

  test('validates the contract the tool advertises, including the body', async () => {
    created = 0
    const app = await mount((router) => {
      router
        .post('/posts', { body: z.object({ title: z.string().min(3) }) }, [PostController, 'store'])
        .name('posts.store')
        .agent({})
    })

    // The body schema on a controller route is normally the controller's own
    // job (validateBody) — the chain stops before the controller, so preflight
    // validates it here or the verdict would silently never check it.
    const response = await app.request('/posts', {
      method: 'POST',
      headers: preflight,
      body: JSON.stringify({ title: 'no' }),
    })

    expect(response.status).toBe(422)
    expect(created).toBe(0)
  })

  test('validates params and query too, naming what it checked', async () => {
    const app = await mount((router) => {
      router
        .post(
          '/posts/:id',
          {
            params: z.object({ id: z.coerce.number() }),
            query: z.object({ notify: z.coerce.boolean().optional() }),
          },
          [PostController, 'store'],
        )
        .name('posts.update')
        .agent({})
    })

    const response = await app.request('/posts/7?notify=true', { method: 'POST', headers: preflight })
    const body = (await response.json()) as { validated: string[] }
    expect(body.validated).toEqual(['params', 'query'])
  })

  test('stops behind middleware that refuses the request', async () => {
    created = 0
    const app = await mount((router) => {
      router
        .post('/posts', [PostController, 'store'])
        .middleware(async () => new Response('nope', { status: 403 }))
        .name('posts.store')
        .agent({})
    })

    const response = await app.request('/posts', { method: 'POST', headers: preflight })

    // The refusal is the real middleware's, not a second copy of the rule in
    // the seam — the seam never runs.
    expect(response.status).toBe(403)
    expect(created).toBe(0)
  })

  test('is ignored by a route that declares no agent metadata', async () => {
    created = 0
    const app = await mount((router) => {
      router.post('/posts', [PostController, 'store']).name('posts.store')
    })

    const response = await app.request('/posts', { method: 'POST', headers: preflight })

    // An ordinary endpoint must not change behaviour on a header any client
    // can set.
    expect(response.status).toBe(200)
    expect(created).toBe(1)
  })

  test('buildToolRequest sets the header only when preflight is asked for', () => {
    const router = new Router()
    router.post('/posts', [PostController, 'store']).name('posts.store').agent({})
    const tool = deriveAgentTools(router.definitions()).tools[0]!

    const plain = buildToolRequest(tool, {})
    const asked = buildToolRequest(tool, {}, { preflight: true })

    expect(('request' in plain ? plain.request : undefined)?.headers.get(AGENT_PREFLIGHT_HEADER)).toBeNull()
    expect(('request' in asked ? asked.request : undefined)?.headers.get(AGENT_PREFLIGHT_HEADER)).toBe('1')
  })
})
