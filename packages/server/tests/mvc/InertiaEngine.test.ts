import { describe, expect, it } from 'bun:test'
import { inertia } from '../../src'

describe('InertiaEngine SSR integration', () => {
  it('renders client-side shell when no SSR renderer is configured', async () => {
    const response = await inertia('Dashboard', { stats: { users: 2 } }, { url: '/dashboard' })
    const body = await response.text()

    expect(body).toContain('id="app"')
    expect(body).toContain('data-page=')
    expect(body).not.toContain('<title>SSR Title</title>')
  })


  it('adds docs body class for docs pages', async () => {
    const response = await inertia('Docs/Show', { categories: [] }, { url: '/docs/guides/overview' })
    const body = await response.text()

    expect(body).toContain('<body class="docs-theme">')
  })


  it('injects docs prepaint critical style and script', async () => {
    const response = await inertia('Docs/Show', { categories: [] }, { url: '/docs/guides/overview' })
    const body = await response.text()

    expect(body).toContain('id="guren-docs-critical"')
    expect(body).toContain("localStorage.getItem('guren-color-mode')")
    expect(body).toContain("prefers-color-scheme: dark")
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
