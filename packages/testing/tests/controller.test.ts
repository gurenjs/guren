import { describe, expect, it } from 'vitest'
import {
  createControllerContext,
  createGurenControllerModule,
  createControllerModuleMock,
  readInertiaResponse,
  type ControllerContext,
} from '../src/controller'

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

  // Hand-built rather than via FormData: passing a FormData body lets the
  // runtime pick the Content-Type, and the header is exactly what is under
  // test here.
  const multipart = (contentType: string): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body:
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="${FIELD}"\r\n\r\n` +
      `${VALUE}\r\n` +
      `--${BOUNDARY}--\r\n`,
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
   * as a throw. The runtime swallows it in exactly one place — the private
   * `getRawBody()` in `Controller` — while the exported `parseRequestPayload`
   * lets it out; the mock mirrors that split, so these pin the class layer.
   *
   * Both encodings are here because they fail differently: malformed JSON is
   * caught inside the parser (`.catch(() => ({}))`), while a multipart body
   * with no boundary rejects out of `formData()` and is only caught one level
   * up.
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
