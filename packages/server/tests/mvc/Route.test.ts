import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Controller, Route } from '../../src'

class InlineController extends Controller {
  index() {
    return 'ok'
  }
}

function createContext(): any {
  return {
    req: {
      path: '/test',
      url: '/test',
    },
  }
}

describe('Route registry', () => {
  beforeEach(() => {
    Route.clear()
  })

  it('combines nested group prefixes when defining routes', () => {
    Route.group('/api', () => {
      Route.group('v1', () => {
        Route.get('/users', () => 'users')
      })

      Route.get('status', () => 'status')
    })

    expect(Route.definitions()).toEqual([
      { method: 'GET', path: '/api/v1/users', name: undefined },
      { method: 'GET', path: '/api/status', name: undefined },
    ])

    Route.clear()
    expect(Route.definitions()).toEqual([])
  })

  it('mounts controller actions and wraps their results into responses', async () => {
    Route.get('/controller', [InlineController, 'index'])

    const registrations: Array<{ method: string; path: string; handler: (ctx: any) => Promise<Response> }> = []
    const app = new Hono()

    app.on = ((method: string, path: string, ...handlers: Array<(ctx: any) => Promise<Response>>) => {
      const handler = handlers[handlers.length - 1]
      registrations.push({ method, path, handler })
      return app
    }) as typeof app.on

    Route.mount(app)

    expect(registrations).toHaveLength(1)
    const { method, path, handler } = registrations[0]
    expect(method).toBe('GET')
    expect(path).toBe('/controller')

    const response = await handler(createContext())
    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toBe('ok')
  })

  it('wraps inline handlers and normalizes return values', async () => {
    Route.get('/object', () => ({ ok: true }))
    Route.get('/empty', () => null)

    const handlers: Record<string, (ctx: any) => Promise<Response>> = {}
    const app = new Hono()

    app.on = ((method: string, path: string, ...rest: Array<(ctx: any) => Promise<Response>>) => {
      handlers[path] = rest[rest.length - 1]
      return app
    }) as typeof app.on

    Route.mount(app)

    const jsonHandler = handlers['/object']
    const emptyHandler = handlers['/empty']

    if (!jsonHandler || !emptyHandler) {
      throw new Error('Handlers were not registered')
    }

    const jsonResponse = await jsonHandler(createContext())
    expect(jsonResponse.headers.get('content-type')).toContain('application/json')
    expect(await jsonResponse.json()).toEqual({ ok: true })

    const emptyResponse = await emptyHandler(createContext())
    expect(emptyResponse.status).toBe(204)
    expect(await emptyResponse.text()).toBe('')
  })

  it('throws when the referenced controller method does not exist', async () => {
    Route.get('/missing', [InlineController, 'show' as never])

    let captured: ((ctx: any) => Promise<Response>) | undefined
    const app = new Hono()

    app.on = ((method: string, path: string, ...rest: Array<(ctx: any) => Promise<Response>>) => {
      if (path === '/missing') {
        captured = rest[rest.length - 1]
      }
      return app
    }) as typeof app.on

    Route.mount(app)

    if (!captured) {
      throw new Error('Missing route handler was not captured')
    }

    await expect(captured(createContext())).rejects.toThrow('Controller method show is not defined on InlineController.')
  })
})
