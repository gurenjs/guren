import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Controller, Router } from '../../src'

class InlineController extends Controller {
  index() {
    return 'ok'
  }
}

class UserController extends Controller {
  index() {
    return 'user list'
  }

  create() {
    return 'create form'
  }

  store() {
    return 'created'
  }

  show() {
    return 'user detail'
  }

  edit() {
    return 'edit form'
  }

  update() {
    return 'updated'
  }

  destroy() {
    return 'deleted'
  }
}

class InjectedController extends Controller {
  static inject = ['cache'] as const

  constructor(private readonly cache?: { get: (key: string) => string }) {
    super()
  }

  index() {
    return this.cache?.get('message') ?? 'ok'
  }
}

function createContext(): any {
  return {
    req: {
      path: '/test',
      url: '/test',
      param: () => ({}),
      query: () => ({}),
      queries: () => ({}),
    },
  }
}

describe('Router', () => {
  it('combines nested group prefixes when defining routes', () => {
    const router = new Router()

    router.group('/api', (api) => {
      api.group('v1', (v1) => {
        v1.get('/users', () => 'users')
      })

      api.get('status', () => 'status')
    })

    expect(router.definitions()).toEqual([
      { method: 'GET', path: '/api/v1/users', name: undefined },
      { method: 'GET', path: '/api/status', name: undefined },
    ])
  })

  it('mounts controller actions and wraps their results into responses', async () => {
    const router = new Router()
    router.get('/controller', [InlineController, 'index'])

    const registrations: Array<{ method: string; path: string; handler: (ctx: any) => Promise<Response> }> = []
    const app = new Hono()

    app.on = ((method: string, path: string, ...handlers: Array<(ctx: any) => Promise<Response>>) => {
      const handler = handlers[handlers.length - 1]
      registrations.push({ method, path, handler })
      return app
    }) as typeof app.on

    router.mount(app)

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
    const router = new Router()
    router.get('/object', () => ({ ok: true }))
    router.get('/empty', () => null)

    const handlers: Record<string, (ctx: any) => Promise<Response>> = {}
    const app = new Hono()

    app.on = ((method: string, path: string, ...rest: Array<(ctx: any) => Promise<Response>>) => {
      handlers[path] = rest[rest.length - 1]
      return app
    }) as typeof app.on

    router.mount(app)

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
    const router = new Router()
    router.get('/missing', [InlineController, 'show' as never])

    let captured: ((ctx: any) => Promise<Response>) | undefined
    const app = new Hono()

    app.on = ((method: string, path: string, ...rest: Array<(ctx: any) => Promise<Response>>) => {
      if (path === '/missing') {
        captured = rest[rest.length - 1]
      }
      return app
    }) as typeof app.on

    router.mount(app)

    if (!captured) {
      throw new Error('Missing route handler was not captured')
    }

    await expect(captured(createContext())).rejects.toThrow('Controller method show is not defined on InlineController.')
  })

  it('allows injected controllers to run without an application container', async () => {
    const router = new Router()
    router.get('/injected', [InjectedController, 'index'])

    let captured: ((ctx: any) => Promise<Response>) | undefined
    const app = new Hono()

    app.on = ((method: string, path: string, ...rest: Array<(ctx: any) => Promise<Response>>) => {
      if (path === '/injected') {
        captured = rest[rest.length - 1]
      }
      return app
    }) as typeof app.on

    router.mount(app)

    if (!captured) {
      throw new Error('Injected route handler was not captured')
    }

    const response = await captured(createContext())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('supports named routes and URL generation', () => {
    const router = new Router()
    router.get('/users', () => 'users').name('users.index')
    router.get('/users/:id', () => 'user').name('users.show')
    router.get('/files/:path', () => 'file').name('files.show')

    expect(router.definitions()).toEqual([
      { method: 'GET', path: '/users', name: 'users.index' },
      { method: 'GET', path: '/users/:id', name: 'users.show' },
      { method: 'GET', path: '/files/:path', name: 'files.show' },
    ])
    expect(router.route('users.index')).toBe('/users')
    expect(router.route('users.show', { id: 42 })).toBe('/users/42')
    expect(router.route('files.show', { path: 'a b/c' })).toBe('/files/a%20b%2Fc')
    expect(router.hasRoute('users.index')).toBe(true)
    expect(router.hasRoute('missing')).toBe(false)
  })

  it('clears route definitions and names without leaking state between instances', () => {
    const router = new Router()
    router.get('/a', () => 'a').name('a')
    router.get('/b', () => 'b').name('b')

    expect(router.definitions()).toHaveLength(2)
    expect(router.hasRoute('a')).toBe(true)

    router.clear()

    expect(router.definitions()).toEqual([])
    expect(router.hasRoute('a')).toBe(false)
  })

  it('reuses nested middleware groups across siblings without treating them as circular', () => {
    const auth = async (_ctx: any, next: () => Promise<void>) => {
      await next()
    }

    const router = new Router()
      .aliasMiddleware('auth', auth)
      .groupMiddleware('web', ['auth'])
      .groupMiddleware('admin', ['auth'])

    expect(() => {
      router.middleware('web', 'admin').get('/dashboard', () => 'ok')
    }).not.toThrow()
  })

  it('registers RESTful resource routes and keeps named route helpers typed', () => {
    const router = new Router()
    router.resource('/users', UserController)

    const definitions = router.definitions()

    expect(definitions).toContainEqual({ method: 'GET', path: '/users', name: 'users.index' })
    expect(definitions).toContainEqual({ method: 'GET', path: '/users/create', name: 'users.create' })
    expect(definitions).toContainEqual({ method: 'POST', path: '/users', name: 'users.store' })
    expect(definitions).toContainEqual({ method: 'GET', path: '/users/:id', name: 'users.show' })
    expect(definitions).toContainEqual({ method: 'GET', path: '/users/:id/edit', name: 'users.edit' })
    expect(definitions).toContainEqual({ method: 'PUT', path: '/users/:id', name: 'users.update' })
    expect(definitions).toContainEqual({ method: 'DELETE', path: '/users/:id', name: 'users.destroy' })
    expect(router.route('users.show', { id: 5 })).toBe('/users/5')
  })

  it('supports custom resource params, names, and group prefixes', () => {
    const router = new Router()

    router.resource('/posts', UserController, { param: 'post', only: ['index', 'show'] })
    router.group('/api', (api) => {
      api.resource('/admin/users', UserController, { name: 'admin.users', except: ['destroy'] })
    })

    expect(router.definitions()).toContainEqual({ method: 'GET', path: '/posts/:post', name: 'posts.show' })
    expect(router.hasRoute('admin.users.index')).toBe(true)
    expect(router.hasRoute('admin.users.destroy')).toBe(false)
    expect(router.route('admin.users.show', { id: 1 })).toBe('/api/admin/users/1')
  })
})
