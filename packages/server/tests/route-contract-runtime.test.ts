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

  // 422, not 400: the contract middleware builds a 400 response and then
  // discards it to throw ValidationException instead, so the status argument
  // never reaches the wire on this path. The functional-handler path below
  // returns its response directly and really is 400 — the same mismatch has
  // two statuses depending on the handler kind.
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

  test('the same key fails a functional handler with 400', async () => {
    const { status, body } = await get(
      (router) => router.get(
        '/posts/:id',
        { params: z.object({ postId: z.coerce.number() }) },
        ({ params }) => Response.json({ params }),
      ),
      '/posts/7',
    )

    expect(status).toBe(400)
    expect(body).toContain('postId')
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
