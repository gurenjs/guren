// Set before anything imports @guren/core: an app created with `auth: {}`
// mounts session + CSRF middleware, which need a signing key.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Controller, createApp, Router } from '@guren/core'
import { TestApp } from './test-app'

/**
 * `app.agent()` against a real application (RFC 0016 §6).
 *
 * Driven through `TestApp.create({ routes })` rather than a stub dispatcher:
 * what these assert is that a tool call re-enters the app as a real request —
 * that its validation, its middleware and its auth context all run — which a
 * fake fetch cannot show.
 */
const created: Array<{ title: string; author: unknown }> = []

class PostController extends Controller {
  async index() {
    return this.json({ posts: created.map((post) => post.title) })
  }

  async store() {
    const body = await this.validateBody(z.object({ title: z.string().min(3) }))
    const user = await this.auth.user()
    created.push({ title: body.title, author: user ? (user as unknown as { id: unknown }).id : null })
    return this.json({ id: created.length, title: body.title })
  }

  async secret() {
    await this.auth.userOrFail()
    return this.json({ ok: true })
  }

  async origin() {
    return this.json({ origin: new URL(this.request.url).origin })
  }
}

function routes(router: Router): void {
  router
    .get('/posts', { output: z.object({ posts: z.array(z.string()) }) }, [PostController, 'index'])
    .name('posts.index')
    .agent({ description: 'List posts.' })

  router
    // No `output` schema on purpose: a controller route that declares one has
    // its *error* responses validated against it too, so the 422 this test
    // wants would surface as a 500. That is the framework's behaviour today
    // and not what these tests are about.
    .post('/posts', { body: z.object({ title: z.string().min(3) }) }, [PostController, 'store'])
    .name('posts.store')
    .agent({ description: 'Create a post.' })

  router.get('/secret', [PostController, 'secret']).name('secret.show').agent({})
}

async function freshApp(options: { auth?: Record<string, unknown> } = {}): Promise<TestApp> {
  created.length = 0
  return TestApp.create({ routes, ...options })
}

describe('TestApp.agent()', () => {
  it('lists the tools an agent would see', async () => {
    const app = await freshApp()
    const names = (await app.agent().tools()).map((tool) => tool.toolName).sort()

    expect(names).toEqual(['posts.index', 'posts.store', 'secret.show'])
  })

  it('dispatches a read tool and exposes its structured result', async () => {
    const app = await freshApp()
    const result = await app.agent().call('posts.index')

    result.assertOk()
    expect(result.assertStructured<{ posts: string[] }>()).toEqual({ posts: [] })
  })

  it('chains assertions on the pending call, like PendingTestResponse', async () => {
    const app = await freshApp()

    await app.agent().call('posts.index').assertOk().assertStatus(200).assertStructured()
  })

  it('sends the input through the route\'s own validation', async () => {
    const app = await freshApp()

    // 422 comes from `validateBody`, not from a second validator in the
    // dispatch: the tool advertises the schema the route enforces.
    const result = await app.agent().call('posts.store', { title: 'no' })
    result.assertStatus(422)
    expect(result.isError).toBe(true)
    expect(created).toHaveLength(0)
  })

  it('authenticates the call as the user given in { as }', async () => {
    const app = await freshApp()

    await app.agent().call('posts.store', { title: 'From an agent' }, { as: { id: 7 } }).assertOk()

    expect(created).toEqual([{ title: 'From an agent', author: 7 }])
  })

  it('carries the user a TestApp is already acting as', async () => {
    const app = await freshApp()

    await app.actingAs({ id: 99 }).agent().call('posts.store', { title: 'Acting as' }).assertOk()

    expect(created).toEqual([{ title: 'Acting as', author: 99 }])
  })

  it('reports an unauthenticated call as denied', async () => {
    const app = await freshApp()

    const result = await app.agent().call('secret.show')
    result.assertDenied()
    expect(result.status).toBe(401)
  })

  it('answers a preflight with a verdict, leaving the handler unrun', async () => {
    const app = await freshApp()

    const result = await app.agent().call('posts.store', { title: 'Rehearsal' }, { preflight: true })

    result.assertOk()
    const verdict = result.json<{ preflight: boolean; validated: string[]; unverified: string[] }>()
    expect(verdict.preflight).toBe(true)
    expect(verdict.validated).toEqual(['body'])
    expect(verdict.unverified).toEqual(['authorization'])
    expect(created).toHaveLength(0)
  })

  it('composes with withCsrf() so a mutating call survives CSRF middleware', async () => {
    const app = await freshApp({ auth: {} })

    // Without the priming round-trip the CSRF middleware refuses the call:
    // a dispatched tool call carries neither a bearer token nor a cookie.
    await app.agent().call('posts.store', { title: 'Unprimed' }).assertStatus(403)

    const csrf = await app.withCsrf()
    await csrf.agent().call('posts.store', { title: 'Primed' }).assertOk()

    expect(created.map((post) => post.title)).toEqual(['Primed'])
  })

  it('names every tool it knows when the name is unknown', async () => {
    const app = await freshApp()

    await expect(app.agent().call('posts.destroy')).rejects.toThrow(
      /This app exposes: posts\.index, posts\.store, secret\.show\./,
    )
  })

  it('refuses assertStructured on a tool with no object output schema', async () => {
    const app = await freshApp()

    const result = await app.agent().call('secret.show', {}, { as: { id: 1 } })
    expect(() => result.assertStructured()).toThrow('advertises no object output schema')
  })

  it('says which constructor to use when the app carries no route graph', async () => {
    const bare = TestApp.fromFetch(() => new Response('ok'))

    // Named, not an empty tool list: "this construction cannot see any routes"
    // and "this app exposes no tools" are different answers.
    await expect(bare.agent().call('posts.index')).rejects.toThrow(/TestApp\.create\(\{ routes \}\) or/)
    await expect(bare.agent().tools()).rejects.toThrow('no route registry')
  })

  it('builds the request on the app\'s own baseUrl, not the dispatch default', async () => {
    const application = createApp({
      routes: (router: Router) => {
        router
          .get('/origin', { output: z.object({ origin: z.string() }) }, [PostController, 'origin'])
          .name('origin.show')
          .agent({})
      },
    })

    // `fromApp` is the constructor that carries both a route graph and a
    // custom baseUrl — the dispatch default (`http://localhost`) would
    // silently move a Workers-style app off the origin its host
    // authorization admits.
    const app = await TestApp.fromApp(application, 'http://agent.test')
    const result = await app.agent().call('origin.show')

    expect(result.assertStructured<{ origin: string }>().origin).toBe('http://agent.test')
  })
})
