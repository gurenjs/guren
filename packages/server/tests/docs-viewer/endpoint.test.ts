import { describe, test, expect, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Application } from '../../src'
import {
  createDocsViewerAccessGuard,
  DOCS_VIEWER_PATH,
  isDocsViewerEnabled,
} from '../../src/docs-viewer/endpoint'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('DOCS_VIEWER_PATH', () => {
  test('lives in the framework namespace next to the MCP endpoint', () => {
    expect(DOCS_VIEWER_PATH).toBe('/_guren/docs')
  })
})

describe('isDocsViewerEnabled', () => {
  test('is enabled only with GUREN_DOCS=1 outside production', () => {
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DOCS = '1'
    expect(isDocsViewerEnabled()).toBe(true)
  })

  test('is disabled without the opt-in flag', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.GUREN_DOCS
    expect(isDocsViewerEnabled()).toBe(false)

    process.env.GUREN_DOCS = '0'
    expect(isDocsViewerEnabled()).toBe(false)
  })

  test('is disabled in production even with the opt-in flag', () => {
    process.env.NODE_ENV = 'production'
    process.env.GUREN_DOCS = '1'
    expect(isDocsViewerEnabled()).toBe(false)
  })
})

describe('createDocsViewerAccessGuard', () => {
  function guardedApp(): Hono {
    const app = new Hono()
    app.use('*', createDocsViewerAccessGuard())
    app.get('/', (ctx) => ctx.text('ok'))
    return app
  }

  test('allows requests without an Origin header', async () => {
    const response = await guardedApp().request('/')
    expect(response.status).toBe(200)
  })

  test('allows loopback origins and rejects everything else', async () => {
    const app = guardedApp()

    const local = await app.request('/', { headers: { origin: 'http://localhost:3333' } })
    expect(local.status).toBe(200)

    const remote = await app.request('/', { headers: { origin: 'https://evil.example' } })
    expect(remote.status).toBe(403)
    expect((await remote.json()).message).toContain('the docs viewer')
  })
})

describe('docs viewer integration', () => {
  const originalCwd = process.cwd()
  let dir: string | null = null

  afterEach(async () => {
    process.chdir(originalCwd)
    if (dir) {
      await rm(dir, { recursive: true, force: true })
      dir = null
    }
  })

  async function bootWorkspaceApp(): Promise<Application> {
    dir = await mkdtemp(join(tmpdir(), 'guren-docs-viewer-'))
    await mkdir(join(dir, 'docs/adr'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    await writeFile(
      join(dir, 'docs/adr/0001-first.md'),
      '---\ntype: adr\n---\n\n# First decision\n\nBody.\n',
      'utf8',
    )
    process.chdir(dir)

    const app = new Application()
    await app.boot()
    return app
  }

  test('serves the UI shell and the bundle payload when enabled', async () => {
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DOCS = '1'
    const app = await bootWorkspaceApp()

    const page = await app.fetch(new Request(`http://localhost${DOCS_VIEWER_PATH}`))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('docs graph')

    const data = await app.fetch(new Request(`http://localhost${DOCS_VIEWER_PATH}/data.json`))
    expect(data.status).toBe(200)
    const payload = await data.json()
    expect(payload.docs).toHaveLength(1)
    expect(payload.docs[0].path).toBe('docs/adr/0001-first.md')
    expect(payload.nodes[0].kind).toBe('doc')

    // Freshness: the ETag answers a conditional request with 304
    const etag = data.headers.get('etag')
    expect(etag).not.toBeNull()
    const conditional = await app.fetch(
      new Request(`http://localhost${DOCS_VIEWER_PATH}/data.json`, {
        headers: { 'if-none-match': etag! },
      }),
    )
    expect(conditional.status).toBe(304)
  })

  test('rejects cross-origin requests to the mounted endpoint', async () => {
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DOCS = '1'
    const app = await bootWorkspaceApp()

    const response = await app.fetch(
      new Request(`http://localhost${DOCS_VIEWER_PATH}/data.json`, {
        headers: { origin: 'https://evil.example' },
      }),
    )
    expect(response.status).toBe(403)
  })

  test('does not mount without the opt-in flag', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.GUREN_DOCS
    const app = await bootWorkspaceApp()

    const response = await app.fetch(new Request(`http://localhost${DOCS_VIEWER_PATH}`))
    expect(response.status).toBe(404)
  })
})
