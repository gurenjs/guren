/**
 * The `@guren/server/agent` entry (RFC 0016 §3, §8): what an out-of-process
 * dispatcher — the WebMCP client, `guren tool:call`, `@guren/testing` — is
 * promised, and the one option that entry added for them.
 *
 * Imported through the entry module rather than `../../src/agent/dispatch`,
 * on purpose: a re-export dropped from `public.ts` is the failure this file
 * exists to catch, and reaching past it would leave that entirely to the
 * exports map, which nothing in the source tree checks.
 */
import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { Router } from '../../src/mvc/Router'
import { deriveAgentTools, type DerivedAgentTool } from '../../src/agent/derive'
import {
  advertisesStructuredOutput,
  buildToolRequest,
  mapToolResponse,
  PREFLIGHT_ARGUMENT,
} from '../../src/agent/public'

const handler = () => new Response('ok')

function listTool(): DerivedAgentTool {
  const router = new Router()
  router
    .get('/posts', { query: z.object({ page: z.coerce.number().optional() }) }, handler)
    .name('posts.index')
    .agent({})
  const { tools } = deriveAgentTools(router.definitions())
  return tools[0]!
}

describe('@guren/server/agent entry', () => {
  test('should re-export the dispatch surface an out-of-process caller needs', () => {
    // Values, not types: a type-only re-export compiles away, so only these
    // can be asserted at runtime. The type exports are held by the consumers
    // that import them (packages/plugin-webmcp) and by `bun run typecheck`.
    expect(typeof buildToolRequest).toBe('function')
    expect(typeof mapToolResponse).toBe('function')
    expect(typeof advertisesStructuredOutput).toBe('function')
    expect(PREFLIGHT_ARGUMENT).toBe('_preflight')
  })
})

describe('buildToolRequest surface option', () => {
  test('should default the surface header to mcp', () => {
    const built = buildToolRequest(listTool(), {})
    const request = ('request' in built ? built : undefined)!.request
    expect(request.headers.get('X-Guren-Agent-Surface')).toBe('mcp')
  })

  test('should announce the surface it was given', () => {
    const built = buildToolRequest(listTool(), {}, { surface: 'webmcp' })
    const request = ('request' in built ? built : undefined)!.request
    expect(request.headers.get('X-Guren-Agent-Surface')).toBe('webmcp')
  })

  test('should leave every other header untouched by the surface', () => {
    const built = buildToolRequest(listTool(), { page: 2 }, { surface: 'cli' })
    const request = ('request' in built ? built : undefined)!.request
    expect(request.headers.get('Accept')).toBe('application/json')
    expect(new URL(request.url).searchParams.get('page')).toBe('2')
  })
})
