import { describe, expect, it } from 'bun:test'
import { abort, createApp, createExceptionHandler, ServiceProvider } from '../../src'

class SecretLeak extends Error {
  override name = 'SecretLeak'
}

/**
 * Driven through `createApp()` and `app.fetch()`, so the error travels the path
 * a real one does: thrown in a handler, caught by Hono's compose, and handed to
 * the `onError` that `ErrorServiceProvider` installs.
 */
async function appWithDebug(debug: boolean) {
  class DebugProvider extends ServiceProvider {
    register(): void {
      this.container.instance('exception.handler', createExceptionHandler({ debug }))
    }
  }

  const app = createApp({
    routes: (router) => {
      router.get('/boom', () => {
        throw new SecretLeak('<b>disk</b> full')
      })
      router.get('/missing', () => abort(404, 'No such post'))
      router.get('/unavailable', () => abort(503, 'Down for maintenance'))
    },
    providers: [DebugProvider],
  })
  await app.boot()
  return app
}

function get(path: string, headers: Record<string, string>): Request {
  return new Request(`http://example.com${path}`, { headers })
}

const BROWSER = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }

describe('ExceptionHandler pages in a booted app', () => {
  it('renders the debug page for a browser request while debug details are on', async () => {
    const app = await appWithDebug(true)

    const response = await app.fetch(get('/boom', BROWSER))
    const html = await response.text()

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('Debug Error Page')
    expect(html).toContain('<h1 class="error-class">SecretLeak</h1>')
    expect(html).toContain('&lt;b&gt;disk&lt;/b&gt; full')
    expect(html).toContain('<h2>Stack Trace</h2>')
  })

  it('redacts the session cookie and credentials on the debug page', async () => {
    const app = await appWithDebug(true)

    const response = await app.fetch(get('/boom', {
      ...BROWSER,
      Cookie: 'guren_session=s3cr3t-session',
      Authorization: 'Bearer s3cr3t-token',
      'User-Agent': 'probe/1.0',
    }))
    const html = await response.text()

    expect(response.status).toBe(500)
    expect(html).toContain('<h2>Request</h2>')
    expect(html).not.toContain('s3cr3t')
    expect(html).toContain('<tr><td class="key">cookie</td><td class="value">[redacted]</td></tr>')
    expect(html).toContain('<tr><td class="key">authorization</td><td class="value">[redacted]</td></tr>')
    expect(html).toContain('<tr><td class="key">user-agent</td><td class="value">probe/1.0</td></tr>')
  })

  it('renders the debug page for a 5xx HttpException', async () => {
    const app = await appWithDebug(true)

    const response = await app.fetch(get('/unavailable', BROWSER))

    expect(response.status).toBe(503)
    expect(await response.text()).toContain('Debug Error Page')
  })

  it('renders the plain error page for a 4xx even while debug details are on', async () => {
    const app = await appWithDebug(true)

    const response = await app.fetch(get('/missing', BROWSER))
    const html = await response.text()

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('No such post')
    expect(html).not.toContain('Debug Error Page')
  })

  it('keeps the JSON body with exception and stack for a JSON caller', async () => {
    const app = await appWithDebug(true)

    const response = await app.fetch(get('/boom', { Accept: 'application/json' }))
    const body = await response.json() as { message: string; exception?: string; stack?: string }

    expect(response.status).toBe(500)
    expect(body.message).toBe('<b>disk</b> full')
    expect(body.exception).toBe('SecretLeak')
    expect(body.stack).toContain('SecretLeak')
  })

  it('keeps JSON for an Inertia visit and an XHR, whatever they accept', async () => {
    const app = await appWithDebug(true)

    for (const headers of [
      { ...BROWSER, 'X-Inertia': 'true' },
      { ...BROWSER, 'X-Requested-With': 'XMLHttpRequest' },
    ]) {
      const response = await app.fetch(get('/boom', headers))
      expect(response.headers.get('content-type')).toContain('application/json')
      expect((await response.json() as { exception?: string }).exception).toBe('SecretLeak')
    }
  })

  it('renders the generic error page with no details when debug details are off', async () => {
    const app = await appWithDebug(false)

    const response = await app.fetch(get('/boom', BROWSER))
    const html = await response.text()

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).not.toContain('Debug Error Page')
    expect(html).not.toContain('SecretLeak')
    expect(html).not.toContain('disk')
  })
})
