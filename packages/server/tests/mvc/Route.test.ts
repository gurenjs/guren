import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Controller, Route } from '../../src'

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

  it('allows injected controllers to run without an initialized container', async () => {
    Route.get('/injected', [InjectedController, 'index'])

    let captured: ((ctx: any) => Promise<Response>) | undefined
    const app = new Hono()

    app.on = ((method: string, path: string, ...rest: Array<(ctx: any) => Promise<Response>>) => {
      if (path === '/injected') {
        captured = rest[rest.length - 1]
      }
      return app
    }) as typeof app.on

    Route.mount(app)

    if (!captured) {
      throw new Error('Injected route handler was not captured')
    }

    const response = await captured(createContext())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })
})

describe('Named routes', () => {
  beforeEach(() => {
    Route.clear()
  })

  it('assigns name to route via chained .name() method', () => {
    Route.get('/users', () => 'users').name('users.index')

    expect(Route.definitions()).toEqual([
      { method: 'GET', path: '/users', name: 'users.index' },
    ])
  })

  it('generates URL from named route', () => {
    Route.get('/users', () => 'users').name('users.index')

    const url = Route.route('users.index')
    expect(url).toBe('/users')
  })

  it('generates URL with parameter substitution', () => {
    Route.get('/users/:id', () => 'user').name('users.show')

    const url = Route.route('users.show', { id: 42 })
    expect(url).toBe('/users/42')
  })

  it('generates URL with multiple parameters', () => {
    Route.get('/users/:userId/posts/:postId', () => 'post').name('posts.show')

    const url = Route.route('posts.show', { userId: 1, postId: 99 })
    expect(url).toBe('/users/1/posts/99')
  })

  it('encodes route parameters in generated URLs', () => {
    Route.get('/files/:path', () => 'file').name('files.show')

    const url = Route.route('files.show', { path: 'a b/c' })
    expect(url).toBe('/files/a%20b%2Fc')
  })

  it('throws error for undefined route name', () => {
    expect(() => Route.route('undefined.route')).toThrow('Route [undefined.route] not defined.')
  })

  it('checks if named route exists via hasRoute', () => {
    Route.get('/users', () => 'users').name('users.index')

    expect(Route.hasRoute('users.index')).toBe(true)
    expect(Route.hasRoute('undefined.route')).toBe(false)
  })

  it('clears named routes when Route.clear() is called', () => {
    Route.get('/users', () => 'users').name('users.index')
    expect(Route.hasRoute('users.index')).toBe(true)

    Route.clear()
    expect(Route.hasRoute('users.index')).toBe(false)
  })

  it('allows chaining after .name()', () => {
    Route.get('/a', () => 'a').name('a')
    Route.get('/b', () => 'b').name('b')

    expect(Route.definitions()).toHaveLength(2)
    expect(Route.hasRoute('a')).toBe(true)
    expect(Route.hasRoute('b')).toBe(true)
  })
})

describe('Middleware groups', () => {
  beforeEach(() => {
    Route.clear()
  })

  it('reuses nested middleware groups across siblings without treating them as circular', () => {
    const auth = async (_ctx: any, next: () => Promise<void>) => {
      await next()
    }

    Route.aliasMiddleware('auth', auth)
    Route.groupMiddleware('web', ['auth'])
    Route.groupMiddleware('admin', ['auth'])

    expect(() => {
      Route.middleware('web', 'admin').get('/dashboard', () => 'ok')
    }).not.toThrow()
  })
})

describe('Resource routes', () => {
  beforeEach(() => {
    Route.clear()
  })

  it('registers all CRUD routes for a controller', () => {
    Route.resource('/users', UserController)

    const definitions = Route.definitions()

    expect(definitions).toContainEqual({ method: 'GET', path: '/users', name: 'users.index' })
    expect(definitions).toContainEqual({ method: 'GET', path: '/users/create', name: 'users.create' })
    expect(definitions).toContainEqual({ method: 'POST', path: '/users', name: 'users.store' })
    expect(definitions).toContainEqual({ method: 'GET', path: '/users/:id', name: 'users.show' })
    expect(definitions).toContainEqual({ method: 'GET', path: '/users/:id/edit', name: 'users.edit' })
    expect(definitions).toContainEqual({ method: 'PUT', path: '/users/:id', name: 'users.update' })
    expect(definitions).toContainEqual({ method: 'DELETE', path: '/users/:id', name: 'users.destroy' })
  })

  it('generates named routes for URL generation', () => {
    Route.resource('/users', UserController)

    expect(Route.route('users.index')).toBe('/users')
    expect(Route.route('users.create')).toBe('/users/create')
    expect(Route.route('users.show', { id: 5 })).toBe('/users/5')
    expect(Route.route('users.edit', { id: 5 })).toBe('/users/5/edit')
  })

  it('uses custom parameter name', () => {
    Route.resource('/posts', UserController, { param: 'post' })

    const definitions = Route.definitions()
    expect(definitions).toContainEqual({ method: 'GET', path: '/posts/:post', name: 'posts.show' })
    expect(definitions).toContainEqual({ method: 'PUT', path: '/posts/:post', name: 'posts.update' })
  })

  it('uses custom route name prefix', () => {
    Route.resource('/admin/users', UserController, { name: 'admin.users' })

    expect(Route.hasRoute('admin.users.index')).toBe(true)
    expect(Route.hasRoute('admin.users.show')).toBe(true)
    expect(Route.route('admin.users.show', { id: 1 })).toBe('/admin/users/1')
  })

  it('registers only specified actions', () => {
    Route.resource('/posts', UserController, { only: ['index', 'show'] })

    const definitions = Route.definitions()
    expect(definitions).toHaveLength(2)
    expect(definitions).toContainEqual({ method: 'GET', path: '/posts', name: 'posts.index' })
    expect(definitions).toContainEqual({ method: 'GET', path: '/posts/:id', name: 'posts.show' })
  })

  it('excludes specified actions', () => {
    Route.resource('/posts', UserController, { except: ['create', 'edit', 'destroy'] })

    const definitions = Route.definitions()
    expect(definitions).toHaveLength(4)
    expect(definitions).not.toContainEqual(expect.objectContaining({ name: 'posts.create' }))
    expect(definitions).not.toContainEqual(expect.objectContaining({ name: 'posts.edit' }))
    expect(definitions).not.toContainEqual(expect.objectContaining({ name: 'posts.destroy' }))
  })

  it('works with group prefix', () => {
    Route.group('/api', () => {
      Route.resource('/users', UserController)
    })

    expect(Route.route('users.index')).toBe('/api/users')
    expect(Route.route('users.show', { id: 1 })).toBe('/api/users/1')
  })
})
