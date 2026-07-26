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
