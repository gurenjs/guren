import { describe, expect, it } from 'vitest'
import {
  createControllerContext,
  createGurenControllerModule,
  createControllerModuleMock,
  readInertiaResponse,
  type ControllerContext,
} from '../src/controller'

/**
 * Passes anything through, so a divergence between the mock and the runtime
 * shows up as a shape to compare rather than a 422 from either side.
 */
const identitySchema = {
  safeParse: (data: unknown) => ({ success: true as const, data }),
}

/**
 * A multipart body, hand-built rather than via `new FormData()`: handing
 * `fetch` a FormData body lets it pick the boundary *and* the media-type
 * casing, and the casing is one of the things these suites test.
 */
function multipartBody(boundary: string, fields: Array<[string, string]>): string {
  const parts = fields.map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  )

  return `${parts.join('')}--${boundary}--\r\n`
}

describe('createControllerContext', () => {
  it('creates context with correct URL parsing', () => {
    const ctx = createControllerContext('http://example.com/users/123?page=1')

    expect(ctx.req.path).toBe('/users/123')
    expect(ctx.req.url).toBe('http://example.com/users/123?page=1')
    expect(ctx.req.method).toBe('GET')
  })

  it('parses query parameters correctly', () => {
    const ctx = createControllerContext('http://example.com/search?q=hello&page=2')

    expect(ctx.req.query('q')).toBe('hello')
    expect(ctx.req.query('page')).toBe('2')
    expect(ctx.req.query('missing')).toBeUndefined()
  })

  it('returns all query params when no key provided', () => {
    const ctx = createControllerContext('http://example.com/search?a=1&b=2')
    const params = ctx.req.query() as Record<string, string>

    expect(params).toEqual({ a: '1', b: '2' })
  })

  it('provides header access', () => {
    const ctx = createControllerContext('http://example.com/', {
      headers: {
        'X-Custom-Header': 'custom-value',
        'Content-Type': 'application/json',
      },
    })

    expect(ctx.req.header('X-Custom-Header')).toBe('custom-value')
    expect(ctx.req.header('Content-Type')).toBe('application/json')
    expect(ctx.req.header('Missing-Header')).toBeUndefined()
  })

  it('preserves request method', () => {
    const getCtx = createControllerContext('http://example.com/', { method: 'GET' })
    const postCtx = createControllerContext('http://example.com/', { method: 'POST' })
    const putCtx = createControllerContext('http://example.com/', { method: 'PUT' })

    expect(getCtx.req.method).toBe('GET')
    expect(postCtx.req.method).toBe('POST')
    expect(putCtx.req.method).toBe('PUT')
  })

  it('provides access to raw Request object', () => {
    const ctx = createControllerContext('http://example.com/test')

    expect(ctx.req.raw).toBeInstanceOf(Request)
    expect(ctx.req.raw.url).toBe('http://example.com/test')
  })

  it('provides stub get/set methods', () => {
    const ctx = createControllerContext('http://example.com/')

    expect(ctx.get('any-key')).toBeUndefined()
    expect(() => ctx.set('key', 'value')).not.toThrow()
  })
})

describe('createGurenControllerModule', () => {
  it('returns Controller class', () => {
    const module = createGurenControllerModule()

    expect(module.Controller).toBeDefined()
    expect(typeof module.Controller).toBe('function')
  })

  it('Controller can set and get context', () => {
    const { Controller } = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/test')

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    expect(controller.ctx.req.path).toBe('/test')
  })

  it('Controller throws when context not set', () => {
    const { Controller } = createGurenControllerModule()
    const controller = new Controller()

    expect(() => controller.ctx).toThrow('Controller context has not been set.')
  })

  it('Controller.inertia returns JSON for XHR requests', async () => {
    const { Controller } = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/page', {
      headers: { 'X-Inertia': 'true' },
    })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.inertia('TestComponent', { foo: 'bar' })
    const { format, payload } = await readInertiaResponse(response)

    expect(format).toBe('json')
    expect(payload.component).toBe('TestComponent')
    expect(payload.props).toEqual({ foo: 'bar' })
  })

  it('Controller.inertia returns HTML for full page visits', async () => {
    const { Controller } = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/page')

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.inertia('TestComponent', { data: 123 })
    const { format, payload, body } = await readInertiaResponse(response)

    expect(format).toBe('html')
    expect(body).toContain('data-page=')
    expect(payload.component).toBe('TestComponent')
    expect(payload.props).toEqual({ data: 123 })
  })

  it('Controller.inertia uses custom URL from options', async () => {
    const { Controller } = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/original', {
      headers: { 'X-Inertia': 'true' },
    })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.inertia('Component', {}, { url: '/custom' })
    const { payload } = await readInertiaResponse(response)

    expect(payload.url).toBe('/custom')
  })

  it('Controller.inertia defaults the URL to the request path plus query string', async () => {
    const { Controller } = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/posts?page=2&sort=desc', {
      headers: { 'X-Inertia': 'true' },
    })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.inertia('Component', {})
    const { payload } = await readInertiaResponse(response)

    expect(payload.url).toBe('/posts?page=2&sort=desc')
  })

  it('parseRequestPayload parses JSON body', async () => {
    const module = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', value: 42 }),
      headers: { 'Content-Type': 'application/json' },
    })

    const payload = await module.parseRequestPayload(ctx as unknown as ControllerContext)

    expect(payload).toEqual({ name: 'Test', value: 42 })
  })

  it('parseRequestPayload parses URL-encoded body', async () => {
    const module = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/', {
      method: 'POST',
      body: 'name=Test&value=42',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    const payload = await module.parseRequestPayload(ctx as unknown as ControllerContext)

    expect(payload).toEqual({ name: 'Test', value: '42' })
  })

  it('parseRequestPayload returns empty object for unsupported content type', async () => {
    const module = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/', {
      method: 'POST',
      body: 'raw text',
      headers: { 'Content-Type': 'text/plain' },
    })

    const payload = await module.parseRequestPayload(ctx as unknown as ControllerContext)

    expect(payload).toEqual({})
  })

  // The runtime narrows here too: a non-object body has no field to read, so
  // the record view is `{}`. `parseRequestBody` is the one that keeps it.
  it('parseRequestPayload narrows a non-object JSON body to an empty object', async () => {
    const module = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/', {
      method: 'POST',
      body: JSON.stringify([1, 2, 3]),
      headers: { 'Content-Type': 'application/json' },
    })

    const payload = await module.parseRequestPayload(ctx as unknown as ControllerContext)

    expect(payload).toEqual({})
  })


  it('file() returns an uploaded multipart file and composes with validateBody()', async () => {
    const { Controller } = createControllerModuleMock()

    class UploadController extends Controller {
      async handle() {
        const data = await this.validateBody({
          safeParse: (input: unknown) => ({ success: true as const, data: input as { title: string } }),
        })
        const cover = await this.file('cover')
        const missing = await this.file('missing')
        return { data, cover, missing }
      }
    }

    const formData = new FormData()
    formData.append('title', 'Hello')
    formData.append('cover', new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' }))

    const controller = new UploadController()
    controller.setContext(createControllerContext('http://example.com/posts', {
      method: 'POST',
      body: formData,
    }) as unknown as ControllerContext)

    const result = await controller.handle()

    expect(result.data.title).toBe('Hello')
    expect(result.cover).toBeInstanceOf(File)
    expect(result.cover?.name).toBe('cover.png')
    expect(result.missing).toBeNull()
  })

  it('files() returns every file of a repeated multipart field', async () => {
    const { Controller } = createControllerModuleMock()

    class UploadController extends Controller {
      async handle() {
        return this.files('images')
      }
    }

    const formData = new FormData()
    formData.append('images', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    formData.append('images', new File([new Uint8Array([2])], 'b.png', { type: 'image/png' }))
    formData.append('images', new File([], 'empty.png', { type: 'image/png' }))

    const controller = new UploadController()
    controller.setContext(createControllerContext('http://example.com/posts', {
      method: 'POST',
      body: formData,
    }) as unknown as ControllerContext)

    const files = await controller.handle()

    expect(files.map((file) => file.name)).toEqual(['a.png', 'b.png'])
  })

  it('file() returns null when the first part of the field is empty, like the real Controller', async () => {
    const { Controller } = createControllerModuleMock()

    class UploadController extends Controller {
      async handle() {
        return this.file('cover')
      }
    }

    // A browser submits every same-named input, filled or not — the real
    // Controller.file() takes part 0 first and only then checks it is a
    // non-empty File, so a leading empty part means null.
    const formData = new FormData()
    formData.append('cover', new File([], 'empty.png', { type: 'image/png' }))
    formData.append('cover', new File([new Uint8Array([1])], 'real.png', { type: 'image/png' }))

    const controller = new UploadController()
    controller.setContext(createControllerContext('http://example.com/posts', {
      method: 'POST',
      body: formData,
    }) as unknown as ControllerContext)

    expect(await controller.handle()).toBeNull()
  })

  it('file() returns null for non-multipart requests', async () => {
    const { Controller } = createControllerModuleMock()

    class UploadController extends Controller {
      async handle() {
        return this.file('cover')
      }
    }

    const controller = new UploadController()
    controller.setContext(createControllerContext('http://example.com/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as ControllerContext)

    expect(await controller.handle()).toBeNull()
  })

  it('formatValidationErrors formats Zod-like error', () => {
    const module = createGurenControllerModule()
    const error = {
      issues: [
        { path: ['email'], message: 'Invalid email' },
        { path: ['password'], message: 'Too short' },
        { path: ['address', 'city'], message: 'Required' },
      ],
    }

    const formatted = module.formatValidationErrors(error)

    expect(formatted).toEqual({
      email: 'Invalid email',
      password: 'Too short',
      'address.city': 'Required',
    })
  })

  it('formatValidationErrors handles empty error', () => {
    const module = createGurenControllerModule()
    const formatted = module.formatValidationErrors({})

    expect(formatted).toEqual({})
  })
})

describe('createControllerModuleMock', () => {
  // The runtime falls back to `{}` for a body no form parser can decode, so a
  // malformed body is a validation failure rather than a 500. The mock keeps
  // its own copy of that parser, so the rule has to be pinned on both sides —
  // otherwise a controller test passes here against behavior the runtime does
  // not have.
  const undecodableForm = {
    method: 'POST',
    body: 'broken',
    headers: { 'Content-Type': 'multipart/form-data' },
  }

  const requireTitle = {
    safeParse: (data: unknown) =>
      typeof data === 'object' && data !== null && typeof (data as { title?: unknown }).title === 'string'
        ? { success: true as const, data }
        : { success: false as const, error: { issues: [{ path: ['title'], message: 'required' }] } },
  }

  it('parseRequestPayload falls back to {} for a body the form parser cannot decode', async () => {
    const module = createGurenControllerModule()
    const ctx = createControllerContext('http://example.com/posts', undecodableForm)

    expect(await module.parseRequestPayload(ctx as unknown as ControllerContext)).toEqual({})
  })

  it('validateBody() fails validation on an undecodable body rather than throwing', async () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/posts', undecodableForm)

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    // The failure must be the validation one, not the parser's TypeError.
    await expect(controller.validateBody(requireTitle)).rejects.toThrow(/valid/i)
  })

  // Pins that the fallback is `{}` and not `undefined`: an all-optional schema
  // has to keep passing, exactly as it does on an empty body.
  it('validateBody() passes an all-optional schema the empty-object fallback', async () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/posts', undecodableForm)

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const allOptional = { safeParse: (data: unknown) => ({ success: true as const, data }) }

    expect(await controller.validateBody(allOptional)).toEqual({})
  })

  // The upload helpers read the multipart body on their own rather than
  // through the parser above, so they need their own guard on both sides —
  // the runtime answers null/[] here, and a mock that threw would fail a
  // controller test the real app passes.
  it('file() / files() report no upload for a body the parser cannot decode', async () => {
    const { Controller } = createControllerModuleMock()

    class UploadController extends Controller {
      async handle() {
        return { avatar: await this.file('avatar'), gallery: await this.files('gallery') }
      }
    }

    const controller = new UploadController()
    controller.setContext(
      createControllerContext('http://example.com/uploads', undecodableForm) as unknown as ControllerContext,
    )

    expect(await controller.handle()).toEqual({ avatar: null, gallery: [] })
  })

  it('validateBody() accepts a non-object body, while input() keeps the record view', async () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/bulk', {
      method: 'POST',
      body: JSON.stringify([1, 2, 3]),
      headers: { 'Content-Type': 'application/json' },
    })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    // Hand-rolled rather than a zod import: the mock takes any `safeParse`,
    // and this test is about the shape reaching the schema at all.
    const numberArray = {
      safeParse: (data: unknown) =>
        Array.isArray(data) && data.every((n) => typeof n === 'number')
          ? { success: true as const, data: data as number[] }
          : { success: false as const, error: { issues: [{ path: [], message: 'expected number[]' }] } },
    }

    expect(await controller.validateBody(numberArray)).toEqual([1, 2, 3])
    expect(await controller.input('title')).toBeUndefined()
  })

  // Every shape the runtime's parseRequestBody preserves, driven through the
  // path that actually consumes it. `null` is the one worth naming: it is a
  // parsed body, not an absent one, so coalescing it to `{}` would hand
  // validation a shape nobody sent.
  it('validateBody() sees the body as sent, whatever its shape', async () => {
    const { Controller } = createControllerModuleMock()

    const seen: unknown[] = []
    const capture = {
      safeParse: (data: unknown) => {
        seen.push(data)
        return { success: true as const, data }
      },
    }

    const validate = async (body: string, contentType = 'application/json') => {
      const controller = new Controller()
      controller.setContext(
        createControllerContext('http://example.com/bulk', {
          method: 'POST',
          body,
          headers: { 'Content-Type': contentType },
        }) as unknown as ControllerContext,
      )
      return controller.validateBody(capture)
    }

    expect(await validate(JSON.stringify([1, 2, 3]))).toEqual([1, 2, 3])
    expect(await validate(JSON.stringify('hello'))).toBe('hello')
    expect(await validate(JSON.stringify(null))).toBeNull()
    // Malformed bodies fall back to `{}` the way the real Controller does,
    // rather than throwing out of validateBody(). Both parsers are covered:
    // JSON by its own catch, form data by the controller's.
    expect(await validate('{ not json')).toEqual({})
    expect(await validate('broken', 'multipart/form-data')).toEqual({})
    expect(seen).toHaveLength(5)
  })

  it('reads the body once per controller, memoizing the record view', async () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Guren' }),
      headers: { 'Content-Type': 'application/json' },
    })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    expect(await controller.input('title')).toBe('Guren')
    expect(await controller.input('title')).toBe('Guren')
    expect(controller.parsedBody).toEqual({ title: 'Guren' })
  })

  it('extends Controller with json method', () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/api')

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.json({ success: true })

    expect(response.headers.get('Content-Type')).toContain('application/json')
  })

  it('json method includes custom status', async () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/api')

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.json({ error: 'Not found' }, { status: 404 })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'Not found' })
  })

  it('redirect method returns 302 for GET requests', () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/', { method: 'GET' })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.redirect('/dashboard')

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/dashboard')
  })

  it('redirect method returns 303 for POST requests', () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/', { method: 'POST' })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.redirect('/success')

    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/success')
  })

  it('redirect method respects custom status', () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/', { method: 'POST' })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const response = controller.redirect('/permanent', { status: 301 })

    expect(response.status).toBe(301)
  })

  it('provides request property on mock controller', () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/users/1', { method: 'GET' })

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    expect(controller.request.path).toBe('/users/1')
    expect(controller.request.method).toBe('GET')
  })

  it('defines application modules and their providers', () => {
    const { ServiceProvider, defineModule } = createControllerModuleMock()

    class WidgetProvider extends ServiceProvider {
      register(): void {}
    }

    const widgets = defineModule({ name: 'widgets', providers: [WidgetProvider] })
    const bare = defineModule({ name: 'bare' })

    expect(widgets.providers).toEqual([WidgetProvider])
    expect(bare.providers).toEqual([])

    const provider = new WidgetProvider('container')
    provider.register()
    provider.boot()

    expect(provider.container).toBe('container')
  })
})

describe('readInertiaResponse', () => {
  it('parses JSON response correctly', async () => {
    const payload = {
      component: 'TestPage',
      props: { message: 'Hello' },
      url: '/test',
    }

    const response = new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    })

    const result = await readInertiaResponse(response)

    expect(result.format).toBe('json')
    expect(result.payload).toEqual(payload)
  })

  it('parses HTML response and extracts data-page', async () => {
    const payload = { component: 'Page', props: { x: 1 }, url: '/page' }
    const escaped = JSON.stringify(payload).replace(/"/g, '&quot;')
    const html = `<div id="app" data-page="${escaped}"></div>`

    const response = new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    })

    const result = await readInertiaResponse(response)

    expect(result.format).toBe('html')
    expect(result.body).toContain('data-page=')
    expect(result.payload).toEqual(payload)
  })

  it('throws when HTML lacks data-page attribute', async () => {
    const response = new Response('<div>No page data</div>', {
      headers: { 'Content-Type': 'text/html' },
    })

    await expect(readInertiaResponse(response)).rejects.toThrow(
      'Unable to find Inertia payload in HTML response.'
    )
  })

  it('decodes HTML entities in data-page', async () => {
    const payload = { component: 'Test', props: { html: '<div>&</div>' }, url: '/' }
    // Simulate what the controller does: escape special chars
    const serialized = JSON.stringify(payload)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

    const html = `<div data-page="${serialized}"></div>`

    const response = new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    })

    const result = await readInertiaResponse(response)

    expect(result.payload.props.html).toBe('<div>&</div>')
  })
})

/**
 * The mock and the runtime must read a repeated form field identically, or a
 * controller test passes on behavior production does not have.
 *
 * The rule is Hono's, not "first wins": `parseBody()` collects every value
 * only for a `[]`-suffixed key, and the runtime's `parseRequestPayload` then
 * flattens with `Array.isArray(v) ? v[0] : v`. So `tags[]` yields the FIRST
 * value and a plain repeated `tags` yields the LAST. Both keys are asserted
 * here on purpose: a `tags[]`-only test also passes under a blanket
 * first-wins mock, which would agree with the runtime on `tags[]` while
 * newly disagreeing on `tags`.
 *
 * Each case runs the same body through the mock and through a real
 * `Application.fetch()`, so the two cannot drift apart again.
 */
describe('repeated form fields', () => {
  const FIRST = 'core'
  const LAST = 'framework'

  const KEYS = [
    { key: 'tags[]', expected: FIRST, rule: 'keeps the first value' },
    { key: 'tags', expected: LAST, rule: 'keeps the last value' },
  ] as const

  const BODIES = [
    {
      encoding: 'urlencoded',
      build: (key: string): RequestInit => {
        const params = new URLSearchParams()
        params.append(key, FIRST)
        params.append(key, LAST)
        return {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        }
      },
    },
    {
      encoding: 'multipart',
      build: (key: string): RequestInit => {
        const form = new FormData()
        form.append(key, FIRST)
        form.append(key, LAST)
        return { method: 'POST', body: form }
      },
    },
  ] as const

  async function readThroughMock(key: string, init: RequestInit): Promise<unknown> {
    const { Controller } = createControllerModuleMock()

    class ReadController extends Controller {
      async read() {
        return this.input<string>(key)
      }
    }

    const controller = new ReadController()
    controller.setContext(
      createControllerContext('http://example.com/posts', init) as unknown as ControllerContext
    )

    return controller.read()
  }

  async function readThroughRuntime(key: string, init: RequestInit): Promise<unknown> {
    // Lazy, like the rest of this package: the mock resolves @guren/server on
    // demand so a suite that mocks it still gets the real module here.
    const { Controller, createApp } = await import('@guren/core')

    class ReadController extends Controller {
      async read() {
        return this.json({ value: (await this.input<string>(key)) ?? null })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.post('/posts', [ReadController, 'read'])
      },
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/posts', init))
    expect(response.status).toBe(200)

    return ((await response.json()) as { value: unknown }).value
  }

  /**
   * `__proto__` must survive as an own property, as it does in the runtime:
   * Hono collects into a null-prototype object and `parseRequestPayload`
   * materializes it with `Object.fromEntries`. Assigning into an object
   * literal instead hits the inherited setter and drops the field silently,
   * which would let a mass-assignment test pass against a body the runtime
   * actually delivers.
   */
  for (const { encoding, build } of BODIES) {
    it(`${encoding}: a \`__proto__\` field survives in the mock and the runtime`, async () => {
      const key = '__proto__'
      const fromMock = await readThroughMock(key, build(key))
      const fromRuntime = await readThroughRuntime(key, build(key))

      expect(fromRuntime).toBe(LAST)
      expect(fromMock).toBe(LAST)
    })
  }

  for (const { encoding, build } of BODIES) {
    for (const { key, expected, rule } of KEYS) {
      it(`${encoding}: a repeated \`${key}\` ${rule} in the mock and the runtime`, async () => {
        const init = build(key)

        const fromMock = await readThroughMock(key, build(key))
        const fromRuntime = await readThroughRuntime(key, init)

        expect(fromRuntime).toBe(expected)
        expect(fromMock).toBe(expected)
        expect(fromMock).toBe(fromRuntime as string)
      })
    }
  }
})

/**
 * The mock and the runtime must hand a validation schema the same query data,
 * or a controller test passes on behavior production does not have.
 *
 * The runtime validates against `flattenRequestQueries`, which reads
 * `ctx.req.queries()` and returns `values.length === 1 ? values[0] : values` —
 * so a repeated key arrives as an ARRAY and a single occurrence as a string.
 * The mock validated against `ctx.req.query()`, one value per key, so
 * `?tag=a&tag=b` reached a `z.array(...)` schema as `'b'`.
 *
 * The probe is `validateQuery`/`validateQuerySafe` specifically: `input()`
 * takes the keyed `query(key)` form on both sides and already agreed, so an
 * `input()`-based test here could never fail. The schema is an identity one so
 * the buggy mock returns a wrong shape instead of throwing 422, which is what
 * lets the two sides be compared directly. Both keys are asserted on purpose:
 * a repeated-only case also passes under a mock that wraps every value in an
 * array, which would agree on `tag` while newly disagreeing on `page`.
 */
describe('repeated query parameters', () => {
  const URL_UNDER_TEST = 'http://example.com/posts?tag=core&tag=framework&page=2'
  const EXPECTED = { tag: ['core', 'framework'], page: '2' }

  /** Both surfaces read the same context, so one pass answers for both. */
  interface BothSurfaces {
    validateQuery: unknown
    validateQuerySafe: unknown
  }

  function readThroughMock(ctx: ControllerContext): BothSurfaces {
    const { Controller } = createControllerModuleMock()

    class ReadController extends Controller {
      read(): BothSurfaces {
        const safe = this.validateQuerySafe(identitySchema)
        return {
          validateQuery: this.validateQuery(identitySchema),
          validateQuerySafe: safe.success ? safe.data : safe.errors,
        }
      }
    }

    const controller = new ReadController()
    controller.setContext(ctx)

    return controller.read()
  }

  async function readThroughRuntime(): Promise<BothSurfaces> {
    // Lazy, like the rest of this package: the mock resolves @guren/server on
    // demand so a suite that mocks it still gets the real module here.
    const { Controller, createApp } = await import('@guren/core')

    class ReadController extends Controller {
      read() {
        const safe = this.validateQuerySafe(identitySchema)
        return this.json({
          validateQuery: this.validateQuery(identitySchema),
          validateQuerySafe: safe.success ? safe.data : safe.errors,
        })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.get('/posts', [ReadController, 'read'])
      },
    })
    await app.boot()

    const response = await app.fetch(new Request(URL_UNDER_TEST))
    expect(response.status).toBe(200)

    return (await response.json()) as BothSurfaces
  }

  it('validateQuery()/validateQuerySafe() see repeated keys as arrays in the mock and the runtime', async () => {
    const fromRuntime = await readThroughRuntime()
    const fromMock = readThroughMock(
      createControllerContext(URL_UNDER_TEST) as unknown as ControllerContext
    )

    expect(fromRuntime).toEqual({ validateQuery: EXPECTED, validateQuerySafe: EXPECTED })
    expect(fromMock).toEqual(fromRuntime)
  })

  it('flattens from req.url when the context has no queries()', () => {
    // The fallback branch of flattenContextQueries: `queries()` is optional on
    // ControllerContext, and a hand-rolled context without one must still see
    // the array — falling back to `query()` would quietly restore the bug.
    const full = createControllerContext(URL_UNDER_TEST)
    const withoutQueries = {
      ...full,
      req: { ...full.req, queries: undefined },
    } as unknown as ControllerContext

    expect(readThroughMock(withoutQueries).validateQuery).toEqual(EXPECTED)
  })

  it('honors a queries() override that reads `this`', () => {
    // `queries?: () => Record<string, string[]>` is satisfied by a method as
    // readily as by an arrow, so an override may legitimately read `this.url`.
    // The shared rule is reached by handing it an object with a `queries`
    // member; passing the bare `ctx.req.queries` reference would re-`this` it
    // onto that object and read `undefined` — the receiver has to survive.
    const full = createControllerContext(URL_UNDER_TEST)
    const withThisOverride = {
      ...full,
      req: {
        ...full.req,
        queries(this: { url: string }) {
          const params = new URL(this.url).searchParams
          return Object.fromEntries([...params.keys()].map((key) => [key, params.getAll(key)]))
        },
      },
    } as unknown as ControllerContext

    expect(readThroughMock(withThisOverride).validateQuery).toEqual(EXPECTED)
  })

  it('reads back the first occurrence from the mock context, as Hono does', () => {
    const ctx = createControllerContext(URL_UNDER_TEST)

    expect(ctx.req.query()).toEqual({ tag: 'core', page: '2' })
    expect(ctx.req.query('tag')).toBe('core')
  })

  /**
   * A `__proto__` query key, which is where the mock's hand-rolled `query()`
   * diverged from the runtime it was imitating.
   *
   * The copy built its record by assignment (`first[name] ??= value`), so the
   * key hit `Object.prototype`'s inherited `__proto__` setter and the field
   * vanished — a controller read it as absent while production read it as a
   * value. Hono builds a null-prototype object, which has no setter to hit.
   * Delegating to `HonoRequest` is what closes it; asserting against a real
   * `Application.fetch()` is what keeps it closed.
   *
   * `queries()` never had the bug — it was already `Object.fromEntries`, which
   * defines an own property — but it is asserted alongside so the pair cannot
   * drift apart in the other direction either.
   */
  it('keeps a __proto__ query key in the mock and the runtime alike', async () => {
    const url = 'http://example.com/posts?__proto__=pwned&tag=core&tag=framework'

    const { Controller, createApp } = await import('@guren/core')

    class ReadController extends Controller {
      read() {
        return this.json({
          query: this.ctx.req.query(),
          queries: this.ctx.req.queries(),
        })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.get('/posts', [ReadController, 'read'])
      },
    })
    await app.boot()

    const response = await app.fetch(new Request(url))
    expect(response.status).toBe(200)
    const fromRuntime = (await response.json()) as Record<string, unknown>

    const ctx = createControllerContext(url)
    const fromMock = {
      query: ctx.req.query(),
      queries: ctx.req.queries?.(),
    }

    // Asserted concretely as well as for parity, so the two cannot agree on
    // the wrong answer — `toEqual` alone would pass if both dropped the key.
    //
    // The expectations are built with `Object.fromEntries`, never as object
    // literals: a bare `__proto__:` key in a literal sets the prototype rather
    // than defining an own property, so `{ __proto__: 'pwned', tag: 'core' }`
    // is just `{ tag: 'core' }` and this test would assert the bug it exists
    // to catch. That is the same footgun the code under test hits.
    expect(Object.hasOwn(fromMock.query as object, '__proto__')).toBe(true)
    expect(fromMock).toEqual({
      query: Object.fromEntries([
        ['__proto__', 'pwned'],
        ['tag', 'core'],
      ]),
      queries: Object.fromEntries([
        ['__proto__', ['pwned']],
        ['tag', ['core', 'framework']],
      ]),
    })
    expect(fromMock).toEqual(fromRuntime)
  })
})

/**
 * The mock and the runtime must agree on *which* bodies they read, or a
 * controller test passes on behavior production does not have.
 *
 * The runtime's rule has two halves, and they are not the same rule:
 *
 * - JSON is a case-sensitive substring test. `parseRequestBody()` reaches
 *   `ctx.req.json()` through `contentType.includes('application/json')`, so
 *   `application/json-evil` is read as JSON while `Application/JSON` is not.
 * - Everything else falls through to `ctx.req.parseBody()`, which compares
 *   the media type — `Content-Type` up to the first `;`, trimmed and
 *   lowercased — with `===`. So `Application/X-WWW-Form-Urlencoded` parses
 *   and `application/x-www-form-urlencoded-evil` does not.
 *
 * A substring test on the form branches diverges in both directions at once,
 * which is why both directions are asserted here. Each case runs the same
 * request through the mock and through a real `Application.fetch()`, and
 * asserts the concrete value as well, so the pair cannot agree on the wrong
 * answer.
 */
describe('body content-type recognition', () => {
  const FIELD = 'a'
  const VALUE = 'hit'
  const BOUNDARY = '----gurenparity'

  const urlencoded = (contentType: string): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: new URLSearchParams({ [FIELD]: VALUE }).toString(),
  })

  const json = (contentType: string): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: JSON.stringify({ [FIELD]: VALUE }),
  })

  const multipart = (contentType: string): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: multipartBody(BOUNDARY, [[FIELD, VALUE]]),
  })

  async function readThroughControllerMock(init: RequestInit): Promise<unknown> {
    const { Controller } = createControllerModuleMock()

    class ReadController extends Controller {
      async read() {
        return (await this.input<string>(FIELD)) ?? null
      }
    }

    const controller = new ReadController()
    controller.setContext(
      createControllerContext('http://example.com/posts', init) as unknown as ControllerContext
    )

    return controller.read()
  }

  async function readThroughApplication(init: RequestInit): Promise<unknown> {
    // Lazy, like the rest of this package: the mock resolves @guren/server on
    // demand so a suite that mocks it still gets the real module here.
    const { Controller, createApp } = await import('@guren/core')

    class ReadController extends Controller {
      async read() {
        return this.json({ value: (await this.input<string>(FIELD)) ?? null })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.post('/posts', [ReadController, 'read'])
      },
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/posts', init))
    expect(response.status).toBe(200)

    return ((await response.json()) as { value: unknown }).value
  }

  const CASES = [
    {
      name: 'a mixed-case urlencoded media type is read',
      init: () => urlencoded('Application/X-WWW-Form-Urlencoded'),
      expected: VALUE,
    },
    {
      name: 'a urlencoded media type with parameters is read',
      init: () => urlencoded('application/x-www-form-urlencoded; charset=UTF-8'),
      expected: VALUE,
    },
    {
      name: 'a media type that merely starts with the urlencoded one is ignored',
      init: () => urlencoded('application/x-www-form-urlencoded-evil'),
      expected: null,
    },
    {
      name: 'a mixed-case multipart media type is read',
      init: () => multipart(`Multipart/Form-Data; boundary=${BOUNDARY}`),
      expected: VALUE,
    },
    {
      name: 'a media type that merely starts with the multipart one is ignored',
      init: () => multipart(`multipart/form-data-evil; boundary=${BOUNDARY}`),
      expected: null,
    },
    // The JSON branch is asserted, not assumed: the runtime gates it on a
    // case-sensitive substring, so these two are the shape a media-type rule
    // applied there would break.
    {
      name: 'a mixed-case JSON media type is not read as JSON',
      init: () => json('Application/JSON'),
      expected: null,
    },
    {
      name: 'a media type that merely starts with the JSON one is read as JSON',
      init: () => json('application/json-evil'),
      expected: VALUE,
    },
  ] as const

  for (const { name, init, expected } of CASES) {
    it(`${name}, in the mock and the runtime`, async () => {
      const fromMock = await readThroughControllerMock(init())
      const fromRuntime = await readThroughApplication(init())

      expect(fromRuntime).toBe(expected)
      expect(fromMock).toBe(expected)
      expect(fromMock).toBe(fromRuntime)
    })
  }

  /**
   * The same rule has to hold on the module's `parseRequestPayload`, not just
   * on the class: a route contract's `body` and `validateRequest()` reach the
   * body through that export and never touch a Controller instance, so an app
   * that mocks `@guren/core` gets its contract validation from here.
   */
  it('parseRequestPayload applies the media-type rule in the mock and the runtime', async () => {
    const init = urlencoded('Application/X-WWW-Form-Urlencoded')

    const fromMock = await createGurenControllerModule().parseRequestPayload(
      createControllerContext('http://example.com/posts', init) as unknown as ControllerContext
    )

    const { Controller, createApp } = await import('@guren/core')
    const { parseRequestPayload } = await import('@guren/server')

    class ReadController extends Controller {
      async read() {
        return this.json({ value: await parseRequestPayload(this.ctx) })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.post('/posts', [ReadController, 'read'])
      },
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/posts', init))
    expect(response.status).toBe(200)
    const fromRuntime = ((await response.json()) as { value: unknown }).value

    expect(fromRuntime).toEqual({ [FIELD]: VALUE })
    expect(fromMock).toEqual({ [FIELD]: VALUE })
  })

  /**
   * `file()` reads the multipart body through a separate gate in both — the
   * mock's `readMultipart()`, the runtime's `ctx.req.parseBody({ all: true })`
   * — so the media-type rule has to hold there too, or an upload test passes
   * against a file the runtime would have delivered (or missed).
   */
  it('file() sees a mixed-case multipart media type in the mock and the runtime', async () => {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': `Multipart/Form-Data; boundary=${BOUNDARY}` },
      body:
        `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="avatar"; filename="a.txt"\r\n` +
        'Content-Type: text/plain\r\n\r\n' +
        'hello\r\n' +
        `--${BOUNDARY}--\r\n`,
    }

    const { Controller: MockController } = createControllerModuleMock()

    class MockUploadController extends MockController {
      async upload() {
        return (await this.file('avatar'))?.name ?? null
      }
    }

    const mockController = new MockUploadController()
    mockController.setContext(
      createControllerContext('http://example.com/uploads', init) as unknown as ControllerContext
    )
    const fromMock = await mockController.upload()

    const { Controller, createApp } = await import('@guren/core')

    class UploadController extends Controller {
      async upload() {
        return this.json({ value: (await this.file('avatar'))?.name ?? null })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.post('/uploads', [UploadController, 'upload'])
      },
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/uploads', init))
    expect(response.status).toBe(200)
    const fromRuntime = ((await response.json()) as { value: unknown }).value

    expect(fromRuntime).toBe('a.txt')
    expect(fromMock).toBe('a.txt')
  })

  /**
   * A body the parser cannot read must reach the field helpers as `{}`, not
   * as a throw. Both sides swallow it in `parseRequestBody` itself, so every
   * caller inherits the fallback — the field helpers here and the exported
   * `parseRequestPayload` alike.
   *
   * Both encodings are here because they fail differently: malformed JSON is
   * caught by the JSON branch's own `.catch(() => ({}))`, while a multipart
   * body with no boundary rejects out of the form parse and is caught by the
   * fallback wrapping the whole function.
   */
  const MALFORMED = [
    {
      name: 'malformed JSON',
      init: (): RequestInit => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
    },
    {
      name: 'a multipart body with no boundary',
      init: (): RequestInit => ({
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' },
        body: 'not a multipart body',
      }),
    },
  ] as const

  for (const { name, init } of MALFORMED) {
    it(`${name} reads as an empty body in the mock and the runtime`, async () => {
      const fromMock = await readThroughControllerMock(init())
      const fromRuntime = await readThroughApplication(init())

      expect(fromRuntime).toBe(null)
      expect(fromMock).toBe(null)
    })
  }
})

/**
 * The runtime-versus-mock table for request bodies.
 *
 * Every row runs one request through a real `Application.fetch()` controller
 * and through a mocked one, and both must answer the same thing. The suites
 * either side of this one exercise each implementation separately, which is
 * exactly why three divergences lived here unnoticed: a test can only catch a
 * disagreement it puts side by side.
 *
 * What the rows are chosen to cover — the axes the two used to disagree on:
 *
 * - **Case.** Hono lowercases the media type before deciding; the mock tested
 *   the raw header with `includes()`, so `APPLICATION/X-WWW-FORM-URLENCODED`
 *   parsed in production and read as `{}` in a test.
 * - **Parameters.** Hono compares against `contentType.split(';')[0]`, so a
 *   `;`-parameterized type is the form type, while a type that merely mentions
 *   one in a parameter is not. The mock's substring test could not tell those
 *   apart.
 * - **Repeated fields.** Hono collects keys ending in `[]` into an array
 *   (other repeats are last-wins), and the runtime then takes `value[0]` —
 *   first wins. The mock's `Object.fromEntries(new URLSearchParams(...))` took
 *   the last.
 *
 * Two rows deserve their expectation spelled out, because both look wrong:
 *
 * - `APPLICATION/JSON` reads as `{}` on BOTH sides. The runtime's JSON branch
 *   is a case-sensitive `contentType.includes('application/json')` on the raw
 *   header, so an uppercase one misses it and falls through to Hono, which
 *   does not call it a form either. That is the runtime's behavior, and this
 *   table's job is to state it, not to improve it.
 * - `text/plain; profile=application/json` parses AS JSON, for the same
 *   reason read the other way: the substring is present. This is the one place
 *   the runtime is not Hono-normalized, and so the one row that would break
 *   first if the mock ever grew its own JSON test again.
 *
 * `text/plain; profile=application/x-www-form-urlencoded` is `{}` on both
 * sides today, but it is not a vacuous row: before the fix the mock reached
 * that `{}` by parsing the body as a form and the runtime by refusing it, so
 * the two agreed on this body and would have parted on the next one.
 */
describe('request body parity', () => {
  const URL_UNDER_TEST = 'http://example.com/parity'
  const BOUNDARY = 'guren-parity-boundary'

  interface BodyCase {
    name: string
    /** Left unset only by the "no content type" row, which asserts its absence. */
    contentType?: string
    body: BodyInit
    expected: unknown
  }

  const CASES: BodyCase[] = [
    {
      name: 'json',
      contentType: 'application/json',
      body: '{"title":"Guren"}',
      expected: { title: 'Guren' },
    },
    {
      name: 'json with a charset parameter',
      contentType: 'application/json; charset=utf-8',
      body: '{"title":"Guren"}',
      expected: { title: 'Guren' },
    },
    {
      // The parser hands the value over as sent; the schema decides the shape.
      name: 'a json array body, which must reach validation unnarrowed',
      contentType: 'application/json',
      body: '[1,2]',
      expected: [1, 2],
    },
    {
      name: 'a malformed json body',
      contentType: 'application/json',
      body: '{oops',
      expected: {},
    },
    {
      name: 'an uppercase json media type, which neither side reads as json',
      contentType: 'APPLICATION/JSON',
      body: '{"title":"Guren"}',
      expected: {},
    },
    {
      name: 'a media type that merely mentions application/json, which both read as json',
      contentType: 'text/plain; profile=application/json',
      body: '{"title":"Guren"}',
      expected: { title: 'Guren' },
    },
    {
      name: 'urlencoded',
      contentType: 'application/x-www-form-urlencoded',
      body: 'title=Guren',
      expected: { title: 'Guren' },
    },
    {
      name: 'an uppercase urlencoded media type',
      contentType: 'APPLICATION/X-WWW-FORM-URLENCODED',
      body: 'title=Guren',
      expected: { title: 'Guren' },
    },
    {
      name: 'urlencoded with a charset parameter',
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: 'title=Guren',
      expected: { title: 'Guren' },
    },
    {
      name: 'a repeated urlencoded field[], which keeps the first value',
      contentType: 'application/x-www-form-urlencoded',
      body: 'tag[]=a&tag[]=b',
      expected: { 'tag[]': 'a' },
    },
    {
      // Hono only arrays the `[]` keys, so a plain repeat is last-wins on both
      // sides. Pinned so a fix aimed at the row above cannot silently take
      // this one with it.
      name: 'a repeated plain urlencoded field, which keeps the last value',
      contentType: 'application/x-www-form-urlencoded',
      body: 'tag=a&tag=b',
      expected: { tag: 'b' },
    },
    {
      name: 'a media type that merely mentions the urlencoded one, which is not a form',
      contentType: 'text/plain; profile=application/x-www-form-urlencoded',
      body: 'title=Guren',
      expected: {},
    },
    {
      name: 'multipart',
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [['title', 'Guren']]),
      expected: { title: 'Guren' },
    },
    {
      name: 'an uppercase multipart media type',
      contentType: `MULTIPART/FORM-DATA; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [['title', 'Guren']]),
      expected: { title: 'Guren' },
    },
    {
      name: 'a repeated multipart field[], which keeps the first value',
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [
        ['tag[]', 'a'],
        ['tag[]', 'b'],
      ]),
      expected: { 'tag[]': 'a' },
    },
    {
      name: 'an unsupported media type',
      contentType: 'text/plain',
      body: 'title=Guren',
      expected: {},
    },
    {
      // A view body sets no Content-Type, unlike a string one.
      name: 'no content type at all',
      body: new Uint8Array([0x74, 0x69, 0x74, 0x6c, 0x65, 0x3d, 0x41]),
      expected: {},
    },
  ]

  function initFor(testCase: BodyCase): RequestInit {
    return {
      method: 'POST',
      ...(testCase.contentType ? { headers: { 'Content-Type': testCase.contentType } } : {}),
      body: testCase.body,
    }
  }

  async function readThroughMock(testCase: BodyCase): Promise<unknown> {
    const { Controller } = createControllerModuleMock()

    class ReadController extends Controller {
      read(): Promise<unknown> {
        return this.validateBody(identitySchema)
      }
    }

    const controller = new ReadController()
    controller.setContext(
      createControllerContext(URL_UNDER_TEST, initFor(testCase)) as unknown as ControllerContext,
    )

    return controller.read()
  }

  /**
   * One booted app serves every row. Lazy, like the rest of this package: the
   * mock resolves @guren/server on demand so a suite that mocks it still gets
   * the real module here.
   */
  let runtimeApp: Promise<{ fetch: (request: Request) => Response | Promise<Response> }> | undefined

  function bootRuntime() {
    runtimeApp ??= import('@guren/core').then(async ({ Controller, createApp }) => {
      class ReadController extends Controller {
        async read() {
          return this.json({ body: await this.validateBody(identitySchema) })
        }
      }

      const app = createApp({
        routes: (router) => {
          router.post('/parity', [ReadController, 'read'])
        },
      })
      await app.boot()

      return app
    })

    return runtimeApp
  }

  async function readThroughRuntime(testCase: BodyCase): Promise<unknown> {
    const app = await bootRuntime()
    const response = await app.fetch(new Request(URL_UNDER_TEST, initFor(testCase)))

    expect(response.status).toBe(200)

    return ((await response.json()) as { body: unknown }).body
  }

  /**
   * The runtime boxes its parse (`Controller.getRawBody`), so two reads in one
   * action are handed the same object. The mock clones the request, so nothing
   * forces it to re-read — but re-parsing is not the same answer: it hands out
   * two objects where the runtime hands out one, and a schema that mutates what
   * it validates then sees a different body on the second read.
   *
   * Identity is the probe because it is the only thing that separates one parse
   * from two. Every row above reads each request once and so cannot see this.
   */
  it('hands both reads of one body the same object, as the runtime does', async () => {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Guren"}',
    }

    const { Controller } = createControllerModuleMock()

    class TwiceController extends Controller {
      async read(): Promise<boolean> {
        return (await this.validateBody(identitySchema)) === (await this.validateBody(identitySchema))
      }
    }

    const controller = new TwiceController()
    controller.setContext(
      createControllerContext(URL_UNDER_TEST, init) as unknown as ControllerContext,
    )

    expect(await controller.read()).toBe(true)

    const { Controller: RuntimeController, createApp } = await import('@guren/core')

    class RuntimeTwiceController extends RuntimeController {
      async read() {
        const first = await this.validateBody(identitySchema)
        const second = await this.validateBody(identitySchema)
        return this.json({ same: first === second })
      }
    }

    const app = createApp({
      routes: (router) => {
        router.post('/twice', [RuntimeTwiceController, 'read'])
      },
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/twice', init))
    expect(await response.json()).toEqual({ same: true })
  })

  it.each(CASES)('agrees on $name', async (testCase) => {
    // A row claiming no content type has to prove it: `fetch` supplies one for
    // a string body, which would quietly turn this into some other row.
    if (!testCase.contentType) {
      expect(new Request(URL_UNDER_TEST, initFor(testCase)).headers.get('content-type')).toBeNull()
    }

    const fromRuntime = await readThroughRuntime(testCase)
    expect(fromRuntime).toEqual(testCase.expected)

    expect(await readThroughMock(testCase)).toEqual(fromRuntime)
  })
})
