import { describe, expect, it } from 'bun:test'
import { Application, Controller, createApp } from '../src'
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
