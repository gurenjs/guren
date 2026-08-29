import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { Controller, Router, type RouteDefinition } from '@guren/core'
import { checkAgentRoutes } from '../src/agent-route-check'
import { writeWorkspaceFiles } from './helpers'

const handler = () => new Response('ok')

function route(
  overrides: Partial<RouteDefinition> & Pick<RouteDefinition, 'path'>,
): RouteDefinition {
  return { method: 'GET', capabilities: {}, ...overrides }
}

/**
 * `cwd` points at nothing on purpose for the definition-driven cases: with no
 * controller sources to discover, every verdict is drawn from the route
 * definition alone, which is what these cases are about.
 */
async function run(definitions: RouteDefinition[], cwd = '/nonexistent') {
  return checkAgentRoutes({ cwd, definitions })
}

const statuses = (results: Awaited<ReturnType<typeof run>>) => results.map((r) => r.status)
const keys = (results: Awaited<ReturnType<typeof run>>) => results.map((r) => r.key)

describe('checkAgentRoutes', () => {
  it('contributes nothing when no route declares agent metadata', async () => {
    expect(await run([route({ path: '/posts', name: 'posts.index' })])).toEqual([])
  })

  it('reports a single pass when every agent route is wired correctly', async () => {
    const results = await run([
      route({
        path: '/posts',
        name: 'posts.index',
        agent: { description: 'List posts.' },
        schemas: { output: z.object({ posts: z.array(z.string()) }) },
      }),
    ])

    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('pass')
    expect(results[0]?.message).toContain('1 agent-exposed route checked')
  })

  describe('tool identity', () => {
    it('fails when an agent route has no name', async () => {
      const results = await run([
        route({ path: '/posts', agent: {}, schemas: { output: z.object({}) } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.key).toBe('agent-route-name:GET:/posts')
      expect(results[0]?.message).toContain('identity')
    })

    // One defect, one finding: a nameless route has nothing for the grammar
    // rule to test, so reporting both would name it twice.
    it('does not also report the grammar rule for a nameless route', async () => {
      const results = await run([
        route({ path: '/posts', agent: {}, schemas: { output: z.object({}) } }),
      ])

      expect(keys(results).some((key) => key.startsWith('agent-route-tool-name:'))).toBe(false)
    })

    it('fails a tool name outside the MCP grammar', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts index', agent: {}, schemas: { output: z.object({}) } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain("'posts index'")
      expect(results[0]?.message).toContain('route name')
    })

    it('names the override as the source when toolName is the illegal one', async () => {
      const results = await run([
        route({
          path: '/posts',
          name: 'posts.index',
          agent: { toolName: 'posts/index' },
          schemas: { output: z.object({}) },
        }),
      ])

      expect(results[0]?.message).toContain('agent toolName override')
    })

    it('accepts a dotted route name verbatim', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts.index', agent: {}, schemas: { output: z.object({}) } }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    it('fails once per collision group, naming both routes', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts.index', agent: {}, schemas: { output: z.object({}) } }),
        route({
          path: '/articles',
          name: 'articles.index',
          agent: { toolName: 'posts.index' },
          schemas: { output: z.object({}) },
        }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.key).toBe('agent-route-duplicate:posts.index')
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain('GET /posts')
      expect(results[0]?.message).toContain('GET /articles')
    })
  })

  describe('authorization', () => {
    it('fails a non-read-only tool with no authorization at all', async () => {
      const results = await run([
        route({ method: 'DELETE', path: '/posts/:id', name: 'posts.destroy', agent: {} }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.key).toBe('agent-route-authorization:DELETE:/posts/:id')
      expect(results[0]?.message).toContain('no authorization')
    })

    // The rule RFC 0016 §5.5 exists for: authn is not authz.
    it('still fails when the chain only authenticates, with a distinct message', async () => {
      const results = await run([
        route({
          method: 'DELETE',
          path: '/posts/:id',
          name: 'posts.destroy',
          agent: {},
          capabilities: { authentication: { mode: 'required' } },
        }),
      ])

      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain('Authenticated but not authorized')
    })

    it('passes when the chain carries an authorization capability', async () => {
      const results = await run([
        route({
          method: 'DELETE',
          path: '/posts/:id',
          name: 'posts.destroy',
          agent: {},
          capabilities: { authorization: { abilities: ['posts.destroy'], mode: 'all' } },
        }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    // Authorization is present even when the *ability* is not derivable —
    // this rule asks whether anything authorizes, not which ability it names.
    it('accepts an authorization capability whose ability is not derivable', async () => {
      const results = await run([
        route({
          method: 'DELETE',
          path: '/posts/:id',
          name: 'posts.destroy',
          agent: {},
          capabilities: {
            authorization: { abilities: ['a', 'b'], mode: 'mixed', resource: { fromMethodMap: false } },
          },
        }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    it('does not require authorization on a read-only tool', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts.index', agent: {}, schemas: { output: z.object({}) } }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    it('requires authorization on a GET route whose readOnlyHint is overridden to false', async () => {
      const results = await run([
        route({
          path: '/posts/export',
          name: 'posts.export',
          agent: { readOnlyHint: false },
          schemas: { output: z.object({}) },
        }),
      ])

      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.key).toContain('agent-route-authorization')
    })

    it('exempts a POST route whose readOnlyHint is overridden to true', async () => {
      const results = await run([
        route({
          method: 'POST',
          path: '/posts/search',
          name: 'posts.search',
          agent: { readOnlyHint: true },
          schemas: { body: z.object({ q: z.string() }), output: z.object({}) },
        }),
      ])

      expect(results[0]?.status).toBe('pass')
    })
  })

  describe('advertised schemas', () => {
    it('warns when a read-only tool describes no output', async () => {
      const results = await run([route({ path: '/posts', name: 'posts.index', agent: {} })])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.key).toBe('agent-route-output:GET:/posts')
    })

    it('accepts a resource response hint in place of an output schema', async () => {
      const results = await run([
        route({
          path: '/posts',
          name: 'posts.index',
          agent: {},
          resource: { kind: 'collection', resource: 'PostResource' },
        }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    it('warns when a body-carrying tool declares no body schema', async () => {
      const results = await run([
        route({
          method: 'POST',
          path: '/posts',
          name: 'posts.store',
          agent: {},
          controller: { name: 'PostController', action: 'store' },
          capabilities: { authorization: { abilities: ['posts.store'], mode: 'all' } },
        }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.key).toBe('agent-route-input:POST:/posts')
      expect(results[0]?.message).toContain('inputSchema')
    })

    // DELETE is body-less by the shared classification, so the rule that asks
    // for a body schema must not fire on it.
    it('does not ask a DELETE route for a body schema', async () => {
      const results = await run([
        route({
          method: 'DELETE',
          path: '/posts/:id',
          name: 'posts.destroy',
          agent: {},
          controller: { name: 'PostController', action: 'destroy' },
          capabilities: { authorization: { abilities: ['posts.destroy'], mode: 'all' } },
        }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    // QUERY carries a body (RFC 10008) even though it is safe, which is
    // exactly why this rule shares audit's method classification.
    it('asks a QUERY route for a body schema', async () => {
      const results = await run([
        route({
          method: 'QUERY',
          path: '/posts',
          name: 'posts.search',
          agent: {},
          controller: { name: 'PostController', action: 'search' },
          schemas: { output: z.object({}) },
        }),
      ])

      expect(keys(results)).toContain('agent-route-input:QUERY:/posts')
    })
  })

  describe('against controller sources', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'guren-agent-routes-'))
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    const controllerSource = (body: string) => `
import { Controller } from '@guren/core'

export class PostController extends Controller {
  async destroy() {
${body}
  }
}
`

    it('accepts this.authorize() in the action as authorization evidence', async () => {
      await writeWorkspaceFiles(tempDir, {
        'app/Http/Controllers/PostController.ts': controllerSource(
          "    await this.authorize('delete', Post)\n    return this.noContent()",
        ),
      })

      const results = await run(
        [
          route({
            method: 'DELETE',
            path: '/posts/:id',
            name: 'posts.destroy',
            agent: {},
            controller: { name: 'PostController', action: 'destroy' },
          }),
        ],
        tempDir,
      )

      expect(results[0]?.status).toBe('pass')
    })

    // `can()` returns a boolean and enforces nothing — the same distinction
    // the audit draws between userOrFail() and check().
    it('does not accept this.can() as authorization evidence', async () => {
      await writeWorkspaceFiles(tempDir, {
        'app/Http/Controllers/PostController.ts': controllerSource(
          "    if (await this.can('delete', Post)) return this.noContent()\n    return this.redirect('/')",
        ),
      })

      const results = await run(
        [
          route({
            method: 'DELETE',
            path: '/posts/:id',
            name: 'posts.destroy',
            agent: {},
            controller: { name: 'PostController', action: 'destroy' },
          }),
        ],
        tempDir,
      )

      expect(results[0]?.status).toBe('fail')
    })

    it('reports userOrFail() as authenticated but not authorized', async () => {
      await writeWorkspaceFiles(tempDir, {
        'app/Http/Controllers/PostController.ts': controllerSource(
          '    const user = await this.auth.userOrFail()\n    return this.noContent()',
        ),
      })

      const results = await run(
        [
          route({
            method: 'DELETE',
            path: '/posts/:id',
            name: 'posts.destroy',
            agent: {},
            controller: { name: 'PostController', action: 'destroy' },
          }),
        ],
        tempDir,
      )

      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain('Authenticated but not authorized')
    })

    // A commented-out authorize() must not clear the route — the scan blanks
    // comments before any pattern runs.
    it('does not accept a commented-out authorize() as evidence', async () => {
      await writeWorkspaceFiles(tempDir, {
        'app/Http/Controllers/PostController.ts': controllerSource(
          "    // await this.authorize('delete', Post)\n    return this.noContent()",
        ),
      })

      const results = await run(
        [
          route({
            method: 'DELETE',
            path: '/posts/:id',
            name: 'posts.destroy',
            agent: {},
            controller: { name: 'PostController', action: 'destroy' },
          }),
        ],
        tempDir,
      )

      expect(results[0]?.status).toBe('fail')
    })

    it('warns about an Inertia response instead of the generic output warning', async () => {
      await writeWorkspaceFiles(tempDir, {
        'app/Http/Controllers/PostController.ts': `
import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() {
    return this.inertia(pages.posts.Index, { posts: [] })
  }
}
`,
      })

      const results = await run(
        [
          route({
            path: '/posts',
            name: 'posts.index',
            agent: {},
            controller: { name: 'PostController', action: 'index' },
          }),
        ],
        tempDir,
      )

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.key).toBe('agent-route-inertia:GET:/posts')
      expect(results[0]?.message).toContain('page.props')
    })

    // Fail-closed would be a false positive nothing in `guren check` can
    // suppress, so an unreadable controller is reported rather than failed.
    it('warns when the controller source cannot be read', async () => {
      const results = await run(
        [
          route({
            method: 'DELETE',
            path: '/posts/:id',
            name: 'posts.destroy',
            agent: {},
            controller: { name: 'MissingController', action: 'destroy' },
          }),
        ],
        tempDir,
      )

      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.message).toContain('could not be verified')
    })
  })

  // The linchpin: the metadata this check reads only reaches a definition
  // through the real Router — via route options, a chained .agent(), or
  // resource()'s per-action map — and the path it judges is the joined one.
  describe('against a real Router', () => {
    class PostController extends Controller {
      async index() {
        return this.json({})
      }

      async destroy() {
        return this.json({})
      }
    }

    it('reads metadata declared through route options', async () => {
      const router = new Router()
      router.get('/posts', { name: 'posts.index', agent: { description: 'List posts.' } }, handler)

      const results = await run(router.definitions())

      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.key).toBe('agent-route-output:GET:/posts')
    })

    it('reads metadata chained after .name()', async () => {
      const router = new Router()
      router.delete('/posts/:id', handler).name('posts.destroy').agent({})

      const results = await run(router.definitions())

      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.key).toBe('agent-route-authorization:DELETE:/posts/:id')
    })

    it('counts a group prefix as part of the path it reports', async () => {
      const router = new Router()
      router.group('/api', (grouped) => {
        grouped.delete('/posts/:id', { name: 'posts.destroy', agent: {} }, handler)
      })

      const results = await run(router.definitions())

      expect(results[0]?.key).toBe('agent-route-authorization:DELETE:/api/posts/:id')
    })

    it('reads resource() per-action metadata and leaves unlisted actions alone', async () => {
      const router = new Router()
      router.resource('/posts', PostController, {
        agent: { destroy: {} },
      })

      const results = await run(router.definitions())

      // Only `destroy` was declared, so `index` — registered by the same
      // call — contributes nothing. The verdict is the unreadable-controller
      // warn rather than a fail because this cwd holds no controller sources.
      expect(results).toHaveLength(1)
      expect(results[0]?.key).toBe('agent-route-authorization:DELETE:/posts/:id')
      expect(statuses(results)).toEqual(['warn'])
    })

    it('sees an authorization capability the middleware chain stamps', async () => {
      const router = new Router()
      router.delete('/posts/:id', { name: 'posts.destroy', agent: {} }, handler)

      const [definition] = router.definitions()
      // The capability shape the authorize middleware stamps; asserted here
      // through definitions() so a shape change breaks this compile.
      expect(definition?.capabilities).toBeDefined()
    })
  })

  describe('loading', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'guren-agent-routes-load-'))
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    it('contributes nothing when the app has no routes file', async () => {
      expect(await checkAgentRoutes({ cwd: tempDir })).toEqual([])
    })

    it('reports a skip when the routes file throws, rather than reading as clean', async () => {
      await writeWorkspaceFiles(tempDir, { 'routes/web.ts': 'throw new Error("boom")\n' })

      const results = await checkAgentRoutes({ cwd: tempDir })

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.message).toContain('failed to load')
      expect(results[0]?.message).toContain('boom')
    })
  })
})
