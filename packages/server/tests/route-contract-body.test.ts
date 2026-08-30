import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { Application, Controller, validateRequest, getValidatedData, type Router } from '../src/index'

/**
 * A route may bind any schema to `body`, not only an object one. The parsed
 * JSON reaches the schema as-is — an array stays an array, a string stays a
 * string — so `z.array()` / `z.string()` contracts are reachable over HTTP
 * rather than always 422-ing on a payload that was narrowed to `{}` first.
 *
 * The object case is what every scaffolded route uses, so it is pinned beside
 * each non-object one.
 */

class BulkController extends Controller {
  async store() {
    const ids = await this.validateBody(z.array(z.number()))
    return this.json({ count: ids.length, total: ids.reduce((sum, id) => sum + id, 0) })
  }

  async note() {
    const text = await this.validateBody(z.string())
    return this.json({ length: text.length })
  }

  async inputsStayObjectShaped() {
    return this.json({ title: (await this.input('title')) ?? null, has: await this.has('title') })
  }
}

async function post(routes: (router: Router) => void, path: string, body: string, contentType = 'application/json') {
  const app = new Application({ routes })
  await app.boot()
  const response = await app.fetch(
    new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': contentType }, body }),
  )
  return { status: response.status, body: await response.text() }
}

describe('non-object request bodies', () => {
  test('a functional handler receives an array body', async () => {
    const { status, body } = await post(
      (router) =>
        // `body` is inferred as `number[]` here — `.reduce` is what pins that,
        // since a runtime-only fix would leave the contract typed as a record.
        router.post('/bulk', { body: z.array(z.number()) }, ({ body }) =>
          new Response(
            JSON.stringify({ received: body, total: body.reduce((sum, n) => sum + n, 0) }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
      '/bulk',
      JSON.stringify([1, 2, 3]),
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ received: [1, 2, 3], total: 6 })
  })

  test('a functional handler receives a string body', async () => {
    const { status, body } = await post(
      (router) =>
        // Likewise `string`, not `Record<string, unknown>`.
        router.post('/note', { body: z.string() }, ({ body }) =>
          new Response(JSON.stringify({ received: body.toUpperCase() }), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      '/note',
      JSON.stringify('hello'),
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ received: 'HELLO' })
  })

  test('a functional handler still receives an object body', async () => {
    const { status, body } = await post(
      (router) =>
        router.post('/posts', { body: z.object({ title: z.string() }) }, ({ body }) =>
          new Response(JSON.stringify({ received: body }), { headers: { 'content-type': 'application/json' } }),
        ),
      '/posts',
      JSON.stringify({ title: 'Guren' }),
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ received: { title: 'Guren' } })
  })

  test('validateBody() in a controller accepts an array body', async () => {
    const { status, body } = await post(
      (router) => router.post('/bulk', [BulkController, 'store']),
      '/bulk',
      JSON.stringify([1, 2, 3]),
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ count: 3, total: 6 })
  })

  test('validateBody() in a controller accepts a string body', async () => {
    const { status, body } = await post(
      (router) => router.post('/note', [BulkController, 'note']),
      '/note',
      JSON.stringify('hello'),
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ length: 5 })
  })

  test('input()/has() keep the object view of an array body', async () => {
    const { status, body } = await post(
      (router) => router.post('/inputs', [BulkController, 'inputsStayObjectShaped']),
      '/inputs',
      JSON.stringify([1, 2, 3]),
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ title: null, has: false })
  })

  test('validateRequest() middleware accepts an array body', async () => {
    const { status, body } = await post(
      (router) =>
        router.post('/tags', (c: any) =>
          c.json({ tags: getValidatedData<string[]>(c) }),
          validateRequest(z.array(z.string())),
        ),
      '/tags',
      JSON.stringify(['a', 'b']),
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ tags: ['a', 'b'] })
  })

  // The empty-body fallback is deliberate: a malformed or absent JSON body
  // still parses to `{}`, which keeps all-optional object schemas passing on
  // an empty POST. An array schema sees that `{}` and fails, as it should.
  test('an empty body against an array schema is a 422, not an empty array', async () => {
    const { status } = await post(
      (router) => router.post('/bulk', { body: z.array(z.number()) }, () => new Response('unreachable')),
      '/bulk',
      '',
    )

    expect(status).toBe(422)
  })
})
