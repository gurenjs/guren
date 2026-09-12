import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import {
  Application,
  Controller,
  Router,
  prototype,
  setInertiaSharedProps,
  type PrototypeFixture,
  type PrototypeServerContext,
} from '../src'

class RealController extends Controller {
  async index() {
    return this.json({ real: true })
  }
}

interface DemoState {
  posts: { id: number; title: string }[]
}

function fixture(overrides: Partial<PrototypeFixture> = {}): PrototypeFixture {
  const seed: DemoState = { posts: [{ id: 1, title: 'Seeded' }] }
  return {
    manifest: {},
    shared: { auth: { user: { id: 1, name: 'Demo' } }, demo: true },
    state: () => seed,
    // `routes` is declared `(ctx: never) => unknown` so a client-typed fixture
    // stays assignable; a handler written here names its context instead.
    routes: {
      'posts.index': ({ state, page, query }: PrototypeServerContext) =>
        page({ id: 'posts/Index' }, { posts: (state as DemoState).posts, q: query.q ?? null }),
      'posts.show': ({ state, params, page, notFound }: PrototypeServerContext) => {
        const post = (state as DemoState).posts.find((item) => item.id === Number(params.id))
        return post ? page({ id: 'posts/Show' }, { post }) : notFound()
      },
      'posts.store': ({ state, body, redirect, errors, flash }: PrototypeServerContext) => {
        const title = (body as { title?: string }).title
        if (!title) return errors({ title: 'Title is required.' })
        const posts = (state as DemoState).posts
        const post = { id: posts.length + 1, title }
        posts.push(post)
        flash('success', 'Created')
        return redirect('posts.show', { id: post.id })
      },
      away: ({ location }: PrototypeServerContext) => location('https://example.com/'),
    },
    ...overrides,
  }
}

function registerRoutes(router: Router): void {
  router.get('/posts', prototype).name('posts.index')
  router.get('/posts/:id', prototype).name('posts.show')
  router.post('/posts', { name: 'posts.store', body: z.object({ title: z.string() }) }, prototype)
  router.get('/away', prototype).name('away')
  router.get('/real', [RealController, 'index']).name('real')
}

async function bootApp(options: { fixture?: PrototypeFixture; prototype?: boolean; routes?: (router: Router) => void } = {}) {
  const loaded = options.fixture ?? fixture()
  const app = new Application({
    routes: options.routes ?? registerRoutes,
    prototype: options.prototype === false ? undefined : async () => ({ default: loaded }),
  })
  await app.boot()
  return app
}

const inertiaGet = (url: string) => new Request(url, { headers: { 'X-Inertia': 'true' } })

const originalNodeEnv = process.env.NODE_ENV
const originalOverride = process.env.GUREN_PROTOTYPE_ROUTES

afterEach(() => {
  setInertiaSharedProps(null)
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalOverride === undefined) delete process.env.GUREN_PROTOTYPE_ROUTES
  else process.env.GUREN_PROTOTYPE_ROUTES = originalOverride
})

describe('prototype routes (RFC 0021 Part 2)', () => {
  it('registers with and without contract options and reports prototype in definitions()', () => {
    const router = new Router()
    registerRoutes(router)

    const definitions = router.definitions()
    const index = definitions.find((route) => route.name === 'posts.index')!
    const store = definitions.find((route) => route.name === 'posts.store')!
    const real = definitions.find((route) => route.name === 'real')!

    expect(index.prototype).toBe(true)
    expect(index.controller).toBeUndefined()
    expect(store.prototype).toBe(true)
    expect(store.schemas?.body).toBeDefined()
    expect(real.prototype).toBeUndefined()
    expect(real.controller).toEqual({ name: 'RealController', action: 'index' })
  })

  it('renders a full page with the document defaults bound by createApp({ inertia })', async () => {
    const app = new Application({
      routes: registerRoutes,
      prototype: async () => ({ default: fixture() }),
      inertia: { document: { head: '<meta name="app" content="bound">' } },
    })
    await app.boot()

    const response = await app.fetch(
      new Request('http://example.com/posts', { headers: { Accept: 'text/html' } }),
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<meta name="app" content="bound">')
  })

  it('answers a page from the fixture with the fixture shared props under the real ones', async () => {
    setInertiaSharedProps(async () => ({ auth: { user: null }, fromServer: 1 }))
    const app = await bootApp()

    const response = await app.fetch(inertiaGet('http://example.com/posts?q=x'))

    expect(response.status).toBe(200)
    expect(response.headers.get('x-inertia')).toBe('true')
    const page = await response.json()
    expect(page.component).toBe('posts/Index')
    expect(page.url).toBe('/posts?q=x')
    expect(page.props.posts).toEqual([{ id: 1, title: 'Seeded' }])
    expect(page.props.q).toBe('x')
    // The session-backed resolver replaced the fixture's demo user; the fixture's own key stayed.
    expect(page.props.auth).toEqual({ user: null })
    expect(page.props.fromServer).toBe(1)
    expect(page.props.demo).toBe(true)
  })

  it('leaves controller routes untouched', async () => {
    const app = await bootApp()

    const response = await app.fetch(new Request('http://example.com/real'))

    expect(await response.json()).toEqual({ real: true })
  })

  it('redirects with 303 to the named route after a mutating fixture', async () => {
    const app = await bootApp()

    const response = await app.fetch(
      new Request('http://example.com/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'New' }),
      }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/posts/2')

    const shown = await app.fetch(inertiaGet('http://example.com/posts/2'))
    expect((await shown.json()).props.post).toEqual({ id: 2, title: 'New' })
  })

  it('enforces the route body schema before the fixture runs', async () => {
    const app = await bootApp()

    const response = await app.fetch(
      new Request('http://example.com/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 42 }),
      }),
    )

    expect(response.status).toBe(422)
  })

  it('turns errors() into the ValidationException path', async () => {
    const app = await bootApp()

    const response = await app.fetch(
      new Request('http://example.com/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ title: '' }),
      }),
    )

    expect(response.status).toBe(422)
    expect((await response.json()).errors).toEqual({ title: ['Title is required.'] })
  })

  it('answers notFound() with a 404, or the configured page', async () => {
    const plain = await bootApp()
    expect((await plain.fetch(inertiaGet('http://example.com/posts/99'))).status).toBe(404)

    const withPage = await bootApp({ fixture: fixture({ notFoundPage: { id: 'errors/NotFound' } }) })
    const response = await withPage.fetch(inertiaGet('http://example.com/posts/99'))
    expect(response.status).toBe(404)
    expect((await response.json()).component).toBe('errors/NotFound')
  })

  it('answers location() as an Inertia location visit or a plain redirect', async () => {
    const app = await bootApp()

    const inertia = await app.fetch(inertiaGet('http://example.com/away'))
    expect(inertia.status).toBe(409)
    expect(inertia.headers.get('x-inertia-location')).toBe('https://example.com/')

    const plain = await app.fetch(new Request('http://example.com/away'))
    expect(plain.status).toBe(302)
    expect(plain.headers.get('location')).toBe('https://example.com/')
  })

  it('fails the boot for an unnamed prototype route', async () => {
    await expect(bootApp({ routes: (router) => { router.get('/anon', prototype) } })).rejects.toThrow(
      'GET /anon uses the prototype handler but has no name',
    )
  })

  it('fails the boot when the fixture has no entry for a prototype route', async () => {
    await expect(bootApp({ routes: (router) => { router.get('/orphan', prototype).name('orphan') } })).rejects.toThrow(
      'no entry for GET /orphan (orphan)',
    )
  })

  it('fails the boot when createApp() has no prototype option', async () => {
    await expect(bootApp({ prototype: false })).rejects.toThrow('has no `prototype` option')
  })

  it('refuses prototype routes in production unless GUREN_PROTOTYPE_ROUTES=1', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.GUREN_PROTOTYPE_ROUTES
    await expect(bootApp()).rejects.toThrow('still answer from the prototype fixture')

    process.env.GUREN_PROTOTYPE_ROUTES = '1'
    const app = await bootApp()
    expect((await app.fetch(inertiaGet('http://example.com/posts'))).status).toBe(200)
  })

  it('never loads the fixture for an app with no prototype routes', async () => {
    let loaded = false
    const app = new Application({
      routes: (router) => { router.get('/real', [RealController, 'index']) },
      prototype: async () => {
        loaded = true
        return fixture()
      },
    })
    await app.boot()

    expect(loaded).toBe(false)
  })
})
