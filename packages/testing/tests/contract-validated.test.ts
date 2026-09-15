import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { contractInput, createControllerContext, type ControllerContext } from '../src/controller'
import { TestApp } from '../src/test-app'

/**
 * A route contract's `body` on a controller action, driven through a booted
 * application: the exception handler is what turns the middleware's throw into
 * a 422, so a bare router would report the failure as a 500.
 */
async function bootApp(register: (router: import('@guren/core').Router) => void) {
  const { createApp } = await import('@guren/core')
  const app = createApp({ routes: register })
  return { app, http: (await TestApp.fromApp(app)).json() }
}

const PostPayload = z.object({
  title: z.string().min(3),
  priority: z.coerce.number().int(),
  tags: z.array(z.object({ name: z.string().min(1) })).default([]),
})

const { Controller } = await import('@guren/core')

describe('route contract body on a controller action', () => {
  it('answers 422 before the action runs when the body breaks the contract', async () => {
    let ran = false
    class PostController extends Controller {
      async store() {
        ran = true
        return this.json({ ok: true })
      }
    }
    const { http } = await bootApp((router) => {
      router.post('/posts', { name: 'posts.store', body: PostPayload }, [PostController, 'store'])
    })

    const response = await http.post('/posts', { title: 'no', priority: 'high' })

    expect(response.status).toBe(422)
    expect(ran).toBe(false)
  })

  it('keys the error bag by the full path, as validateBody() does', async () => {
    class PostController extends Controller {
      async store() {
        return this.json({ ok: true })
      }
    }
    const { http } = await bootApp((router) => {
      router.post('/posts', { name: 'posts.store', body: PostPayload }, [PostController, 'store'])
    })

    const response = await http.post('/posts', { title: 'valid', priority: 1, tags: [{ name: '' }] })
    const payload = await response.json<{ errors: Record<string, string[]> }>()

    expect(response.status).toBe(422)
    expect(Object.keys(payload.errors)).toEqual(['tags.0.name'])
  })

  it('hands the action the parsed body, params and query through validated()', async () => {
    class PostController extends Controller {
      async update() {
        const { params, query, body } = this.validated('posts.update')
        return this.json({ params, query, body })
      }
    }
    const { http } = await bootApp((router) => {
      router.put('/posts/:id', {
        name: 'posts.update',
        params: z.object({ id: z.coerce.number().int() }),
        query: z.object({ draft: z.enum(['0', '1']).transform((value) => value === '1') }),
        body: PostPayload,
      }, [PostController, 'update'])
    })

    const response = await http.put('/posts/42?draft=1', { title: 'hello', priority: '7' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      params: { id: 42 },
      query: { draft: true },
      body: { title: 'hello', priority: 7, tags: [] },
    })
  })

  it('leaves an undeclared segment undefined', async () => {
    class PostController extends Controller {
      async store() {
        const input = this.validated()
        return this.json({ params: input.params ?? null, query: input.query ?? null, hasBody: input.body !== undefined })
      }
    }
    const { http } = await bootApp((router) => {
      router.post('/posts', { body: PostPayload }, [PostController, 'store'])
    })

    const response = await http.post('/posts', { title: 'hello', priority: 1 })

    expect(await response.json()).toEqual({ params: null, query: null, hasBody: true })
  })

  it('refuses a route name other than the one being served', async () => {
    class PostController extends Controller {
      async store() {
        return this.json(this.validated('posts.update'))
      }
    }
    const { http } = await bootApp((router) => {
      router.post('/posts', { name: 'posts.store', body: PostPayload }, [PostController, 'store'])
    })

    const response = await http.post('/posts', { title: 'hello', priority: 1 })

    expect(response.status).toBe(500)
  })

  it('accepts every route name an action mounted on several routes serves', async () => {
    class PostController extends Controller {
      async update() {
        return this.json(this.validated(['posts.update', 'posts.patch']).body)
      }
    }
    const { http } = await bootApp((router) => {
      router.put('/posts/:id', { name: 'posts.update', body: PostPayload }, [PostController, 'update'])
      router.patch('/posts/:id', { name: 'posts.patch', body: PostPayload }, [PostController, 'update'])
    })

    const response = await http.patch('/posts/1', { title: 'hello', priority: 1 })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ title: 'hello', priority: 1, tags: [] })
  })

  it('keeps validateBody() and input() working on a contract-validated route', async () => {
    class PostController extends Controller {
      async store() {
        const data = await this.validateBody(PostPayload)
        return this.json({ data, title: await this.input('title') })
      }
    }
    const { http } = await bootApp((router) => {
      router.post('/posts', { name: 'posts.store', body: PostPayload }, [PostController, 'store'])
    })

    const response = await http.post('/posts', { title: 'hello', priority: '3' })

    expect(await response.json()).toEqual({ data: { title: 'hello', priority: 3, tags: [] }, title: 'hello' })
  })

  it('leaves every value of a repeated multipart field to files()', async () => {
    class PostController extends Controller {
      async store() {
        const { body } = this.validated('posts.store')
        const files = await this.files('images')
        return this.json({ body, files: files.map((file) => file.name) })
      }
    }
    const { http } = await bootApp((router) => {
      router.post('/posts', { name: 'posts.store', body: z.object({ title: z.string() }) }, [PostController, 'store'])
    })
    const form = new FormData()
    form.append('title', 'hello')
    form.append('images', new File(['a'], 'a.png', { type: 'image/png' }))
    form.append('images', new File(['b'], 'b.png', { type: 'image/png' }))

    const response = await http.post('/posts', form)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ body: { title: 'hello' }, files: ['a.png', 'b.png'] })
  })
})

describe('contractInput', () => {
  it('seeds what validated() reads in a controller unit test', async () => {
    class PostController extends Controller {
      read() {
        return this.validated('posts.store').body
      }
    }
    const controller = new PostController()
    controller.setContext(createControllerContext(
      'http://example.com/posts',
      { method: 'POST' },
      contractInput({ route: 'posts.store', body: { title: 'hello' } }),
    ) as unknown as ControllerContext as never)

    expect(controller.read()).toEqual({ title: 'hello' })
  })
})
