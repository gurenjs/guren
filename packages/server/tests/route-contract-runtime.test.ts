import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { Application, Controller, type Router } from '../src/index'

/**
 * The runtime failure modes `guren check`'s route contract check describes in
 * its findings. Pinned here because the check's messages tell users what will
 * happen — a message that drifts from the behavior is worse than no message,
 * and nothing else ties the two together.
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

  // 422 on both handler kinds, which is what the finding message promises.
  // These two used to disagree: the contract middleware built a 400 response
  // and discarded it to throw ValidationException (422) instead, while the
  // functional-handler path returned its 400 to the client. The status is what
  // clients branch on — an Inertia form reads 422 to populate `form.errors`
  // and ignores a 400 — so the pair is pinned together here.
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
