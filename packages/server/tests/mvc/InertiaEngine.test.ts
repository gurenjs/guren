import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { inertia, setInertiaDocument, setInertiaSsrRenderer } from '../../src'

describe('InertiaEngine SSR integration', () => {
  afterEach(() => {
    setInertiaDocument(undefined)
  })

  it('renders client-side shell when no SSR renderer is configured', async () => {
    const response = await inertia('Dashboard', { stats: { users: 2 } }, { url: '/dashboard' })
    const body = await response.text()

    expect(body).toContain('id="app"')
    expect(body).toContain('data-page=')
    expect(body).not.toContain('<title>SSR Title</title>')
  })


  // The payload is the largest thing in a docs document: a second serialized
  // copy measured at a third of the gzipped response (RFC 0014).
  describe('page payload', () => {
    const SHIM = /<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/u
    const ELEMENT = '<script data-page="app" type="application/json">'

    async function render(ssrBody?: string): Promise<string> {
      const response = await inertia('Dashboard', { stats: { users: 2 } }, {
        url: '/dashboard',
        ...(ssrBody === undefined ? {} : { ssr: { render: async () => ({ head: [], body: ssrBody }) } }),
      })
      return response.text()
    }

    it('serializes the payload once, into the element, and defines the global from it', async () => {
      const body = await render()

      expect(body.split('"users":2').length - 1).toBe(1)
      expect(body).not.toContain('window.__INERTIA_PAGE__ = ')
      expect(body).toContain(ELEMENT)
      // The shim sits after the element and before the module entry, in document order.
      const shimAt = body.search(SHIM)
      expect(shimAt).toBeGreaterThan(body.indexOf(ELEMENT))
      expect(shimAt).toBeLessThan(body.indexOf('<script type="module"'))
    })

    it('uses an SSR body as is when it carries the payload element', async () => {
      const body = await render(`${ELEMENT}{"component":"Dashboard","props":{"stats":{"users":2}}}</script><div id="app">SSR</div>`)

      expect(body.split(ELEMENT).length - 1).toBe(1)
      expect(body.split('"users":2').length - 1).toBe(1)
    })

    it('uses an SSR body as is when it carries the legacy attribute on the container', async () => {
      const body = await render('<div data-ssr="true" id="app" data-page="{&quot;component&quot;:&quot;Dashboard&quot;}">SSR</div>')

      expect(body).not.toContain(ELEMENT)
      expect(body).toMatch(SHIM)
    })

    it('appends the payload element to a custom SSR body that carries none', async () => {
      const body = await render('<div id="app">SSR</div>')

      expect(body).toContain(`SSR</div>${ELEMENT}{"component":"Dashboard"`)
      expect(body.split('"users":2').length - 1).toBe(1)
    })

    // A substring test would take these for the element and leave nothing to hydrate.
    it('is not fooled by data-page mentioned in prose or set on another element', async () => {
      for (const decoy of [
        '<div id="app"><code>&lt;div id="app" data-page="..."&gt;</code></div>',
        '<div id="app"><button data-page="2">next</button></div>',
        '<div id="root" data-page="{&quot;component&quot;:&quot;X&quot;}">SSR</div>',
      ]) {
        expect(await render(decoy)).toContain(ELEMENT)
      }
    })

    // The shim is JavaScript the tests would otherwise never run: it is executed
    // here against a stub document for each element shape the client accepts.
    describe('the inline global shim', () => {
      type Stub = { script?: string; attribute?: string }

      async function runShim(stub: Stub): Promise<{ page: unknown; selector: string | undefined }> {
        const body = await render()
        const source = body.match(SHIM)![0].replace(/^<script>|<\/script>$/gu, '')
        const window: { __INERTIA_PAGE__?: unknown } = {}
        let selector: string | undefined
        const document = {
          querySelector(query: string) {
            selector = query
            return stub.script === undefined ? null : { tagName: 'SCRIPT', textContent: stub.script }
          },
          getElementById() {
            return stub.attribute === undefined
              ? null
              : { tagName: 'DIV', getAttribute: () => stub.attribute }
          },
        }
        new Function('window', 'document', source)(window, document)
        return { page: window.__INERTIA_PAGE__, selector }
      }

      it('should define the global from the JSON script element, with the client selector', async () => {
        const { page, selector } = await runShim({ script: '{"component":"Dashboard","props":{}}' })

        expect(page).toEqual({ component: 'Dashboard', props: {} })
        expect(selector).toBe('script[data-page="app"][type="application/json"]')
      })

      it('should define the global from the legacy attribute on the container', async () => {
        const { page } = await runShim({ attribute: '{"component":"Dashboard","props":{}}' })

        expect(page).toEqual({ component: 'Dashboard', props: {} })
      })

      it('should ignore a container attribute that is not a page payload', async () => {
        expect((await runShim({ attribute: '3' })).page).toBeUndefined()
        expect((await runShim({ attribute: 'products' })).page).toBeUndefined()
        expect((await runShim({})).page).toBeUndefined()
      })
    })
  })

  it('ships a bare body and head when no document options are registered', async () => {
    const response = await inertia('Docs/Show', { categories: [] }, { url: '/docs/guides/overview' })
    const body = await response.text()

    expect(body).toContain('<body>')
    expect(body).not.toContain('id="guren-critical"')
  })

  it('applies the app-wide body class to every page component', async () => {
    setInertiaDocument({ bodyClass: 'app-theme' })

    const response = await inertia('Dashboard', {}, { url: '/dashboard' })
    const body = await response.text()

    expect(body).toContain('<body class="app-theme">')
  })

  it('resolves document options per page component', async () => {
    setInertiaDocument({
      bodyClass: ({ component }) => (component.startsWith('Docs/') ? 'docs-theme' : undefined),
    })

    const docs = await inertia('Docs/Show', { categories: [] }, { url: '/docs/guides/overview' })
    const home = await inertia('Home', {}, { url: '/' })

    expect(await docs.text()).toContain('<body class="docs-theme">')
    expect(await home.text()).toContain('<body>')
  })

  it('inlines critical CSS and the prepaint script into the head', async () => {
    setInertiaDocument({
      criticalCss: 'body{background:#ffffff;}',
      prepaintScript: "document.documentElement.classList.add('dark');",
    })

    const response = await inertia('Docs/Show', { categories: [] }, { url: '/docs/guides/overview' })
    const body = await response.text()

    expect(body).toContain('<style id="guren-critical">body{background:#ffffff;}</style>')
    expect(body).toContain("<script>document.documentElement.classList.add('dark');</script>")
  })

  it('inlines raw head markup such as favicon links', async () => {
    setInertiaDocument({
      head: '<link rel="icon" type="image/png" href="/favicon-32x32.png" />',
    })

    const response = await inertia('Docs/Show', { categories: [] }, { url: '/docs/guides/overview' })
    const body = await response.text()

    expect(body).toContain('<link rel="icon" type="image/png" href="/favicon-32x32.png" />')
  })

  it('places the critical CSS and prepaint script ahead of the stylesheet links', async () => {
    setInertiaDocument({
      criticalCss: 'body{background:#ffffff;}',
      prepaintScript: "document.documentElement.classList.add('dark');",
    })

    const response = await inertia(
      'Docs/Show',
      {},
      { url: '/docs/guides/overview', styles: ['/assets/app.css'] },
    )
    const body = await response.text()

    expect(body.indexOf('id="guren-critical"')).toBeLessThan(body.indexOf('/assets/app.css'))
    expect(body.indexOf('classList.add')).toBeLessThan(body.indexOf('/assets/app.css'))
  })

  it('treats an empty per-call override as a suppression of the app-wide default', async () => {
    setInertiaDocument({ bodyClass: 'docs-theme', criticalCss: 'body{background:#ffffff;}' })

    const response = await inertia(
      'Docs/Show',
      {},
      { url: '/docs/guides/overview', bodyClass: '', criticalCss: '' },
    )
    const body = await response.text()

    expect(body).toContain('<body>')
    expect(body).not.toContain('id="guren-critical"')
  })

  it('lets per-call options override the app-wide document defaults', async () => {
    setInertiaDocument({ bodyClass: 'docs-theme', criticalCss: 'body{background:#ffffff;}' })

    const response = await inertia(
      'Docs/Show',
      { categories: [] },
      { url: '/docs/guides/overview', bodyClass: 'print-theme', criticalCss: 'body{background:#000000;}' },
    )
    const body = await response.text()

    expect(body).toContain('<body class="print-theme">')
    expect(body).toContain('<style id="guren-critical">body{background:#000000;}</style>')
  })

  it('utilizes provided SSR renderer when available', async () => {
    const response = await inertia(
      'Dashboard',
      { stats: { users: 2 } },
      {
        url: '/dashboard',
        ssr: {
          render: async () => ({
            head: ['<title>SSR Title</title>'],
            body: '<div id="app" data-page="{&quot;component&quot;:&quot;Dashboard&quot;}" data-ssr="true">SSR</div>',
          }),
        },
      },
    )

    const body = await response.text()

    expect(body).toContain('<title>SSR Title</title>')
    expect(body).toContain('data-ssr="true"')
    expect(body).toContain('SSR')
  })

  it('uses the process-wide default renderer registered via setInertiaSsrRenderer', async () => {
    setInertiaSsrRenderer(async () => ({
      head: ['<title>Default SSR</title>'],
      body: '<div id="app" data-ssr="default">Default</div>',
    }))

    try {
      const response = await inertia('Dashboard', {}, { url: '/dashboard' })
      const body = await response.text()

      expect(body).toContain('<title>Default SSR</title>')
      expect(body).toContain('data-ssr="default"')
    } finally {
      setInertiaSsrRenderer(undefined)
    }
  })

  it('prefers per-call ssr.render over the default renderer', async () => {
    setInertiaSsrRenderer(async () => ({
      head: ['<title>Default SSR</title>'],
      body: '<div id="app" data-ssr="default">Default</div>',
    }))

    try {
      const response = await inertia(
        'Dashboard',
        {},
        {
          url: '/dashboard',
          ssr: {
            render: async () => ({
              head: ['<title>Per-call SSR</title>'],
              body: '<div id="app" data-ssr="per-call">PerCall</div>',
            }),
          },
        },
      )
      const body = await response.text()

      expect(body).toContain('<title>Per-call SSR</title>')
      expect(body).not.toContain('data-ssr="default"')
    } finally {
      setInertiaSsrRenderer(undefined)
    }
  })

  it('clears the default renderer when called with undefined', async () => {
    setInertiaSsrRenderer(async () => ({
      head: ['<title>Default SSR</title>'],
      body: '<div id="app" data-ssr="default">Default</div>',
    }))
    setInertiaSsrRenderer(undefined)

    const response = await inertia('Dashboard', {}, { url: '/dashboard' })
    const body = await response.text()

    expect(body).not.toContain('<title>Default SSR</title>')
  })
})

describe('Inertia import map', () => {
  it('includes the esm.sh dev fallback outside production', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'

    try {
      const response = await inertia('Dashboard', {}, { url: '/dashboard' })
      const body = await response.text()

      expect(body).toContain('type="importmap"')
      expect(body).toContain('esm.sh/react')
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }
  })

  it('omits the esm.sh dev fallback in production', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    try {
      const response = await inertia('Dashboard', {}, { url: '/dashboard' })
      const body = await response.text()

      expect(body).not.toContain('esm.sh')
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }
  })
})

describe('Inertia asset version mismatch', () => {
  const buildInertiaRequest = (
    overrides: { method?: string; version?: string | null } = {},
  ): Request =>
    new Request('http://localhost/dashboard', {
      method: overrides.method ?? 'GET',
      headers: {
        'X-Inertia': 'true',
        ...(overrides.version === null
          ? {}
          : { 'X-Inertia-Version': overrides.version ?? 'v1' }),
      },
    })

  it('returns 200 when client version matches', async () => {
    const response = await inertia(
      'Dashboard',
      {},
      {
        url: '/dashboard',
        version: 'v1',
        request: buildInertiaRequest({ version: 'v1' }),
      },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Inertia-Version')).toBe('v1')
  })

  it('returns 409 with X-Inertia-Location when GET version mismatches', async () => {
    const response = await inertia(
      'Dashboard',
      {},
      {
        url: '/dashboard',
        version: 'v1',
        request: buildInertiaRequest({ version: 'v0' }),
      },
    )
    expect(response.status).toBe(409)
    expect(response.headers.get('X-Inertia-Location')).toBe('/dashboard')
  })

  it('derives the page url from the request, keeping the query string', async () => {
    const response = await inertia(
      'Probe',
      {},
      {
        request: new Request('http://example.com/probe?from=2026-07-01&to=2026-07-28', {
          headers: { 'X-Inertia': 'true', Accept: 'application/json' },
        }),
      },
    )
    const payload = await response.json() as { url: string }

    expect(payload.url).toBe('/probe?from=2026-07-01&to=2026-07-28')
  })

  it('options.url overrides the request-derived page url', async () => {
    const response = await inertia(
      'Probe',
      {},
      {
        url: '/custom',
        request: new Request('http://example.com/probe?x=1', {
          headers: { 'X-Inertia': 'true', Accept: 'application/json' },
        }),
      },
    )
    const payload = await response.json() as { url: string }

    expect(payload.url).toBe('/custom')
  })

  it('falls back to request.url for X-Inertia-Location when options.url is absent', async () => {
    const response = await inertia(
      'Dashboard',
      {},
      {
        version: 'v1',
        request: buildInertiaRequest({ version: 'v0' }),
      },
    )
    expect(response.status).toBe(409)
    expect(response.headers.get('X-Inertia-Location')).toBe('http://localhost/dashboard')
  })

  it('returns 409 when client omits X-Inertia-Version', async () => {
    const response = await inertia(
      'Dashboard',
      {},
      {
        version: 'v1',
        request: buildInertiaRequest({ version: null }),
      },
    )
    expect(response.status).toBe(409)
  })

  it('does not return 409 for non-GET requests', async () => {
    const response = await inertia(
      'Dashboard',
      {},
      {
        version: 'v1',
        request: buildInertiaRequest({ method: 'POST', version: 'v0' }),
      },
    )
    expect(response.status).not.toBe(409)
  })

  it('does not return 409 for non-Inertia requests', async () => {
    const request = new Request('http://localhost/dashboard', {
      method: 'GET',
      headers: { 'X-Inertia-Version': 'v0' },
    })
    const response = await inertia('Dashboard', {}, { version: 'v1', request })
    expect(response.status).not.toBe(409)
  })

  it('skips version check when no version is configured', async () => {
    const response = await inertia(
      'Dashboard',
      {},
      {
        request: buildInertiaRequest({ version: 'v0' }),
      },
    )
    expect(response.status).toBe(200)
  })

  it('reads GUREN_INERTIA_VERSION as fallback', async () => {
    const original = process.env.GUREN_INERTIA_VERSION
    process.env.GUREN_INERTIA_VERSION = 'env-v1'
    try {
      const response = await inertia(
        'Dashboard',
        {},
        {
          request: buildInertiaRequest({ version: 'env-v0' }),
        },
      )
      expect(response.status).toBe(409)
    } finally {
      if (original === undefined) {
        delete process.env.GUREN_INERTIA_VERSION
      } else {
        process.env.GUREN_INERTIA_VERSION = original
      }
    }
  })
})

describe('InertiaEngine dev stylesheet links', () => {
  const ENV_KEYS = ['GUREN_INERTIA_ENTRY', 'GUREN_INERTIA_STYLES', 'NODE_ENV'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    }
  })

  it('drops the dev source stylesheet when a Vite dev server owns the entry', async () => {
    // The source file's bare `@import 'tailwindcss'` 404s on every page,
    // while the compiled CSS already arrives through Vite's module graph.
    process.env.NODE_ENV = 'development'
    process.env.GUREN_INERTIA_ENTRY = 'http://localhost:5173/resources/js/dev-entry.ts'
    process.env.GUREN_INERTIA_STYLES = '/resources/css/app.css'

    const response = await inertia('Dashboard', {}, { url: '/dashboard' })
    const body = await response.text()

    expect(body).not.toContain('/resources/css/app.css')
  })

  it('keeps other env-configured stylesheets under a Vite dev server entry', async () => {
    process.env.NODE_ENV = 'development'
    process.env.GUREN_INERTIA_ENTRY = 'http://localhost:5173/resources/js/dev-entry.ts'
    process.env.GUREN_INERTIA_STYLES = '/public/custom.css,/resources/css/app.css'

    const response = await inertia('Dashboard', {}, { url: '/dashboard' })
    const body = await response.text()

    expect(body).toContain('<link rel="stylesheet" href="/public/custom.css" />')
    expect(body).not.toContain('/resources/css/app.css')
  })

  it('never filters a per-call styles override', async () => {
    // Only the ambient env-derived styles carry the fallback the filter targets.
    process.env.NODE_ENV = 'development'
    process.env.GUREN_INERTIA_ENTRY = 'http://localhost:5173/resources/js/dev-entry.ts'

    const response = await inertia(
      'Dashboard',
      {},
      { url: '/dashboard', styles: ['/resources/css/app.css'] },
    )
    const body = await response.text()

    expect(body).toContain('<link rel="stylesheet" href="/resources/css/app.css" />')
  })

  it('keeps the dev source stylesheet when the fallback pipeline serves the entry', async () => {
    process.env.NODE_ENV = 'development'
    process.env.GUREN_INERTIA_ENTRY = '/resources/js/app.tsx'
    process.env.GUREN_INERTIA_STYLES = '/resources/css/app.css'

    const response = await inertia('Dashboard', {}, { url: '/dashboard' })
    const body = await response.text()

    expect(body).toContain('<link rel="stylesheet" href="/resources/css/app.css" />')
  })

  it('leaves production stylesheet links untouched', async () => {
    process.env.NODE_ENV = 'production'
    process.env.GUREN_INERTIA_ENTRY = '/public/assets/app-abc123.js'
    process.env.GUREN_INERTIA_STYLES = '/public/assets/app-abc123.css'

    const response = await inertia('Dashboard', {}, { url: '/dashboard' })
    const body = await response.text()

    expect(body).toContain('<link rel="stylesheet" href="/public/assets/app-abc123.css" />')
  })
})
