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
 * Hand-built rather than via `new FormData()`: handing `fetch` a FormData body
 * lets it pick the boundary *and* the media-type casing, and the casing is one
 * of the things these suites test.
 *
 * A third element makes the part a file. An empty `value` beside a filename
 * still produces a zero-byte File, which is what the `size > 0` filter in
 * `file()` / `files()` rejects. The part-level `Content-Type` is emitted only
 * alongside a filename, so a text field still parses as a string.
 */
function multipartBody(
  boundary: string,
  fields: Array<[name: string, value: string, filename?: string]>,
): string {
  const parts = fields.map(([name, value, filename]) =>
    filename === undefined
      ? `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      : `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        'Content-Type: text/plain\r\n\r\n' +
        `${value}\r\n`,
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

  // The runtime narrows here too; `parseRequestBody` is the one that keeps the
  // unnarrowed body.
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

    // A browser submits every same-named input, filled or not, and file() takes
    // part 0 before checking it is a non-empty File: a leading empty part is null.
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
  // The runtime falls back to `{}` for an undecodable body, so a malformed body
  // is a validation failure rather than a 500. The mock keeps its own copy of
  // that parser, so the rule is pinned on both sides.
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

  // The fallback is `{}`, not `undefined`: an all-optional schema keeps passing.
  it('validateBody() passes an all-optional schema the empty-object fallback', async () => {
    const { Controller } = createControllerModuleMock()
    const ctx = createControllerContext('http://example.com/posts', undecodableForm)

    const controller = new Controller()
    controller.setContext(ctx as unknown as ControllerContext)

    const allOptional = { safeParse: (data: unknown) => ({ success: true as const, data }) }

    expect(await controller.validateBody(allOptional)).toEqual({})
  })

  // The upload helpers read the multipart body themselves rather than through
  // the parser above, so they need their own guard on both sides.
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

    // Hand-rolled rather than a zod import: the mock takes any `safeParse`.
    const numberArray = {
      safeParse: (data: unknown) =>
        Array.isArray(data) && data.every((n) => typeof n === 'number')
          ? { success: true as const, data: data as number[] }
          : { success: false as const, error: { issues: [{ path: [], message: 'expected number[]' }] } },
    }

    expect(await controller.validateBody(numberArray)).toEqual([1, 2, 3])
    expect(await controller.input('title')).toBeUndefined()
  })

  // `null` is the shape worth naming: a parsed body, not an absent one, so
  // coalescing it to `{}` hands validation something nobody sent.
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
    // Both parsers are covered: JSON by its own catch, form data by the
    // controller's.
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
    // Mirrors the escaping the controller applies.
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
 * controller test passes on behavior production does not have. Each case runs
 * one body through both.
 *
 * The rule is Hono's: `parseBody()` collects every value only for a
 * `[]`-suffixed key, and `parseRequestPayload` then flattens with
 * `Array.isArray(v) ? v[0] : v` — so `tags[]` yields the FIRST value and a plain
 * repeated `tags` the LAST. Both keys are asserted, since a `tags[]`-only test
 * also passes under a blanket first-wins mock.
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
   * materializes it with `Object.fromEntries`. Assigning into an object literal
   * hits the inherited setter and drops the field silently.
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
 * The mock and the runtime must hand a validation schema the same query data, or
 * a controller test passes on behavior production does not have.
 *
 * The runtime validates against `flattenRequestQueries`, which returns
 * `values.length === 1 ? values[0] : values`, so a repeated key arrives as an
 * ARRAY and a single occurrence as a string. The probe is
 * `validateQuery`/`validateQuerySafe` specifically: `input()` takes the keyed
 * `query(key)` form on both sides and could never fail here. The identity schema
 * lets a wrong shape be compared rather than throwing 422, and both keys are
 * asserted, since a repeated-only case passes under a mock that arrays every
 * value.
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

  async function readThroughRuntime(url: string = URL_UNDER_TEST): Promise<BothSurfaces> {
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

    const response = await app.fetch(new Request(url))
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

  /**
   * The same `__proto__` key as the raw-surface test below, carried through
   * `validateQuery()` — the surface an application uses, and the one the
   * flattening sits on. Reading the raw `queries()` shows nothing here: Hono
   * hands the key over intact and only the flattening loses it.
   */
  it('validateQuery() keeps a __proto__ key in the mock and the runtime alike', async () => {
    const url = 'http://example.com/posts?__proto__=one&__proto__=two&page=2'

    const fromRuntime = await readThroughRuntime(url)
    const fromMock = readThroughMock(
      createControllerContext(url) as unknown as ControllerContext
    )

    const expected = Object.fromEntries([
      ['__proto__', ['one', 'two']],
      ['page', '2'],
    ])

    expect(Object.hasOwn(fromMock.validateQuery as object, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(fromMock.validateQuery as object)).toBe(Object.prototype)
    expect(fromMock).toEqual({ validateQuery: expected, validateQuerySafe: expected })
    expect(fromMock).toEqual(fromRuntime)
  })

  it('honors a queries() override that reads `this`', () => {
    // An override may legitimately read `this.url`, so the receiver has to
    // survive: passing the bare `ctx.req.queries` reference re-`this`es it.
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
   * A `__proto__` query key: a record built by assignment (`first[name] ??=
   * value`) hits `Object.prototype`'s inherited setter and the field vanishes,
   * where Hono's null-prototype object has no setter to hit. `queries()` is
   * asserted alongside so the pair cannot drift apart the other way.
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

    // Asserted concretely as well as for parity: `toEqual` alone would pass if
    // both sides dropped the key. The expectations use `Object.fromEntries`,
    // never an object literal, where a bare `__proto__:` key sets the prototype
    // instead of defining an own property — the footgun under test.
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
 * - JSON is a case-sensitive substring test (`contentType.includes(...)`), so
 *   `application/json-evil` is read as JSON while `Application/JSON` is not.
 * - Everything else falls through to `ctx.req.parseBody()`, which compares the
 *   media type — up to the first `;`, trimmed and lowercased — with `===`, so
 *   `Application/X-WWW-Form-Urlencoded` parses and a `-evil` suffix does not.
 *
 * A substring test on the form branches diverges in both directions at once, so
 * both are asserted, concretely as well as for parity.
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
   * The same rule on the module's `parseRequestPayload`: a route contract's
   * `body` and `validateRequest()` reach the body through that export and never
   * touch a Controller instance.
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
   * `file()` reads the multipart body through a separate gate on each side, so
   * the media-type rule has to hold there too.
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
   * An unreadable body must reach the field helpers as `{}`, not as a throw;
   * both sides swallow it in `parseRequestBody`, so every caller inherits the
   * fallback. Both encodings are here because they fail differently: malformed
   * JSON in the JSON branch's own catch, a boundary-less multipart body in the
   * catch wrapping the whole function.
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
 * The runtime-versus-mock table for request bodies: every row runs one request
 * through a real `Application.fetch()` controller and a mocked one, which must
 * answer the same thing. The suites either side exercise each implementation
 * alone, and a test can only catch a disagreement it puts side by side.
 *
 * The axes the rows cover: **case** (Hono lowercases the media type before
 * deciding), **parameters** (Hono compares against `contentType.split(';')[0]`,
 * so a `;`-parameterized type is the form type while one merely mentioning it in
 * a parameter is not), and **repeated fields** (Hono arrays only keys ending in
 * `[]`, other repeats are last-wins, and the runtime then takes `value[0]`).
 *
 * Two expectations look wrong and are not. `APPLICATION/JSON` reads as `{}` on
 * BOTH sides: the JSON branch is a case-sensitive substring test on the raw
 * header, so an uppercase one misses it and Hono does not call it a form either.
 * `text/plain; profile=application/json` parses AS JSON for the same reason read
 * the other way, and is the one place the runtime is not Hono-normalized.
 */
describe('request body parity', () => {
  const URL_UNDER_TEST = 'http://example.com/parity'
  const UPLOADS_URL_UNDER_TEST = 'http://example.com/uploads'
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

  /** Narrowed to the two fields it reads, so `readMultipart()` cases below can
   * call it without padding out a whole row. */
  function initFor(testCase: Pick<BodyCase, 'contentType' | 'body'>): RequestInit {
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
   * mock resolves @guren/server on demand, so a suite that mocks it still gets
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

      // Files cannot survive the JSON hop back, so the route answers with what
      // the rows compare: which names `file()` and `files()` selected.
      class UploadController extends Controller {
        async read() {
          // The fallback exists only because `query()` is typed as optional.
          const field = this.ctx.req.query('field') ?? ''
          return this.json({
            file: (await this.file(field))?.name ?? null,
            files: (await this.files(field)).map((upload) => upload.name),
          })
        }
      }

      const app = createApp({
        routes: (router) => {
          router.post('/parity', [ReadController, 'read'])
          router.post('/uploads', [UploadController, 'read'])
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
   * action get the same object; re-parsing hands out two, and a schema that
   * mutates what it validates then sees a different body on the second read.
   * Identity is the probe, and every row above reads each request once.
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

  /**
   * The same table for uploads, which travel a second read: `file()` and
   * `files()` do not go through the body parser at all. Both sides call the
   * runtime's `parseRequestUploads` — `parseBody({ all: true })` in a try/catch,
   * with no media-type gate.
   *
   * What these rows guard is `{ all: true }`: drop it and the repeated plain
   * field and the leading empty upload go red. The `doc[]` row does not, since
   * Hono arrays a `[]`-suffixed key either way.
   *
   * What they cannot catch is the mock reading uploads the old way. Measured:
   * `Request.formData()`'s answer for `MULTIPART/FORM-DATA` depends on the host
   * — Bun 1.3.14 rejects it, Bun 1.4.0 accepts it, Node always accepted it — and
   * Vitest runs this suite on Node, so the uppercase row states a contract it
   * cannot enforce here. The assertion that *can* fail on that axis lives in
   * `packages/server/tests/http/request.test.ts`, which runs on Bun, and the two
   * cases after this table observe `readMultipart()`'s shape directly.
   */
  interface UploadCase {
    name: string
    contentType: string
    body: BodyInit
    /** The field `file()` / `files()` read. Required, so it is stated once. */
    field: string
    expected: { file: string | null; files: string[] }
  }

  const UPLOAD_CASES: UploadCase[] = [
    {
      name: 'a single uploaded file',
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [['doc', 'a', 'a.txt']]),
      field: 'doc',
      expected: { file: 'a.txt', files: ['a.txt'] },
    },
    {
      name: 'an uppercase multipart media type carrying a file',
      contentType: `MULTIPART/FORM-DATA; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [['doc', 'a', 'a.txt']]),
      field: 'doc',
      expected: { file: 'a.txt', files: ['a.txt'] },
    },
    {
      // `{ all: true }` arrays every repeated key, not only the `[]` ones.
      name: 'a repeated file field, which files() sees every part of',
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [
        ['doc', 'a', 'a.txt'],
        ['doc', 'b', 'b.txt'],
      ]),
      field: 'doc',
      expected: { file: 'a.txt', files: ['a.txt', 'b.txt'] },
    },
    {
      name: 'a repeated file field[], which files() sees every part of',
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [
        ['doc[]', 'a', 'a.txt'],
        ['doc[]', 'b', 'b.txt'],
      ]),
      field: 'doc[]',
      expected: { file: 'a.txt', files: ['a.txt', 'b.txt'] },
    },
    {
      // file() takes the FIRST part and then requires it to be non-empty, so a
      // leading empty upload is `null` rather than "skip to the next one".
      name: 'a leading empty upload, which file() refuses and files() skips',
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [
        ['doc', '', 'empty.txt'],
        ['doc', 'b', 'b.txt'],
      ]),
      field: 'doc',
      expected: { file: null, files: ['b.txt'] },
    },
    {
      // The field parses on both sides; it is simply not a file. This is the
      // row that shows why dropping the mock's media-type gate is safe.
      name: 'a multipart text field, which is not an upload',
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: multipartBody(BOUNDARY, [['doc', 'Guren']]),
      field: 'doc',
      expected: { file: null, files: [] },
    },
    {
      // Same point on the other encoding: the shared read parses it happily
      // and hands back strings, which fail `instanceof File`. The mock used to
      // reach the same answer by refusing to parse it at all.
      name: 'a urlencoded body, which carries no uploads',
      contentType: 'application/x-www-form-urlencoded',
      body: 'doc=Guren',
      field: 'doc',
      expected: { file: null, files: [] },
    },
    {
      name: 'a multipart body with no boundary, which carries no uploads',
      contentType: 'multipart/form-data',
      body: 'not a multipart body',
      field: 'doc',
      expected: { file: null, files: [] },
    },
  ]

  async function readUploadsThroughMock(testCase: UploadCase) {
    const { Controller } = createControllerModuleMock()

    class UploadController extends Controller {
      async read() {
        return {
          file: (await this.file(testCase.field))?.name ?? null,
          files: (await this.files(testCase.field)).map((upload) => upload.name),
        }
      }
    }

    const controller = new UploadController()
    controller.setContext(
      createControllerContext(
        UPLOADS_URL_UNDER_TEST,
        initFor(testCase),
      ) as unknown as ControllerContext,
    )

    return controller.read()
  }

  async function readUploadsThroughRuntime(testCase: UploadCase) {
    const app = await bootRuntime()
    const url = `${UPLOADS_URL_UNDER_TEST}?field=${encodeURIComponent(testCase.field)}`
    const response = await app.fetch(new Request(url, initFor(testCase)))

    expect(response.status).toBe(200)

    return (await response.json()) as { file: string | null; files: string[] }
  }

  /**
   * The regression test for the delegation itself, and the two cases that do not
   * need Bun: `readMultipart()` answers with the runtime's `{ all: true }` record
   * rather than a `FormData`, and has no media-type gate to answer `null` from.
   * Read directly, deliberately — going through `file()` observes an answer both
   * implementations agree on.
   */
  function mockControllerAt(contentType: string, body: BodyInit) {
    const { Controller } = createControllerModuleMock()
    const controller = new Controller()
    controller.setContext(
      createControllerContext(
        UPLOADS_URL_UNDER_TEST,
        initFor({ contentType, body }),
      ) as unknown as ControllerContext,
    )
    return controller
  }

  it('reads uploads as the runtime record rather than as FormData', async () => {
    const controller = mockControllerAt(
      `multipart/form-data; boundary=${BOUNDARY}`,
      multipartBody(BOUNDARY, [['doc', 'a', 'a.txt']]),
    )

    const uploads = await controller.readMultipart()

    expect(uploads).not.toBeInstanceOf(FormData)
    expect(uploads.doc).toBeInstanceOf(File)
    expect((uploads.doc as File).name).toBe('a.txt')
  })

  it('has no media-type gate, so a non-multipart body reads as its fields', async () => {
    const controller = mockControllerAt('application/x-www-form-urlencoded', 'doc=Guren')

    // With no gate, the shared read parses the body and hands back its fields;
    // `file()` still says null, because a string is not a File.
    expect(await controller.readMultipart()).toEqual({ doc: 'Guren' })
    expect(await controller.file('doc')).toBeNull()
  })

  it.each(UPLOAD_CASES)('agrees on uploads for $name', async (testCase) => {
    const fromRuntime = await readUploadsThroughRuntime(testCase)
    expect(fromRuntime).toEqual(testCase.expected)

    expect(await readUploadsThroughMock(testCase)).toEqual(fromRuntime)
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
