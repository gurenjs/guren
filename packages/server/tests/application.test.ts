import { describe, expect, it } from 'bun:test'
import { Application, Controller, createApp, getGate, Policy, ErrorServiceProvider } from '../src'
import { z } from 'zod'

class GreetingController extends Controller {
  async index() {
    return this.json({ message: 'hello' })
  }
}

class InertiaController extends Controller {
  async index() {
    return this.inertia('Dashboard', { stats: { users: 2 } })
  }
}

class ContractInertiaController extends Controller {
  async index() {
    return this.inertia({ id: 'Dashboard' }, { stats: { users: 2 } })
  }
}

describe('Application routing integration', () => {
  it('dispatches controller actions registered on the application router', async () => {
    const app = new Application()
    app.router.get('/greet', [GreetingController, 'index'])
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/greet'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ message: 'hello' })
  })

  it('supports grouped routes and inline handlers', async () => {
    const app = new Application()
    app.router.group('/api', (router) => {
      router.get('/ping', () => 'pong')
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/api/ping'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toBe('pong')
  })

  it('renders Inertia responses through controllers for full-page visits', async () => {
    const app = new Application()
    app.router.get('/dashboard', [InertiaController, 'index'])
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/dashboard'))
    const body = await response.text()

    expect(response.headers.get('content-type')).toContain('text/html')
    expect(body).toContain('data-page=')
    expect(body).toContain('"component":"Dashboard"')
    expect(body).toContain('"stats":{"users":2}')
  })

  it('returns JSON payloads for X-Inertia requests', async () => {
    const app = new Application()
    app.router.get('/dashboard', [InertiaController, 'index'])
    await app.boot()

    const response = await app.fetch(
      new Request('http://example.com/dashboard', {
        headers: {
          'X-Inertia': 'true',
          Accept: 'application/json',
        },
      }),
    )

    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      component: 'Dashboard',
      props: { stats: { users: 2 } },
      url: '/dashboard',
      version: undefined,
    })
  })

  it('accepts page contract objects in controller inertia responses', async () => {
    const app = new Application()
    app.router.get('/dashboard', [ContractInertiaController, 'index'])
    await app.boot()

    const response = await app.fetch(
      new Request('http://example.com/dashboard', {
        headers: {
          'X-Inertia': 'true',
          Accept: 'application/json',
        },
      }),
    )

    expect(await response.json()).toEqual({
      component: 'Dashboard',
      props: { stats: { users: 2 } },
      url: '/dashboard',
      version: undefined,
    })
  })

  it('supports app-local route registration through createApp()', async () => {
    const app = createApp({
      routes: (router) => {
        router.get('/health', () => ({ ok: true })).name('health')
      },
    })

    await app.boot()

    const response = await app.fetch(new Request('http://example.com/health'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(app.router.route('health')).toBe('/health')
  })

  it('keeps routes isolated between application instances', async () => {
    const appOne = createApp({
      routes: (router) => {
        router.get('/one', () => 'one')
      },
    })
    const appTwo = createApp({
      routes: (router) => {
        router.get('/two', () => 'two')
      },
    })

    await appOne.boot()
    await appTwo.boot()

    const oneResponse = await appOne.fetch(new Request('http://example.com/one'))
    const missingResponse = await appTwo.fetch(new Request('http://example.com/one'))

    expect(oneResponse.status).toBe(200)
    expect(await oneResponse.text()).toBe('one')
    expect(missingResponse.status).toBe(404)
  })

  it('parses schema-first route contracts before invoking the handler', async () => {
    const app = createApp({
      routes: (router) => {
        router.get(
          '/posts/:id',
          {
            name: 'posts.show',
            params: z.object({ id: z.coerce.number().int().positive() }),
            query: z.object({ draft: z.enum(['true', 'false']).optional() }),
          },
          ({ params, query }) => ({
            id: params.id,
            draft: query.draft ?? 'false',
          }),
        )
      },
    })

    await app.boot()

    const success = await app.fetch(new Request('http://example.com/posts/42?draft=true'))
    const failure = await app.fetch(new Request('http://example.com/posts/not-a-number'))

    expect(success.status).toBe(200)
    expect(await success.json()).toEqual({ id: 42, draft: 'true' })
    expect(failure.status).toBe(400)
    const failureBody = await failure.json() as { errors?: Record<string, string> }
    expect(failureBody.errors?.id).toContain('number')
  })
})

describe('Application authorization wiring', () => {
  class Doc {
    constructor(public id: number, public ownerId: number) {}
  }

  it('makes the global gate available after boot without manual wiring', async () => {
    const app = createApp({
      routes: (router) => {
        router.get('/ping', () => 'pong')
      },
    })
    await app.boot()

    const gate = getGate()
    expect(gate).toBeDefined()
    gate.define('always', () => true)
    expect(await gate.allows('always')).toBe(true)
  })

  it('denies controller authorize() for guests via registered policy (403)', async () => {
    class DocPolicy extends Policy {
      update(user: { id: string | number } | null, doc: { ownerId?: unknown }) {
        return user !== null && user.id === doc.ownerId
      }
    }

    class DocController extends Controller {
      async update() {
        await this.authorize('update', [Doc, { id: 1, ownerId: 5 }])
        return this.json({ ok: true })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.put('/docs/:id', [DocController, 'update'])
      },
    })
    await app.boot()
    getGate().policy(Doc, DocPolicy)

    const response = await app.fetch(new Request('http://example.com/docs/1', { method: 'PUT' }))

    expect(response.status).toBe(403)
  })

  it('maps duck-typed statusCode exceptions without manual ErrorServiceProvider', async () => {
    class NotFoundish extends Error {
      readonly statusCode = 404
    }

    const app = createApp({
      routes: (router) => {
        router.get('/missing', () => {
          throw new NotFoundish('Nope')
        })
      },
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/missing'))

    expect(response.status).toBe(404)
  })

  it('lets a user-supplied ErrorServiceProvider take precedence', async () => {
    class CustomErrorProvider extends ErrorServiceProvider {
      boot(): void {
        const hono = this.container.make<import('hono').Hono>('hono')
        hono.onError(() => new Response('custom', { status: 418 }))
      }
    }

    const app = createApp({
      routes: (router) => {
        router.get('/boom', () => {
          throw new Error('boom')
        })
      },
      providers: [CustomErrorProvider],
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/boom'))

    expect(response.status).toBe(418)
    expect(await response.text()).toBe('custom')
  })

  it('controller can() reflects gate definitions', async () => {
    class StatusController extends Controller {
      async index() {
        return this.json({ allowed: await this.can('view-dashboard') })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.get('/status', [StatusController, 'index'])
      },
    })
    await app.boot()
    getGate().define('view-dashboard', () => true)

    const response = await app.fetch(new Request('http://example.com/status'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ allowed: true })
  })
})
