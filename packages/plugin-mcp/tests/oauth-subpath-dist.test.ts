import { describe, test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp, type Application, type Router } from '@guren/core'

/**
 * The one-map invariant, asserted across the **built** entries rather than in
 * source.
 *
 * `@guren/plugin-mcp/oauth` writes the seam; `@guren/plugin-mcp` reads it. In
 * source they are two importers of one leaf module, so identity is free. In
 * `dist/` they are two rolldown entries, and a bundler that inlined
 * `external-auth.ts` into each would produce two `WeakMap`s — after which the
 * generated worker presents a grant into one map while the endpoint consults
 * the other, and every request 401s with the whole source-level suite green.
 * Nothing at source level can tell the two apart, which is why this test
 * reaches through the package's own `exports` map.
 *
 * Skipped rather than failed when `dist/` is absent: this asserts a property
 * of a build, and a checkout that has not run one has nothing to assert about.
 */
const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const built = existsSync(`${distDir}/index.js`) && existsSync(`${distDir}/oauth.js`)

describe.if(built)('@guren/plugin-mcp/oauth (built entries)', () => {
  test('should present into the same seam the built endpoint reads', async () => {
    // Self-referencing imports, so the package's own `exports` map decides
    // which files these are — the same resolution a consuming app performs.
    const { presentExternalMcpAuth } = await import('@guren/plugin-mcp/oauth')
    const { mcpPlugin } = await import('@guren/plugin-mcp')

    const app: Application = createApp({
      routes: (router: Router) => {
        router
          .get('/posts', () => Response.json({ ok: true }))
          .name('posts.index')
          .agent({ description: 'List posts' })
      },
      // No token store anywhere: only the seam can get a request served, so a
      // 200 here is proof the two entries share one map.
      providers: [mcpPlugin({ auth: 'external' })],
    })
    await app.boot()

    const request = presentExternalMcpAuth(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      { principal: { kind: 'user', id: 'u_1', abilities: ['tools:*'] }, scopes: ['tools:*'] },
    )

    const response = await app.fetch(request)
    expect(response.status).toBe(200)
  })
})
