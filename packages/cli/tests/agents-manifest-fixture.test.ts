/**
 * Keeps `@guren/plugin-webmcp`'s manifest fixture honest.
 *
 * That fixture is a snapshot of `buildAgentToolsContent()` output, pasted
 * into the plugin's source so its `as const` shape can be type-checked
 * against `WebMcpToolSource` — the one assignment the plugin's own suite
 * cannot make any other way (everything else there builds mutable
 * `DerivedAgentTool` objects, which satisfy the interface trivially).
 *
 * A pasted snapshot nothing regenerates is the "test that cannot fail" shape
 * this repo has been bitten by: change what `renderTool` emits and the
 * fixture keeps standing in for a manifest codegen no longer writes, while
 * every assertion around it stays green. So the routes that produced it live
 * here, and this regenerates and compares.
 *
 * The comparison starts at the generated doc comment, so the fixture's own
 * provenance header is free to change while every emitted byte after it —
 * doc comment, field order, field values — must match exactly.
 *
 * Read as a *file*, not imported as a module: `@guren/cli` must not grow a
 * dependency edge on a plugin, and this is the one direction that would
 * create one.
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
 * The routes the fixture was generated from — the shapes a WebMCP client has
 * to handle: a params+body split, a query-only GET, a nested non-object body,
 * an `output` schema, an empty `inputSources`, an `expose.webMcp: false`
 * route and an `approval: 'required'` one.
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

    // Exact, byte for byte. Regenerate the fixture rather than editing it:
    //   bun run --cwd examples/blog codegen   (for a real app), or re-render
    //   these routes through buildAgentToolsContent and paste the output
    //   under the fixture's provenance header.
    expect(fixture.slice(fixtureFrom)).toBe(generated.slice(generatedFrom))
  })
})
