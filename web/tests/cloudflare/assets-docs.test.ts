/**
 * The docs asset layout against the Workers asset worker Miniflare embeds: the
 * same router, `_headers` parser and binding a deploy runs. Opt-in, like the
 * plugin's own miniflare tests: workerd is a native binary, so this is gated
 * behind GUREN_TEST_WRANGLER=1 and skipped in CI.
 *
 *   GUREN_TEST_WRANGLER=1 bun test tests/cloudflare
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Miniflare } from 'miniflare'

import { docFragmentPath, docMarkdownPath, LLMS_FULL_PATH } from '../../app/Services/docs-manifest.js'

const enabled = process.env.GUREN_TEST_WRANGLER === '1'

const webRoot = resolve(import.meta.dirname, '../..')

let assetsDir: string | undefined
let mf: Miniflare | undefined

afterAll(async () => {
  await mf?.dispose()
  if (assetsDir) {
    rmSync(assetsDir, { recursive: true, force: true })
  }
})

function stage(publicPath: string, content: string): void {
  const file = join(assetsDir!, publicPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/**
 * A worker that answers `/via/<path>` by reading `<path>` through the binding
 * and reporting what it got, and lets everything else fall through to the
 * asset router. `has_user_worker` is required for binding reads to resolve in
 * Miniflare; without it every one is a 404 (measured).
 */
async function serve(): Promise<Miniflare> {
  assetsDir = mkdtempSync(join(tmpdir(), 'guren-web-assets-'))
  stage(docFragmentPath('en', 'guides', 'routing'), JSON.stringify({ title: 'Routing', html: '<h1>Routing</h1>' }))
  stage(docMarkdownPath('en', 'guides', 'routing'), '# Routing\n')
  stage(docMarkdownPath('ja', 'guides', 'routing'), '# ルーティング\n')
  stage(LLMS_FULL_PATH, '# Guren — Full Documentation\n')
  copyFileSync(resolve(webRoot, 'public/_headers'), join(assetsDir, '_headers'))

  const { Miniflare } = await import('miniflare')
  return new Miniflare({
    modules: true,
    script: `export default { async fetch(request, env) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/via/')) return new Response('worker', { status: 404 })
      const upstream = await env.ASSETS.fetch('https://assets.local' + url.pathname.slice(4))
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { 'x-upstream-type': upstream.headers.get('content-type') ?? '' },
      })
    } }`,
    assets: {
      directory: assetsDir,
      binding: 'ASSETS',
      assetConfig: { html_handling: 'none' },
      routerConfig: { has_user_worker: true },
    },
    compatibilityDate: '2026-01-01',
  })
}

/** Miniflare answers with undici's Response, whose Headers is not Bun's; only `get` is needed. */
interface HeadersLike {
  get(name: string): string | null
}

async function get(path: string): Promise<{ status: number; body: string; headers: HeadersLike }> {
  const response = await mf!.dispatchFetch(`http://localhost${path}`)
  return { status: response.status, body: await response.text(), headers: response.headers }
}

describe.skipIf(!enabled)('docs under Workers Static Assets', () => {
  beforeAll(async () => {
    mf = await serve()
  })

  test('should serve the markdown at the docs URL before the worker, as markdown', async () => {
    for (const path of [docMarkdownPath('en', 'guides', 'routing'), docMarkdownPath('ja', 'guides', 'routing')]) {
      const { status, body, headers } = await get(path)
      expect(status).toBe(200)
      expect(body).toContain('# ')
      expect(headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      expect(headers.get('cache-control')).toBe('public, max-age=3600')
    }
  })

  test('should keep fragments out of search engines and cacheable', async () => {
    const { status, headers } = await get(docFragmentPath('en', 'guides', 'routing'))
    expect(status).toBe(200)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-robots-tag')).toBe('noindex')
    expect(headers.get('cache-control')).toBe('public, max-age=3600')
  })

  test('should serve llms-full.txt statically', async () => {
    const { status, body, headers } = await get(LLMS_FULL_PATH)
    expect(status).toBe(200)
    expect(body).toBe('# Guren — Full Documentation\n')
    expect(headers.get('cache-control')).toBe('public, max-age=3600')
  })

  test('should let a missing path fall through to the worker', async () => {
    const { status, body } = await get(docMarkdownPath('en', 'guides', 'retired'))
    expect(status).toBe(404)
    expect(body).toBe('worker')
  })

  test('should resolve a fragment through the binding and report a missing one as 404', async () => {
    const found = await get(`/via${docFragmentPath('en', 'guides', 'routing')}`)
    expect(found.status).toBe(200)
    expect(JSON.parse(found.body)).toEqual({ title: 'Routing', html: '<h1>Routing</h1>' })
    expect(found.headers.get('x-upstream-type')).toBe('application/json')

    const missing = await get(`/via${docFragmentPath('en', 'guides', 'retired')}`)
    expect(missing.status).toBe(404)
  })
})
