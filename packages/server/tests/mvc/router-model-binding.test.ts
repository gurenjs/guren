import { describe, expect, it } from 'bun:test'
import { Hono, type Context } from 'hono'
import { Router } from '../../src/mvc/Router'
import { Controller } from '../../src/mvc/Controller'

interface PostRecord {
  id: number
  slug: string
  title: string
}

const posts: PostRecord[] = [
  { id: 1, slug: 'hello-world', title: 'Hello World' },
  { id: 2, slug: 'second', title: 'Second' },
]

class NotFound extends Error {
  statusCode = 404
}

/** Mirrors the ORM's static `findOrFail(id, key = 'id')`, recording each call. */
function makeModel(name = 'Post', rows: PostRecord[] = posts) {
  const calls: Array<[unknown, string | undefined]> = []
  return {
    name,
    calls,
    async findOrFail(id: unknown, key?: string): Promise<PostRecord> {
      calls.push([id, key])
      const column = (key ?? 'id') as keyof PostRecord
      const found = rows.find((p) => String(p[column]) === String(id))
      if (!found) throw new NotFound(`${name} not found`)
      return found
    },
  }
}
type PostModel = ReturnType<typeof makeModel>

/** A controller closed over the model class the route binds, as app code would import it. */
function controllerFor(Post: PostModel) {
  return class PostController extends Controller {
    async show() {
      return this.json({ via: 'model', post: this.model(Post) })
    }

    async showPositional(_ctx: Context, post: PostRecord) {
      return this.json({ via: 'positional', post })
    }

    async showBoth(_ctx: Context, post: PostRecord) {
      return this.json({ positional: post, model: this.model(Post) })
    }
  }
}

function mount(router: Router): Hono {
  const app = new Hono()
  app.onError((err, c) => c.text(err.message, ((err as Partial<NotFound>).statusCode ?? 500) as 404 | 500))
  router.mount(app)
  return app
}

describe('Route model binding by primary key (bind: { id: Post })', () => {
  it('resolves through findOrFail without a key and exposes the record via this.model()', async () => {
    const Post = makeModel()
    const router = new Router()
    router.get('/posts/:id', { bind: { id: Post } }, [controllerFor(Post), 'show'])
    const app = mount(router)

    const response = await app.request('/posts/2')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ via: 'model', post: posts[1] })
    expect(Post.calls).toEqual([['2', undefined]])
  })

  it('surfaces the model not-found exception on a miss', async () => {
    const Post = makeModel()
    const router = new Router()
    router.get('/posts/:id', { bind: { id: Post } }, [controllerFor(Post), 'show'])
    const app = mount(router)

    const response = await app.request('/posts/999')
    expect(response.status).toBe(404)
  })
})

describe('Route model binding by another column (bind: { slug: [Post, "slug"] })', () => {
  it('resolves through findOrFail(value, column) and exposes the record via this.model()', async () => {
    const Post = makeModel()
    const router = new Router()
    router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] } }, [controllerFor(Post), 'show'])
    const app = mount(router)

    const response = await app.request('/posts/hello-world')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ via: 'model', post: posts[0] })
    expect(Post.calls).toEqual([['hello-world', 'slug']])
  })

  it('does not fall back to the primary key when the column has no match', async () => {
    const Post = makeModel()
    const router = new Router()
    router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] } }, [controllerFor(Post), 'show'])
    const app = mount(router)

    // '1' is a valid id but not a slug — a by-slug route must 404 here.
    const response = await app.request('/posts/1')
    expect(response.status).toBe(404)
    expect(Post.calls).toEqual([['1', 'slug']])
  })

  it('serializes the bound model name for introspection, same as the class form', () => {
    const Post = makeModel()
    const router = new Router()
    router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] }, name: 'posts.show' }, [controllerFor(Post), 'show'])

    expect(router.definitions()[0]?.bindings).toEqual({ slug: 'Post' })
  })
})

describe('Router-level bind(param, ...)', () => {
  it('passes a model-bound record positionally after the context AND exposes it via this.model()', async () => {
    const Post = makeModel()
    const router = new Router()
    router.bind('post', Post)
    router.get('/posts/:post', [controllerFor(Post), 'showBoth'])
    const app = mount(router)

    const response = await app.request('/posts/1')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ positional: posts[0], model: posts[0] })
    expect(Post.calls).toEqual([['1', undefined]])
  })

  it('accepts a [Model, column] tuple and looks up by that column', async () => {
    const Post = makeModel()
    const router = new Router()
    router.bind('post', [Post, 'slug'])
    router.get('/posts/:post', [controllerFor(Post), 'showBoth'])
    const app = mount(router)

    const response = await app.request('/posts/second')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ positional: posts[1], model: posts[1] })
    expect(Post.calls).toEqual([['second', 'slug']])
    expect(router.definitions()[0]?.bindings).toEqual({ post: 'Post' })
  })

  it('passes a custom resolver value as a positional argument, not on the context', async () => {
    const Post = makeModel()
    const router = new Router()
    router.bind('post', async (slug) => posts.find((p) => p.slug === slug) ?? null)
    router.get('/posts/:post', [controllerFor(Post), 'showPositional'])

    let seenOnContext: unknown = 'unset'
    const app = new Hono()
    app.use('*', async (c, next) => {
      await next()
      seenOnContext = (c.get as (key: string) => unknown)('post')
    })
    router.mount(app)

    const response = await app.request('/posts/hello-world')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ via: 'positional', post: posts[0] })
    // The resolver ran on its own — the model was never consulted — and the
    // value is not published on the Hono context (`this.ctx.get('post')`).
    expect(Post.calls).toEqual([])
    expect(seenOnContext).toBeUndefined()
    expect(router.definitions()[0]?.bindings).toBeUndefined()
  })

  it('does not expose a custom-resolver value through this.model()', async () => {
    const Post = makeModel()
    const router = new Router()
    router.bind('post', async (slug) => posts.find((p) => p.slug === slug) ?? null)
    router.get('/posts/:post', [controllerFor(Post), 'show'])
    const app = mount(router)

    const response = await app.request('/posts/hello-world')
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('No model binding found for Post')
  })

  it('lets the route-level bind win for this.model() when both levels bind the same param', async () => {
    // Rows arranged so the two lookups of '1' disagree: it is row 1's id and
    // row 2's slug. this.model() must return the slug match, while the
    // router-level binding still fills the positional slot.
    const rows: PostRecord[] = [
      { id: 1, slug: 'x', title: 'X' },
      { id: 2, slug: '1', title: 'Y' },
    ]
    const Post = makeModel('Post', rows)
    const router = new Router()
    router.bind('post', Post) // by primary key, router-wide
    router.get('/posts/:post', { bind: { post: [Post, 'slug'] } }, [controllerFor(Post), 'showBoth'])
    const app = mount(router)

    const response = await app.request('/posts/1')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ positional: rows[0], model: rows[1] })
    expect(Post.calls).toEqual([['1', 'slug'], ['1', undefined]])
  })

  it('does not overwrite a route-bound record when another param binds the same model class', async () => {
    const Post = makeModel()
    const router = new Router()
    router.bind('other', Post) // by primary key on a different param
    router.get('/posts/:id/:other', { bind: { id: [Post, 'slug'] } }, [controllerFor(Post), 'showBoth'])
    const app = mount(router)

    const response = await app.request('/posts/hello-world/2')
    expect(response.status).toBe(200)
    // `this.model(Post)` is keyed by class, so the route's own binding wins;
    // the router-level record still arrives positionally.
    expect(await response.json()).toEqual({ positional: posts[1], model: posts[0] })
  })

  it('still runs a router-level custom resolver when the route binds the same param', async () => {
    const Post = makeModel()
    let resolverCalls = 0
    const router = new Router()
    router.bind('post', async (value) => {
      resolverCalls += 1
      return { resolved: value }
    })
    router.get('/posts/:post', { bind: { post: [Post, 'slug'] } }, [controllerFor(Post), 'showBoth'])
    const app = mount(router)

    const response = await app.request('/posts/hello-world')
    expect(response.status).toBe(200)
    // The resolver's value fills the positional slot (it has no model class
    // to be reached by), while this.model(Post) holds the route's record.
    expect(await response.json()).toEqual({ positional: { resolved: 'hello-world' }, model: posts[0] })
    expect(resolverCalls).toBe(1)
  })

  it('does not resolve bindings for an inline handler, which takes Hono (ctx, next)', async () => {
    const Post = makeModel()
    const router = new Router()
    router.bind('post', Post)
    router.get('/posts/:post', (c) => c.json({ param: c.req.param('post') }))
    const app = mount(router)

    const response = await app.request('/posts/1')
    expect(await response.json()).toEqual({ param: '1' })
    expect(Post.calls).toEqual([])
  })

  it('passes several bound values in path-parameter order', async () => {
    class Pair extends Controller {
      async show(_ctx: Context, a: string, b: string) {
        return this.json({ a, b })
      }
    }
    const router = new Router()
    router.bind('a', async (v) => `A:${v}`)
    router.bind('b', async (v) => `B:${v}`)
    router.get('/pair/:a/:b', [Pair, 'show'])
    const app = mount(router)

    const response = await app.request('/pair/one/two')
    expect(await response.json()).toEqual({ a: 'A:one', b: 'B:two' })
  })
})
