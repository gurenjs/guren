import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { Application, Controller, NotFoundHttpException, type Router } from '../src/index'

/**
 * The runtime failure modes `guren check`'s route contract check promises in its
 * findings. Nothing else ties the messages to the behavior they describe.
 */

class Post {
  static readonly recordType = {} as { id: number }
  static findOrFail(id: unknown) {
    return Promise.resolve({ id: Number(id) })
  }
}

class BindController extends Controller {
  show() {
    return this.json({ post: this.model(Post) })
  }
}

class ParamsController extends Controller {
  show() {
    return this.json({ params: this.request.param() })
  }
}

async function get(routes: (router: Router) => void, path: string) {
  const app = new Application({ routes })
  await app.boot()
  const response = await app.fetch(new Request(`http://localhost${path}`))
  return { status: response.status, body: await response.text() }
}

describe('route contract failure modes', () => {
  test('a bind key the path does not declare is skipped, and this.model() then throws', async () => {
    const { status, body } = await get(
      (router) => router.get('/posts/:id', { bind: { slug: Post } }, [BindController, 'show']),
      '/posts/7',
    )

    expect(status).toBe(500)
    expect(body).toContain('No model binding found for Post')
  })

  test('the same route with a bind key the path declares resolves the model', async () => {
    const { status, body } = await get(
      (router) => router.get('/posts/:id', { bind: { id: Post } }, [BindController, 'show']),
      '/posts/7',
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ post: { id: 7 } })
  })

  // 422 on both handler kinds, which is what the finding message promises. Clients
  // branch on the status — an Inertia form reads 422 to populate `form.errors` and
  // ignores a 400 — so the pair is pinned together here.
  test('a required params key the path does not declare fails a controller action with 422', async () => {
    const { status, body } = await get(
      (router) => router.get(
        '/posts/:id',
        { params: z.object({ postId: z.coerce.number() }) },
        [ParamsController, 'show'],
      ),
      '/posts/7',
    )

    expect(status).toBe(422)
    expect(body).toContain('postId')
  })

  test('the same key fails a functional handler with 422', async () => {
    const { status, body } = await get(
      (router) => router.get(
        '/posts/:id',
        { params: z.object({ postId: z.coerce.number() }) },
        ({ params }) => Response.json({ params }),
      ),
      '/posts/7',
    )

    expect(status).toBe(422)
    expect(body).toContain('postId')
  })

  // The sibling segments were already 422 on both kinds. Pinned alongside
  // params so a later change cannot re-split one of them unnoticed.
  test('a query schema failure is 422 on both handler kinds', async () => {
    const contract = { query: z.object({ page: z.coerce.number() }) }

    const action = await get(
      (router) => router.get('/posts', contract, [ParamsController, 'show']),
      '/posts?page=nope',
    )
    const functional = await get(
      (router) => router.get('/posts', contract, ({ query }) => Response.json({ query })),
      '/posts?page=nope',
    )

    expect(action.status).toBe(422)
    expect(functional.status).toBe(422)
  })

  test('params that satisfy the schema still reach a functional handler', async () => {
    const { status, body } = await get(
      (router) => router.get(
        '/posts/:postId',
        { params: z.object({ postId: z.coerce.number() }) },
        ({ params }) => Response.json({ params }),
      ),
      '/posts/7',
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ params: { postId: 7 } })
  })

  test('a defaulted params key the path does not declare fails nothing at all', async () => {
    const { status, body } = await get(
      (router) => router.get(
        '/posts/:id',
        { params: z.object({ page: z.coerce.number().default(1) }) },
        [ParamsController, 'show'],
      ),
      '/posts/7',
    )

    expect(status).toBe(200)
    // The request is served, and the key the schema declared is simply absent
    // from what the controller reads — no error names the mismatch anywhere.
    expect(JSON.parse(body)).toEqual({ params: { id: '7' } })
  })
})

/**
 * An `output` schema states what the *action returns*. A failure response is written
 * by the exception handler, so it is outside that schema and must not be validated.
 */
describe('output schema scope', () => {
  const Body = z.object({ title: z.string().min(3) })
  const Output = z.object({ id: z.number(), title: z.string() })

  class OutputController extends Controller {
    async store() {
      const data = await this.validateBody(Body)
      return this.json({ id: 1, title: data.title })
    }
  }

  async function post(body: unknown) {
    const app = new Application({
      routes: (router) => {
        router.post('/posts', { output: Output }, [OutputController, 'store']).name('posts.store')
      },
    })
    await app.boot()
    const response = await app.fetch(
      new Request('http://localhost/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: await response.text() }
  }

  test('a validateBody rejection keeps its 422 instead of becoming a 500', async () => {
    const { status, body } = await post({ title: 'no' })

    expect(status).toBe(422)
    expect(body).not.toContain('Response validation failed')
  })

  test('a successful response is still validated against the schema', async () => {
    const { status, body } = await post({ title: 'hello' })

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ id: 1, title: 'hello' })
  })

  // Stands in for a `Model.findOrFail()` miss. Hono's `compose` catches at the inner
  // dispatch frame, calls `onError` and assigns the rendered response to `context.res`,
  // so the error body arrives at `await next()` as a return rather than a throw.
  test('a 404 from the exception handler keeps its status', async () => {
    class MissingController extends Controller {
      async show(): Promise<never> {
        throw new NotFoundHttpException('Post not found')
      }
    }

    const app = new Application({
      routes: (router: Router) => {
        router.get('/posts/:id', { output: Output }, [MissingController, 'show']).name('posts.show')
      },
    })
    await app.boot()
    const response = await app.fetch(
      new Request('http://localhost/posts/1', { headers: { Accept: 'application/json' } }),
    )

    expect(response.status).toBe(404)
    // Debug mode adds `exception` and `stack` beside it; the message is the
    // part that is the app's own answer.
    expect((await response.json() as { message: string }).message).toBe('Post not found')
  })
})
