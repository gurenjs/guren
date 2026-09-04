import { describe, test, expect, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  test('reads the environment in the form the deploy bundlers substitute', async () => {
    // The deploy plugins' `--define 'process.env.NODE_ENV="production"'` substitutes that one
    // exact expression, and an optional chain is a different one. Only the source can pin it.
    const source = await readFile(
      join(import.meta.dir, '../../src/docs-viewer/endpoint.ts'),
      'utf8',
    )

    expect(source).toContain('process.env.NODE_ENV')
    expect(source).not.toContain('process.env?.')
  })
})

describe('createDocsViewerAccessGuard', () => {
  function guardedApp(): Hono {
    const app = new Hono()
    app.use('*', createDocsViewerAccessGuard())
    app.get('/', (ctx) => ctx.text('ok'))
    return app
  }

  /** Stands in for the `{ server }` env Bun.serve passes through Hono. */
  function bunEnv(address: string) {
    return { server: { requestIP: () => ({ address }) } }
  }

  test('allows a request from a loopback peer with no Origin header', async () => {
    const response = await guardedApp().request('/', {}, bunEnv('127.0.0.1'))
    expect(response.status).toBe(200)
  })

  test('allows loopback origins and rejects everything else', async () => {
    const app = guardedApp()

    const local = await app.request(
      '/',
      { headers: { origin: 'http://localhost:3333' } },
      bunEnv('127.0.0.1'),
    )
    expect(local.status).toBe(200)

    const remote = await app.request(
      '/',
      { headers: { origin: 'https://evil.example' } },
      bunEnv('127.0.0.1'),
    )
    expect(remote.status).toBe(403)
    expect((await remote.json()).message).toContain('the docs viewer')
  })

  test('rejects a request whose peer the runtime cannot report', async () => {
    delete process.env.GUREN_ALLOW_UNVERIFIED_PEER

    const response = await guardedApp().request('/')

    expect(response.status).toBe(403)
    const { message } = await response.json()
    expect(message).toContain('the docs viewer')
    expect(message).toContain('GUREN_ALLOW_UNVERIFIED_PEER=1')
  })

  test('serves a peer-less request once the operator opts out', async () => {
    process.env.GUREN_ALLOW_UNVERIFIED_PEER = '1'

    const response = await guardedApp().request('/')
    expect(response.status).toBe(200)
  })
})

describe('docs viewer integration', () => {
  const originalCwd = process.cwd()
  let dir: string | null = null

  // `Application.listen()` always threads a peer address through; in-process `app.fetch()`
  // calls must supply one themselves, since the guard denies an unverified peer.
  const loopbackEnv = { server: { requestIP: () => ({ address: '127.0.0.1' }) } }

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

    const page = await app.fetch(new Request(`http://localhost${DOCS_VIEWER_PATH}`), loopbackEnv)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('docs graph')

    const data = await app.fetch(
      new Request(`http://localhost${DOCS_VIEWER_PATH}/data.json`),
      loopbackEnv,
    )
    expect(data.status).toBe(200)
    const payload = await data.json()
    expect(payload.docs).toHaveLength(1)
    expect(payload.docs[0].path).toBe('docs/adr/0001-first.md')
    expect(payload.nodes[0].kind).toBe('doc')

    const etag = data.headers.get('etag')
    expect(etag).not.toBeNull()
    const conditional = await app.fetch(
      new Request(`http://localhost${DOCS_VIEWER_PATH}/data.json`, {
        headers: { 'if-none-match': etag! },
      }),
      loopbackEnv,
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
      loopbackEnv,
    )
    expect(response.status).toBe(403)
  })

  test('rejects a mounted-endpoint request the runtime cannot place', async () => {
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DOCS = '1'
    delete process.env.GUREN_ALLOW_UNVERIFIED_PEER
    const app = await bootWorkspaceApp()

    // No env, so no peer address: the shape a host calling `app.fetch()` itself produces.
    const response = await app.fetch(
      new Request(`http://localhost${DOCS_VIEWER_PATH}/data.json`),
    )

    expect(response.status).toBe(403)
    expect((await response.json()).message).toContain('GUREN_ALLOW_UNVERIFIED_PEER=1')
  })

  test('does not mount without the opt-in flag', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.GUREN_DOCS
    const app = await bootWorkspaceApp()

    const response = await app.fetch(new Request(`http://localhost${DOCS_VIEWER_PATH}`))
    expect(response.status).toBe(404)
  })
})
