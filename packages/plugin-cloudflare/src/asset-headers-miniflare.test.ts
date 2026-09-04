import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Miniflare } from 'miniflare'
import { buildCloudflareOutput } from './build'

// Opt-in end-to-end test: serves a real `cloudflare:build` output through the
// asset worker Miniflare embeds, i.e. the same `_headers` parser Workers Static
// Assets run. `build.test.ts` asserts what is written; this asserts it does
// anything. Miniflare spawns workerd (a native binary), so it is gated behind
// GUREN_TEST_WRANGLER=1 and skipped in CI.
const enabled = process.env.GUREN_TEST_WRANGLER === '1'

let root: string | undefined
let mf: Miniflare | undefined

afterAll(async () => {
  await mf?.dispose()
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

function scaffoldApp(target: string): void {
  mkdirSync(join(target, 'src'), { recursive: true })
  writeFileSync(
    join(target, 'src/app.ts'),
    'export default { boot: async () => {}, fetch: async () => new Response("ok") }\n',
  )
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@acme/demo-app' }))

  mkdirSync(join(target, 'public/nested'), { recursive: true })
  writeFileSync(join(target, 'public/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n')
  writeFileSync(join(target, 'public/nested/deep.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n')
  writeFileSync(join(target, 'public/page.html'), '<h1>staged</h1>\n')
  writeFileSync(join(target, 'public/feed.xml'), '<root/>\n')
  writeFileSync(join(target, 'public/app.js'), 'console.log("client")\n')
  writeFileSync(join(target, 'public/robots.txt'), 'User-agent: *\n')
}

async function serveBuiltAssets(): Promise<Miniflare> {
  root = mkdtempSync(join(tmpdir(), 'guren-cf-headers-e2e-'))
  scaffoldApp(root)
  await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

  // Read back from the config the build just scaffolded, so what a deploy runs
  // is what produces these headers.
  const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))

  const { Miniflare } = await import('miniflare')
  return new Miniflare({
    modules: true,
    script: 'export default { async fetch(request, env) { return env.ASSETS.fetch(request) } }',
    assets: {
      directory: join(root, '.cloudflare/assets'),
      binding: 'ASSETS',
      assetConfig: { html_handling: wrangler.assets.html_handling },
    },
    compatibilityDate: '2026-01-01',
  })
}

async function head(path: string): Promise<{ status: number; disposition: string | null; nosniff: string | null }> {
  const response = await mf!.dispatchFetch(`http://localhost${path}`, { redirect: 'manual' })
  await response.arrayBuffer()
  return {
    status: response.status,
    disposition: response.headers.get('content-disposition'),
    nosniff: response.headers.get('x-content-type-options'),
  }
}

describe.skipIf(!enabled)('_headers against the Workers asset worker', () => {
  beforeAll(async () => {
    mf = await serveBuiltAssets()
  })

  test('should force a staged SVG to download, at any depth', async () => {
    expect(await head('/logo.svg')).toEqual({ status: 200, disposition: 'attachment', nosniff: 'nosniff' })
    // The splat is greedy across slashes, which is the only reason one rule
    // per extension covers the whole tree.
    expect(await head('/nested/deep.svg')).toEqual({ status: 200, disposition: 'attachment', nosniff: 'nosniff' })
  })

  test('should force a staged XML document to download', async () => {
    expect(await head('/feed.xml')).toEqual({ status: 200, disposition: 'attachment', nosniff: 'nosniff' })
  })

  test('should serve staged HTML at its own path rather than redirecting away from the rule', async () => {
    // Under the platform default this is a 307 to /page, and /page then comes
    // back inline — the rule would be present and protect nothing.
    expect(await head('/page.html')).toEqual({ status: 200, disposition: 'attachment', nosniff: 'nosniff' })
    expect((await head('/page')).status).toBe(404)
  })

  test('should leave everything else inline', async () => {
    expect(await head('/app.js')).toEqual({ status: 200, disposition: null, nosniff: null })
    expect(await head('/robots.txt')).toEqual({ status: 200, disposition: null, nosniff: null })
  })

  test('should not serve the generated _headers file itself', async () => {
    expect((await head('/_headers')).status).toBe(404)
  })
})
