import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import {
  Application,
  Controller,
  FormRequest,
  validateRequest,
  validateRequestWith,
  getValidatedData,
  type Router,
} from '../src/index'
import { required, string } from '../src/http/validation/rules'

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

  async requireTitle() {
    const data = await this.validateBody(RequiredTitle)
    return this.json({ received: data })
  }

  async allowEmpty() {
    const data = await this.validateBody(AllOptional)
    return this.json({ received: data })
  }

  async viaFormRequest() {
    const data = await new TitleFormRequest().handle(this.ctx)
    return this.json({ received: data })
  }

  async upload() {
    const avatar = await this.file('avatar')
    const gallery = await this.files('gallery')
    return this.json({ avatar: avatar?.name ?? null, gallery: gallery.map((item) => item.name) })
  }
}

class TitleFormRequest extends FormRequest<{ title: string }> {
  rules() {
    return { title: [required(), string()] }
  }
}

const RequiredTitle = z.object({ title: z.string() })
const AllOptional = z.object({ title: z.string().optional() })

/** A body no form parser can decode: the MIME type promises a multipart boundary there is none of. */
const UNDECODABLE_FORM = { body: 'broken', contentType: 'multipart/form-data' }

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

/**
 * A body the form parser cannot decode used to get three different answers
 * depending on which validation path read it: the route contract and the
 * `validateRequest()` middleware let the parser's TypeError escape as a 500
 * carrying a stack, while `Controller.validateBody()` caught it and validated
 * `{}`. A malformed body is a client error, so all three now answer 422 —
 * the same status every other body-validation failure gets.
 *
 * The fallback lives in `parseRequestBody()`, which is the one place all three
 * reach it through. Each path keeps its own 422 body shape; only the status is
 * common ground.
 */
describe('a request body the form parser cannot decode', () => {
  test('a route contract answers 422, not a 500 reporting a TypeError', async () => {
    const { status, body } = await post(
      (router) => router.post('/posts', { body: RequiredTitle }, () => new Response('unreachable')),
      '/posts',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(422)
    // The parser's message and stack must not reach the client.
    expect(body).not.toContain('TypeError')
    expect(JSON.parse(body)).toHaveProperty('errors.title')
  })

  test('validateRequest() middleware answers 422', async () => {
    const { status, body } = await post(
      (router) =>
        router.post('/posts', (c: any) => c.json({ reached: true }), validateRequest(RequiredTitle)),
      '/posts',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(422)
    expect(body).not.toContain('TypeError')
    expect(JSON.parse(body)).toHaveProperty('errors.title')
  })

  // Named beside validateRequest() because it is the same body read behind a
  // schema factory — the factory must not be what decides the status.
  test('validateRequestWith() middleware answers 422', async () => {
    const { status, body } = await post(
      (router) =>
        router.post(
          '/posts',
          (c: any) => c.json({ reached: true }),
          validateRequestWith(() => RequiredTitle),
        ),
      '/posts',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(422)
    expect(body).not.toContain('TypeError')
    expect(JSON.parse(body)).toHaveProperty('errors.title')
  })

  test('Controller.validateBody() answers 422 rather than passing the request through', async () => {
    const { status, body } = await post(
      (router) => router.post('/posts', [BulkController, 'requireTitle']),
      '/posts',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(422)
    expect(body).not.toContain('TypeError')
  })

  // The fallback is `{}`, not `undefined` — which is what these pin. A
  // fallback of `undefined` would 422 the three tests above just as well
  // while breaking every all-optional schema, so without these the suite
  // would go green on the wrong fix.
  test('an all-optional contract still passes, receiving the empty-object fallback', async () => {
    const { status, body } = await post(
      (router) =>
        router.post('/posts', { body: AllOptional }, ({ body }) =>
          new Response(JSON.stringify({ received: body }), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      '/posts',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ received: {} })
  })

  test('an all-optional schema still passes through the middleware', async () => {
    const { status, body } = await post(
      (router) =>
        router.post('/posts', (c: any) => c.json({ received: getValidatedData(c) }), validateRequest(AllOptional)),
      '/posts',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ received: {} })
  })

  test('an all-optional schema still passes through Controller.validateBody()', async () => {
    const { status, body } = await post(
      (router) => router.post('/posts', [BulkController, 'allowEmpty']),
      '/posts',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ received: {} })
  })

  // The fallback lives in the shared parser, so the paths that read the body
  // field by field inherit it too — they are what `parseRequestPayload()`
  // feeds. `FormRequest` stands in for that group here.
  test('FormRequest rules see the empty-object fallback rather than a throw', async () => {
    const { status, body } = await post(
      (router) => router.post('/posts', [BulkController, 'viaFormRequest']),
      '/posts',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(422)
    expect(body).not.toContain('TypeError')
  })

  // A form body that *does* decode is untouched by the fallback — the point is
  // to catch the parser's failure, not to swallow real payloads.
  test('a decodable form body still reaches the schema', async () => {
    const { status, body } = await post(
      (router) =>
        router.post('/posts', { body: RequiredTitle }, ({ body }) =>
          new Response(JSON.stringify({ received: body }), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      '/posts',
      'title=Guren',
      'application/x-www-form-urlencoded',
    )

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ received: { title: 'Guren' } })
  })

  // The upload helpers read the multipart body themselves rather than through
  // the shared fallback, so they were the one path still answering 500 after
  // it landed. An undecodable body carries no file, which is a state both
  // helpers already have an answer for.
  test('Controller.file() / files() report no upload rather than crashing the request', async () => {
    const { status, body } = await post(
      (router) => router.post('/uploads', [BulkController, 'upload']),
      '/uploads',
      UNDECODABLE_FORM.body,
      UNDECODABLE_FORM.contentType,
    )

    expect(status).toBe(200)
    expect(body).not.toContain('TypeError')
    expect(JSON.parse(body)).toEqual({ avatar: null, gallery: [] })
  })

  // Pins `{ all: true }` on the guarded parse. Without it `parseBody` keeps one
  // value per field and `gallery` comes back as a single file — a regression
  // the malformed-body test above cannot see, because it asserts on `[]`.
  test('a decodable upload still yields every part of a repeated field', async () => {
    const form = new FormData()
    form.append('avatar', new File(['a'], 'avatar.png', { type: 'image/png' }))
    form.append('gallery', new File(['one'], 'one.png', { type: 'image/png' }))
    form.append('gallery', new File(['two'], 'two.png', { type: 'image/png' }))

    const app = new Application({
      routes: (router) => {
        router.post('/uploads', [BulkController, 'upload'])
      },
    })
    await app.boot()
    const response = await app.fetch(
      new Request('http://localhost/uploads', { method: 'POST', body: form }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ avatar: 'avatar.png', gallery: ['one.png', 'two.png'] })
  })
})
