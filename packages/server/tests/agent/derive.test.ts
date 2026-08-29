import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { deriveAgentTools, type DerivedAgentTool } from '../../src/agent/derive'
import { Router } from '../../src/mvc/Router'
import { Controller } from '../../src/mvc/Controller'
import { authorizeMiddleware, authorizeAllMiddleware, authorizeResourceMiddleware } from '../../src/authorization/middleware'
import { requireAuthenticated } from '../../src/http/middleware/auth'

class PostController extends Controller {
  async index() {
    return this.json({ posts: [] })
  }

  async show() {
    return this.json({ post: {} })
  }

  async store() {
    return this.created({})
  }

  async update() {
    return this.json({})
  }

  async destroy() {
    return this.noContent()
  }
}

function derive(router: Router) {
  return deriveAgentTools(router.definitions())
}

function toolNamed(router: Router, name: string): DerivedAgentTool {
  const { tools } = derive(router)
  const tool = tools.find((candidate) => candidate.toolName === name)
  expect(tool).toBeDefined()
  return tool!
}

describe('deriveAgentTools (RFC 0016)', () => {
  describe('selection', () => {
    test('exposes only routes that declare agent metadata', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index').agent({})
      router.get('/posts/:id', [PostController, 'show']).name('posts.show')

      const { tools, warnings } = derive(router)
      expect(tools.map((tool) => tool.toolName)).toEqual(['posts.index'])
      expect(warnings).toEqual([])
    })

    test('skips an agent route with no name, and says so', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).agent({ description: 'List posts' })

      const { tools, warnings } = derive(router)
      expect(tools).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('GET /posts')
      expect(warnings[0]).toContain('no route name')
    })

    test('a toolName override does not stand in for a missing route name', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).agent({ toolName: 'listPosts' })

      const { tools, warnings } = derive(router)
      expect(tools).toEqual([])
      expect(warnings[0]).toContain('no route name')
    })

    test('keeps the first claim on a duplicated tool name and warns about the second', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index').agent({})
      router.get('/archive', [PostController, 'index']).name('archive.index').agent({ toolName: 'posts.index' })

      const { tools, warnings } = derive(router)
      expect(tools).toHaveLength(1)
      expect(tools[0]!.path).toBe('/posts')
      expect(warnings[0]).toContain('posts.index')
      expect(warnings[0]).toContain('archive.index')
    })
  })

  describe('identity and description', () => {
    test('defaults the tool name to the route name, verbatim', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index').agent({})

      const tool = toolNamed(router, 'posts.index')
      expect(tool.routeName).toBe('posts.index')
      expect(tool.method).toBe('GET')
      expect(tool.path).toBe('/posts')
    })

    test('honours a toolName override while remembering the route name', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index').agent({ toolName: 'listPosts' })

      const tool = toolNamed(router, 'listPosts')
      expect(tool.routeName).toBe('posts.index')
    })

    test('falls back to the route description, then the summary', () => {
      const router = new Router()
      router
        .get('/posts', { name: 'posts.index', description: 'Route description', agent: {} }, [PostController, 'index'])
      router
        .get('/archive', { name: 'archive.index', summary: 'Route summary', agent: {} }, [PostController, 'index'])
      router
        .get('/drafts', { name: 'drafts.index', description: 'Route description', summary: 'Route summary', agent: { description: 'Agent description' } }, [PostController, 'index'])
      router.get('/tags', [PostController, 'index']).name('tags.index').agent({})

      expect(toolNamed(router, 'posts.index').description).toBe('Route description')
      expect(toolNamed(router, 'archive.index').description).toBe('Route summary')
      expect(toolNamed(router, 'drafts.index').description).toBe('Agent description')
      expect(toolNamed(router, 'tags.index').description).toBeUndefined()
    })
  })

  describe('exposure', () => {
    test('defaults both surfaces to exposed', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index').agent({})

      expect(toolNamed(router, 'posts.index').expose).toEqual({ mcp: true, webMcp: true })
    })

    test('resolves a partially declared expose object', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index').agent({ expose: { webMcp: false } })

      expect(toolNamed(router, 'posts.index').expose).toEqual({ mcp: true, webMcp: false })
    })
  })

  describe('annotation defaults', () => {
    const cases: Array<[string, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }]> = [
      ['GET', { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
      ['QUERY', { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
      ['POST', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
      ['PUT', { readOnlyHint: false, destructiveHint: true, idempotentHint: true }],
      ['PATCH', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
      ['DELETE', { readOnlyHint: false, destructiveHint: true, idempotentHint: true }],
    ]

    for (const [method, expected] of cases) {
      test(`${method} resolves to ${JSON.stringify(expected)}`, () => {
        const router = new Router()
        router.on(method, '/posts', [PostController, 'index']).name('posts.act').agent({})

        expect(toolNamed(router, 'posts.act').annotations).toEqual(expected)
      })
    }

    test('declared hints win over the method defaults', () => {
      const router = new Router()
      router
        .post('/posts', [PostController, 'store'])
        .name('posts.store')
        .agent({ readOnlyHint: true, destructiveHint: true, idempotentHint: true })

      expect(toolNamed(router, 'posts.store').annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: true,
        idempotentHint: true,
      })
    })

    test('destructiveHint: false is kept as the declared claim it is', () => {
      const router = new Router()
      router.post('/posts', [PostController, 'store']).name('posts.store').agent({ destructiveHint: false })

      expect(toolNamed(router, 'posts.store').annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      })
    })

    test('a declared readOnlyHint moves the destructive default with it', () => {
      const router = new Router()
      router.post('/posts', [PostController, 'store']).name('posts.store').agent({ readOnlyHint: true })

      expect(toolNamed(router, 'posts.store').annotations.destructiveHint).toBe(false)
    })
  })

  describe('input schema', () => {
    test('merges params, query and body into one object root', () => {
      const router = new Router()
      router
        .post(
          '/posts/:id/comments',
          {
            name: 'comments.store',
            params: z.object({ id: z.coerce.number() }),
            query: z.object({ notify: z.boolean().optional() }),
            body: z.object({ text: z.string().min(1) }),
            agent: {},
          },
          [PostController, 'store'],
        )

      const { inputSchema } = toolNamed(router, 'comments.store')
      expect(inputSchema.type).toBe('object')
      expect(Object.keys(inputSchema.properties ?? {}).sort()).toEqual(['id', 'notify', 'text'])
      expect(inputSchema.properties?.text).toEqual({ type: 'string', minLength: 1 })
      expect(inputSchema.required?.sort()).toEqual(['id', 'text'])
    })

    test('describes the input side of a coercing schema', () => {
      const router = new Router()
      router.get('/posts/:id', { name: 'posts.show', params: z.object({ id: z.coerce.number() }), agent: {} }, [
        PostController,
        'show',
      ])

      expect(toolNamed(router, 'posts.show').inputSchema.properties?.id).toEqual({ type: 'number' })
    })

    test('supplements path params the params schema omits, as required strings', () => {
      const router = new Router()
      router.get('/posts/:postId/comments/:id', { name: 'comments.show', params: z.object({ id: z.string() }), agent: {} }, [
        PostController,
        'show',
      ])

      const { inputSchema } = toolNamed(router, 'comments.show')
      expect(inputSchema.properties?.postId).toEqual({ type: 'string' })
      expect(inputSchema.required?.sort()).toEqual(['id', 'postId'])
    })

    test('supplements every path param when no params schema is bound', () => {
      const router = new Router()
      router.get('/posts/:id', [PostController, 'show']).name('posts.show').agent({})

      const { inputSchema } = toolNamed(router, 'posts.show')
      expect(inputSchema.properties).toEqual({ id: { type: 'string' } })
      expect(inputSchema.required).toEqual(['id'])
    })

    test('emits an object root with no properties for a route with no contracts', () => {
      const router = new Router()
      router.get('/posts', [PostController, 'index']).name('posts.index').agent({})

      expect(toolNamed(router, 'posts.index').inputSchema).toEqual({ type: 'object', properties: {} })
    })

    test('nests a non-object body under a body key', () => {
      const router = new Router()
      router.post('/posts/bulk', { name: 'posts.bulk', body: z.array(z.string()), agent: {} }, [PostController, 'store'])

      const { inputSchema } = toolNamed(router, 'posts.bulk')
      expect(inputSchema.properties?.body).toEqual({ type: 'array', items: { type: 'string' } })
      expect(inputSchema.required).toEqual(['body'])
    })

    test('nests a record body rather than flattening it away', () => {
      const router = new Router()
      router.post('/posts/meta', { name: 'posts.meta', body: z.record(z.string(), z.string()), agent: {} }, [
        PostController,
        'store',
      ])

      const { inputSchema } = toolNamed(router, 'posts.meta')
      expect(inputSchema.properties?.body).toEqual({ type: 'object', additionalProperties: { type: 'string' } })
    })

    test('warns on a key collision and lets the body win, without throwing', () => {
      const router = new Router()
      router.post(
        '/posts/:id',
        {
          name: 'posts.update',
          params: z.object({ id: z.string() }),
          body: z.object({ id: z.number() }),
          agent: {},
        },
        [PostController, 'update'],
      )

      const { tools, warnings } = derive(router)
      expect(tools).toHaveLength(1)
      expect(tools[0]!.inputSchema.properties?.id).toEqual({ type: 'number' })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('posts.update:')
      expect(warnings[0]).toContain('"id"')
      expect(warnings[0]).toContain('body')
    })

    test('a collision on a supplemented path param does not leave it required twice', () => {
      const router = new Router()
      router.post(
        '/posts/:id',
        { name: 'posts.update', body: z.object({ id: z.number().optional() }), agent: {} },
        [PostController, 'update'],
      )

      const { tools, warnings } = derive(router)
      // The path supplement made `id` required; the body owns it now and says
      // it is optional, so the advertised schema must not still demand it.
      expect(tools[0]!.inputSchema.required).toBeUndefined()
      expect(warnings[0]).toContain('"id"')
    })

    test('a synthesized body key collides like any other key', () => {
      const router = new Router()
      router.post(
        '/posts/:body',
        { name: 'posts.odd', body: z.array(z.string()), agent: {} },
        [PostController, 'store'],
      )

      const { tools, warnings } = derive(router)
      expect(tools[0]!.inputSchema.properties?.body).toEqual({ type: 'array', items: { type: 'string' } })
      expect(warnings.some((warning) => warning.includes('"body"'))).toBe(true)
    })

    test('threads walker warnings through, prefixed with the tool name', () => {
      const router = new Router()
      router.get('/posts', { name: 'posts.index', query: z.string(), agent: {} }, [PostController, 'index'])

      const { warnings } = derive(router)
      expect(warnings[0]).toStartWith('posts.index: ')
      expect(warnings[0]).toContain('GET /posts query')
    })
  })

  describe('output schema', () => {
    test('derives from the route output schema', () => {
      const router = new Router()
      router.get(
        '/posts',
        { name: 'posts.index', output: z.object({ total: z.number() }), agent: {} },
        [PostController, 'index'],
      )

      expect(toolNamed(router, 'posts.index').outputSchema).toEqual({
        type: 'object',
        properties: { total: { type: 'number' } },
        required: ['total'],
      })
    })

    test('is absent without one — a resource hint is CLI-side enrichment', () => {
      const router = new Router()
      router.get('/posts', { name: 'posts.index', agent: {} }, [PostController, 'index'])

      expect(toolNamed(router, 'posts.index').outputSchema).toBeUndefined()
    })
  })

  describe('authorization', () => {
    test('derives a single ability from authorizeMiddleware', () => {
      const router = new Router()
      router
        .post('/posts', [PostController, 'store'])
        .name('posts.store')
        .middleware(authorizeMiddleware('create-post'))
        .agent({})

      expect(toolNamed(router, 'posts.store').authorization).toEqual({ ability: 'create-post' })
    })

    test('treats a one-element array like the bare ability', () => {
      const router = new Router()
      router
        .post('/posts', [PostController, 'store'])
        .name('posts.store')
        .middleware(authorizeMiddleware(['create-post']))
        .agent({})

      expect(toolNamed(router, 'posts.store').authorization).toEqual({ ability: 'create-post' })
    })

    test('omits an any-of check', () => {
      const router = new Router()
      router
        .post('/posts', [PostController, 'store'])
        .name('posts.store')
        .middleware(authorizeMiddleware(['admin', 'moderator']))
        .agent({})

      expect(toolNamed(router, 'posts.store').authorization).toBeUndefined()
    })

    test('omits an all-of check over several abilities', () => {
      const router = new Router()
      router
        .post('/posts', [PostController, 'store'])
        .name('posts.store')
        .middleware(authorizeAllMiddleware(['create-post', 'publish-post']))
        .agent({})

      expect(toolNamed(router, 'posts.store').authorization).toBeUndefined()
    })

    test('resolves a resource check through the HTTP verb map', () => {
      const router = new Router()
      router
        .delete('/posts/:id', [PostController, 'destroy'])
        .name('posts.destroy')
        .middleware(authorizeResourceMiddleware(() => ({})))
        .agent({})

      expect(toolNamed(router, 'posts.destroy').authorization).toEqual({ ability: 'delete' })
    })

    test('omits a resource check whose abilityFor overrides the verb map', () => {
      const router = new Router()
      router
        .delete('/posts/:id', [PostController, 'destroy'])
        .name('posts.destroy')
        .middleware(authorizeResourceMiddleware(() => ({}), { abilityFor: () => 'purge' }))
        .agent({})

      expect(toolNamed(router, 'posts.destroy').authorization).toBeUndefined()
    })

    test('omits a resource check on a verb the map refuses', () => {
      const router = new Router()
      router
        .on('PURGE', '/posts/:id', [PostController, 'destroy'])
        .name('posts.purge')
        .middleware(authorizeResourceMiddleware(() => ({})))
        .agent({})

      expect(toolNamed(router, 'posts.purge').authorization).toBeUndefined()
    })

    test('authentication alone derives no ability', () => {
      const router = new Router()
      router
        .post('/posts', [PostController, 'store'])
        .name('posts.store')
        .middleware(requireAuthenticated())
        .agent({})

      expect(toolNamed(router, 'posts.store').authorization).toBeUndefined()
    })

    test('omits when a definition carries no capabilities at all', () => {
      const { tools } = deriveAgentTools([
        { method: 'POST', path: '/posts', name: 'posts.store', agent: {} },
      ])

      expect(tools[0]!.authorization).toBeUndefined()
    })
  })

  describe('pass-through metadata', () => {
    test('carries approval and redact verbatim', () => {
      const router = new Router()
      router
        .post('/posts', [PostController, 'store'])
        .name('posts.store')
        .agent({ approval: 'required', redact: ['token'] })

      const tool = toolNamed(router, 'posts.store')
      expect(tool.approval).toBe('required')
      expect(tool.redact).toEqual(['token'])
    })

    test('copies redact so a caller cannot reach back into the derived tool', () => {
      const redact = ['token']
      const { tools } = deriveAgentTools([
        { method: 'POST', path: '/posts', name: 'posts.store', agent: { redact } },
      ])

      redact.push('password')
      expect(tools[0]!.redact).toEqual(['token'])
    })
  })

  describe('resource() routes', () => {
    test('derives only the actions the resource call exposed', () => {
      const router = new Router()
      router.resource('/posts', PostController, {
        names: { index: 'posts.index', store: 'posts.store' },
        only: ['index', 'store'],
        agent: { store: { description: 'Create a post' } },
      })

      const { tools } = derive(router)
      expect(tools.map((tool) => tool.toolName)).toEqual(['posts.store'])
      expect(tools[0]!.description).toBe('Create a post')
      expect(tools[0]!.annotations.readOnlyHint).toBe(false)
    })
  })
})
