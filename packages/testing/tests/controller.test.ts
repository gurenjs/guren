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

  const identitySchema = {
    safeParse: (data: unknown) => ({ success: true as const, data }),
  }

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

  it('reads back the first occurrence from the mock context, as Hono does', () => {
    const ctx = createControllerContext(URL_UNDER_TEST)

    expect(ctx.req.query()).toEqual({ tag: 'core', page: '2' })
    expect(ctx.req.query('tag')).toBe('core')
  })
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

  /** Passes anything through, so a divergence shows up as a shape rather than a 422. */
  const identitySchema = {
    safeParse: (data: unknown) => ({ success: true as const, data }),
  }

  /**
   * Hand-built rather than `new FormData()`: `fetch` picks the boundary and
   * the exact media-type casing for a FormData body, and the casing is one of
   * the things under test here.
   */
  function multipartBody(fields: Array<[string, string]>): string {
    const parts = fields.map(
      ([name, value]) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )

    return `${parts.join('')}--${BOUNDARY}--\r\n`
  }

  interface BodyCase {
    name: string
    /** Left unset only by the "no content type" row, which asserts its absence. */
    contentType?: string
    body?: BodyInit
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
      body: multipartBody([['title', 'Guren']]),
      expected: { title: 'Guren' },
    },
    {
      name: 'an uppercase multipart media type',
      contentType: `MULTIPART/FORM-DATA; boundary=${BOUNDARY}`,
      body: multipartBody([['title', 'Guren']]),
      expected: { title: 'Guren' },
    },
    {
      name: 'a repeated multipart field[], which keeps the first value',
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: multipartBody([
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
