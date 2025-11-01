import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Application, Controller, Route } from '../src'

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

describe('Application routing integration', () => {
  beforeEach(() => {
    Route.clear()
  })

  afterEach(() => {
    Route.clear()
  })

  it('dispatches controller actions registered through the Route DSL', async () => {
    Route.get('/greet', [GreetingController, 'index'])

    const app = new Application()
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/greet'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ message: 'hello' })
  })

  it('supports grouped routes and inline handlers', async () => {
    Route.group('/api', () => {
      Route.get('/ping', () => 'pong')
    })

    const app = new Application()
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/api/ping'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toBe('pong')
  })

  it('renders Inertia responses through controllers for full-page visits', async () => {
    Route.get('/dashboard', [InertiaController, 'index'])

    const app = new Application()
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/dashboard'))
    const body = await response.text()

    expect(response.headers.get('content-type')).toContain('text/html')
    expect(body).toContain('data-page=')
    expect(body).toContain('"component":"Dashboard"')
    expect(body).toContain('"stats":{"users":2}')
  })

  it('returns JSON payloads for X-Inertia requests', async () => {
    Route.get('/dashboard', [InertiaController, 'index'])

    const app = new Application()
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
})
