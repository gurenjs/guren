import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { Router, type AgentRouteMetadata } from '../../src/mvc/Router'
import { Controller } from '../../src/mvc/Controller'

class PostController extends Controller {
  async index() {
    return this.json({ posts: [] })
  }

  async store() {
    return this.created({})
  }

  async destroy() {
    return this.noContent()
  }
}

function definitionByName(router: Router, name: string) {
  const definition = router.definitions().find((d) => d.name === name)
  expect(definition).toBeDefined()
  return definition!
}

describe('AgentRouteMetadata (RFC 0016)', () => {
  describe('fluent .agent()', () => {
    test('should store metadata and carry it through definitions()', () => {
      const router = new Router()
      router
        .post('/posts', { body: z.object({ title: z.string() }) }, [PostController, 'store'])
        .name('posts.store')
        .agent({ description: 'Create a blog post' })

      const definition = definitionByName(router, 'posts.store')
      expect(definition.agent).toEqual({ description: 'Create a blog post' })
    })

    test('should chain in either order with name()', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).agent({ description: 'List posts' }).name('posts.index')

      const definition = definitionByName(router, 'posts.index')
      expect(definition.agent).toEqual({ description: 'List posts' })
    })

    test('routes without metadata report no agent field', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index')

      expect(definitionByName(router, 'posts.index').agent).toBeUndefined()
    })
  })

  describe('route-contract options key', () => {
    test('should accept agent metadata alongside a contract', () => {
      const router = new Router()
      router.post('/posts', {
        name: 'posts.store',
        body: z.object({ title: z.string() }),
        agent: { description: 'Create a blog post', destructiveHint: false },
      }, [PostController, 'store'])

      const definition = definitionByName(router, 'posts.store')
      expect(definition.agent).toEqual({ description: 'Create a blog post', destructiveHint: false })
    })

    test('an options object whose ONLY key is agent must not be mistaken for a handler', () => {
      // Regression guard for the isRouteContractOptions key-sniff list: without
      // 'agent' in it, this registration treats the options object as the
      // handler and the tuple as middleware.
      const router = new Router()
      router.get('/posts', { agent: { description: 'List posts' } }, [PostController, 'index']).name('posts.index')

      const definition = definitionByName(router, 'posts.index')
      expect(definition.agent).toEqual({ description: 'List posts' })
      expect(definition.controller).toEqual({ name: 'PostController', action: 'index' })
    })
  })

  describe('snapshot semantics', () => {
    test('mutating the caller metadata object after registration changes nothing', () => {
      const router = new Router()
      const metadata: AgentRouteMetadata = {
        description: 'List posts',
        expose: { webMcp: false },
        redact: ['secret'],
      }
      router.get('/posts', [PostController, 'index']).name('posts.index').agent(metadata)

      metadata.description = 'CHANGED'
      metadata.expose!.webMcp = true
      metadata.redact!.push('another')

      expect(definitionByName(router, 'posts.index').agent).toEqual({
        description: 'List posts',
        expose: { webMcp: false },
        redact: ['secret'],
      })
    })

    test('mutating a returned definition does not leak back into the registry', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index').agent({ description: 'List posts' })

      const first = definitionByName(router, 'posts.index')
      first.agent!.description = 'CHANGED'

      expect(definitionByName(router, 'posts.index').agent).toEqual({ description: 'List posts' })
    })
  })

  describe('resource() per-action metadata', () => {
    test('listed actions are exposed, unlisted actions are not', () => {
      const router = new Router()
      router.resource('posts', PostController, {
        agent: {
          index: { description: 'List posts' },
          store: { description: 'Create a post' },
          // destroy is not listed: deny by default.
        },
      })

      expect(definitionByName(router, 'posts.index').agent).toEqual({ description: 'List posts' })
      expect(definitionByName(router, 'posts.store').agent).toEqual({ description: 'Create a post' })
      expect(definitionByName(router, 'posts.destroy').agent).toBeUndefined()
    })

    test('metadata for an action excluded via except throws', () => {
      const router = new Router()
      expect(() =>
        router.resource('posts', PostController, {
          except: ['destroy'],
          agent: { destroy: { description: 'Delete a post' } },
        }),
      ).toThrow('agent metadata declared for "destroy"')
    })

    test('metadata for an action the controller does not implement throws', () => {
      const router = new Router()
      // PostController has no update()
      expect(() =>
        router.resource('posts', PostController, {
          agent: { update: { description: 'Update a post' } },
        }),
      ).toThrow('agent metadata declared for "update"')
    })
  })

  describe('scoped registration', () => {
    test('agent metadata works on routes registered inside a middleware group', () => {
      const router = new Router().aliasMiddleware('auth', async (_ctx, next) => {
        await next()
      })

      router.middleware('auth').group((auth) => {
        auth.post('/posts', [PostController, 'store']).name('posts.store').agent({ description: 'Create a post' })
      })

      const definition = definitionByName(router, 'posts.store')
      expect(definition.agent).toEqual({ description: 'Create a post' })
      expect(definition.middlewareNames).toEqual(['auth'])
    })
  })
})
