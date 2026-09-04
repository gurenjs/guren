/**
 * Keeps `@guren/plugin-webmcp`'s manifest fixture honest: it is a pasted snapshot of
 * `buildAgentToolsContent()` output, kept so its `as const` shape can be type-checked
 * against `WebMcpToolSource`. Nothing else regenerates it, so the routes that produced
 * it live here and this re-renders and compares them byte for byte from the generated
 * doc comment on, leaving the fixture's provenance header free to change.
 *
 * Read as a *file*, not imported: `@guren/cli` must not gain a dependency on a plugin.
 */
import { describe, test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { Controller, Router, deriveAgentTools, authorizeMiddleware } from '@guren/core'
import { buildAgentToolsContent } from '../src/agents-types'

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  'plugin-webmcp',
  'src',
  'agents-manifest.fixture.ts',
)

/** Where the generated text begins, in both the fixture and a fresh render. */
const MARKER = '/**\n * Agent tools derived from'

class PostController extends Controller {
  async index() {
    return this.json({ posts: [] })
  }

  async store() {
    return this.created({})
  }

  async summary() {
    return this.json({ total: 0 })
  }
}

/**
 * The routes the fixture was generated from: a params+body split, a query-only GET, a
 * non-object body, an `output` schema, an empty `inputSources`, `expose.webMcp: false`
 * and `approval: 'required'`.
 */
function fixtureRouter(): Router {
  const router = new Router()
  router
    .get(
      '/posts',
      { name: 'posts.index', query: z.object({ page: z.coerce.number().optional() }) },
      [PostController, 'index'],
    )
    .agent({ description: 'List posts.' })
  router
    .post(
      '/posts/:id/comments',
      {
        name: 'comments.store',
        params: z.object({ id: z.coerce.number() }),
        body: z.object({ text: z.string().min(1) }),
      },
      [PostController, 'store'],
    )
    .middleware(authorizeMiddleware('create-comment'))
    .agent({ description: 'Comment on a post.', redact: ['text'] })
  router
    .get('/posts/summary', { name: 'posts.summary', output: z.object({ total: z.number() }) }, [
      PostController,
      'summary',
    ])
    .agent({})
  router
    .post('/payouts', { name: 'payouts.store' }, [PostController, 'store'])
    .agent({ approval: 'required' })
  router
    .get('/internal', { name: 'internal.index' }, [PostController, 'index'])
    .agent({ expose: { webMcp: false } })
  router
    .post('/posts/bulk', { name: 'posts.bulk', body: z.array(z.string()) }, [
      PostController,
      'store',
    ])
    .agent({})
  return router
}

describe('plugin-webmcp manifest fixture', () => {
  test('should still be what codegen emits for its routes', async () => {
    const { tools } = deriveAgentTools(fixtureRouter().definitions())
    const generated = buildAgentToolsContent(tools)
    const fixture = await readFile(FIXTURE, 'utf8')

    const generatedFrom = generated.indexOf(MARKER)
    const fixtureFrom = fixture.indexOf(MARKER)
    expect(generatedFrom).toBeGreaterThanOrEqual(0)
    expect(fixtureFrom).toBeGreaterThanOrEqual(0)

    // Regenerate the fixture rather than editing it: re-render these routes through
    // buildAgentToolsContent and paste the output under its provenance header.
    expect(fixture.slice(fixtureFrom)).toBe(generated.slice(generatedFrom))
  })
})
