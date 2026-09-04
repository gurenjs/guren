import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { Controller, Router, authorizeMiddleware, type RouteDefinition } from '@guren/core'
import { checkAgentRoutes } from '../src/agent-route-check'
import { writeWorkspaceFiles } from './helpers'

const handler = () => new Response('ok')

/** Stands in for an advertised output, so unrelated cases don't trip the tier-3 warn. */
const OUTPUT = { output: z.object({ ok: z.boolean() }) }

function route(
  overrides: Partial<RouteDefinition> & Pick<RouteDefinition, 'path'>,
): RouteDefinition {
  return { method: 'GET', capabilities: {}, ...overrides }
}

/** `cwd` points at nothing on purpose: with no controller sources, every verdict comes from the definition alone. */
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
      route({ path: '/posts', name: 'posts.index', agent: { description: 'List posts.' }, schemas: OUTPUT }),
    ])

    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('pass')
    expect(results[0]?.message).toContain('1 agent-exposed route checked')
  })

  // The pass message may not claim more than the check looked at.
  it('scopes the pass message to what was actually checked', async () => {
    const [result] = await run([
      route({ path: '/posts', name: 'posts.index', agent: {}, schemas: OUTPUT }),
    ])

    expect(result?.message).toContain('Nothing here validates the derived tools themselves')
  })

  describe('tool identity', () => {
    it('fails when an agent route has no name', async () => {
      const results = await run([route({ path: '/posts', agent: {}, schemas: OUTPUT })])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.key).toBe('agent-route-name:GET:/posts')
      expect(results[0]?.message).toContain('identity')
    })

    // One defect, one finding: a nameless route has nothing for the grammar rule to test.
    it('does not also report the grammar rule for a nameless route', async () => {
      const results = await run([route({ path: '/posts', agent: {}, schemas: OUTPUT })])

      expect(keys(results).some((key) => key.startsWith('agent-route-tool-name:'))).toBe(false)
    })

    it('fails a tool name outside the MCP grammar', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts index', agent: {}, schemas: OUTPUT }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain("'posts index'")
      expect(results[0]?.message).toContain('route name')
    })

    it('names the override as the source when toolName is the illegal one', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts.index', agent: { toolName: 'posts/index' }, schemas: OUTPUT }),
      ])

      expect(results[0]?.message).toContain('agent toolName override')
    })

    it('accepts a dotted route name verbatim', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts.index', agent: {}, schemas: OUTPUT }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    // The endpoint adds `guren.preflight` itself and drops any route claiming it: two tools
    // with one name makes an MCP client reject the whole list.
    it('fails a route claiming a reserved meta-tool name', async () => {
      const results = await run([
        route({ path: '/preflight', name: 'guren.preflight', agent: {}, schemas: OUTPUT }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.key).toBe('agent-route-reserved-name:GET:/preflight')
      expect(results[0]?.message).toContain('reserved')
      expect(results[0]?.message).toContain('guren.preflight')
    })

    it('fails a reserved name that arrived through the toolName override', async () => {
      const results = await run([
        route({
          path: '/checks',
          name: 'checks.index',
          agent: { toolName: 'guren.preflight' },
          schemas: OUTPUT,
        }),
      ])

      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain('agent toolName override')
    })

    // The reservation is one name, not the `guren.` namespace.
    it('accepts a name that merely resembles a reserved one', async () => {
      const results = await run([
        route({ path: '/preflight', name: 'guren.preflights', agent: {}, schemas: OUTPUT }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('pass')
    })

    it('fails once per collision group, naming both routes', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts.index', agent: {}, schemas: OUTPUT }),
        route({
          path: '/articles',
          name: 'articles.index',
          agent: { toolName: 'posts.index' },
          schemas: OUTPUT,
        }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.key).toBe('agent-route-duplicate:posts.index')
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain('GET /posts')
      expect(results[0]?.message).toContain('GET /articles')
    })

    // Renaming the illegal one fixes both rules, so a third finding would triple-report one defect.
    it('does not also report a collision between illegally-named tools', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts index', agent: {}, schemas: OUTPUT }),
        route({ path: '/articles', name: 'articles.index', agent: { toolName: 'posts index' }, schemas: OUTPUT }),
      ])

      expect(keys(results).every((key) => key.startsWith('agent-route-tool-name:'))).toBe(true)
      expect(results).toHaveLength(2)
    })
  })

  describe('authorization', () => {
    /** A mutating agent route bound to a controller action, for the authz rules. */
    const destroyRoute = (overrides: Partial<RouteDefinition> = {}) =>
      route({
        method: 'DELETE',
        path: '/posts/:id',
        name: 'posts.destroy',
        agent: {},
        controller: { name: 'PostController', action: 'destroy' },
        schemas: OUTPUT,
        ...overrides,
      })

    it('passes when the chain carries an authorization capability', async () => {
      const results = await run([
        destroyRoute({ capabilities: { authorization: { abilities: ['posts.destroy'], mode: 'all' } } }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    // The rule asks whether anything authorizes, not which ability it names.
    it('accepts an authorization capability whose ability is not derivable', async () => {
      const results = await run([
        destroyRoute({
          capabilities: {
            authorization: { abilities: ['a', 'b'], mode: 'mixed', resource: { fromMethodMap: false } },
          },
        }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    it('does not require authorization on a read-only tool', async () => {
      const results = await run([
        route({ path: '/posts', name: 'posts.index', agent: {}, schemas: OUTPUT }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    it('requires authorization on a GET route whose readOnlyHint is overridden to false', async () => {
      const results = await run([
        route({
          path: '/posts/export',
          name: 'posts.export',
          agent: { readOnlyHint: false },
          controller: { name: 'PostController', action: 'export' },
          schemas: OUTPUT,
        }),
      ])

      expect(results[0]?.key).toContain('agent-route-authorization')
    })

    it('exempts a POST route whose readOnlyHint is overridden to true', async () => {
      const results = await run([
        route({
          method: 'POST',
          path: '/posts/search',
          name: 'posts.search',
          agent: { readOnlyHint: true },
          controller: { name: 'PostController', action: 'search' },
          schemas: { body: z.object({ q: z.string() }), ...OUTPUT },
        }),
      ])

      // The exemption holds, but the unread body it rests on is reported.
      expect(keys(results)).not.toContain('agent-route-authorization:POST:/posts/search')
      expect(keys(results)).toContain('agent-route-annotation:POST:/posts/search')
    })

    // An inline handler's body is a closure this check never reads, so a fail would describe unopened source.
    it('warns rather than fails for an inline handler with no authorization', async () => {
      const results = await run([
        route({ method: 'DELETE', path: '/posts/:id', name: 'posts.destroy', agent: {}, schemas: OUTPUT }),
      ])

      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.key).toBe('agent-route-authorization:DELETE:/posts/:id')
      expect(results[0]?.message).toContain('inline function')
    })

    it('warns when the controller source cannot be read', async () => {
      const results = await run([destroyRoute()])

      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.message).toContain('could not be verified')
      expect(results[0]?.message).toContain('PostController.destroy')
    })
  })

  describe('advertised schemas', () => {
    it('warns when a read-only tool describes no output', async () => {
      const results = await run([route({ path: '/posts', name: 'posts.index', agent: {} })])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.key).toBe('agent-route-output:GET:/posts')
    })

    // RFC 0016 §13 states the tier-3 warn unqualified, write tools included.
    it('warns for a write tool with no output too', async () => {
      const results = await run([
        route({
          method: 'POST',
          path: '/posts',
          name: 'posts.store',
          agent: {},
          schemas: { body: z.object({ title: z.string() }) },
          capabilities: { authorization: { abilities: ['posts.store'], mode: 'all' } },
        }),
      ])

      expect(keys(results)).toContain('agent-route-output:POST:/posts')
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
          schemas: OUTPUT,
          capabilities: { authorization: { abilities: ['posts.store'], mode: 'all' } },
        }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.key).toBe('agent-route-input:POST:/posts')
      expect(results[0]?.message).toContain('inputSchema')
    })

    // For an inline handler the route schema is the only runtime validation.
    it('warns about a missing body schema on an inline handler, saying nothing validates it', async () => {
      const results = await run([
        route({
          method: 'POST',
          path: '/posts',
          name: 'posts.store',
          agent: {},
          schemas: OUTPUT,
          capabilities: { authorization: { abilities: ['posts.store'], mode: 'all' } },
        }),
      ])

      const input = results.find((r) => r.key === 'agent-route-input:POST:/posts')
      expect(input?.status).toBe('warn')
      expect(input?.message).toContain('nothing checks what it sends')
    })

    // DELETE is body-less by the shared classification.
    it('does not ask a DELETE route for a body schema', async () => {
      const results = await run([
        route({
          method: 'DELETE',
          path: '/posts/:id',
          name: 'posts.destroy',
          agent: {},
          controller: { name: 'PostController', action: 'destroy' },
          schemas: OUTPUT,
          capabilities: { authorization: { abilities: ['posts.destroy'], mode: 'all' } },
        }),
      ])

      expect(results[0]?.status).toBe('pass')
    })

    // QUERY carries a body (RFC 10008) even though it is safe: hence the shared classification.
    it('asks a QUERY route for a body schema', async () => {
      const results = await run([
        route({
          method: 'QUERY',
          path: '/posts',
          name: 'posts.search',
          agent: {},
          controller: { name: 'PostController', action: 'search' },
          schemas: OUTPUT,
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

    /** Both spellings are legal to `Router`'s dispatch, so every body-reading rule must see them alike. */
    async function writeController(
      action: string,
      body: string,
      declaration: 'method' | 'field',
    ): Promise<void> {
      const member =
        declaration === 'method'
          ? `  async ${action}() {\n${body}\n  }`
          : `  ${action} = async () => {\n${body}\n  }`

      await writeWorkspaceFiles(tempDir, {
        'app/Http/Controllers/PostController.ts': `
import { Controller } from '@guren/core'

export class PostController extends Controller {
${member}
}
`,
      })
    }

    interface ActionCase {
      agent?: Record<string, unknown>
      declaration?: 'method' | 'field'
      /** Omitted for the routes whose point is that nothing describes the output. */
      schemas?: RouteDefinition['schemas']
    }

    /** A mutating agent route (DELETE) against `PostController.destroy`. */
    async function runDestroy(body: string, options: ActionCase = {}) {
      const { agent = {}, declaration = 'method' } = options
      // `in`, not a destructuring default: "no output schema" passes `schemas: undefined`.
      const schemas = 'schemas' in options ? options.schemas : OUTPUT
      await writeController('destroy', body, declaration)

      return run(
        [
          route({
            method: 'DELETE',
            path: '/posts/:id',
            name: 'posts.destroy',
            agent,
            controller: { name: 'PostController', action: 'destroy' },
            schemas,
          }),
        ],
        tempDir,
      )
    }

    /** The read-only sibling: a GET route against `PostController.index`. */
    async function runIndex(body: string, options: ActionCase = {}) {
      const { agent = {}, declaration = 'method' } = options
      // `in`, not a destructuring default: "no output schema" passes `schemas: undefined`.
      const schemas = 'schemas' in options ? options.schemas : OUTPUT
      await writeController('index', body, declaration)

      return run(
        [
          route({
            path: '/posts',
            name: 'posts.index',
            agent,
            controller: { name: 'PostController', action: 'index' },
            schemas,
          }),
        ],
        tempDir,
      )
    }

    it('accepts this.authorize() in the action as authorization evidence', async () => {
      const results = await runDestroy(
        "    await this.authorize('delete', Post)\n    return this.noContent()",
      )

      expect(results[0]?.status).toBe('pass')
    })

    // `can()` returns a boolean and enforces nothing.
    it('does not accept this.can() as authorization evidence', async () => {
      const results = await runDestroy(
        "    if (await this.can('delete', Post)) return this.noContent()\n    return this.redirect('/')",
      )

      expect(results[0]?.status).toBe('fail')
    })

    it('reports userOrFail() as authenticated but not authorized', async () => {
      const results = await runDestroy(
        '    const user = await this.auth.userOrFail()\n    return this.noContent()',
      )

      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain('Authenticated but not authorized')
    })

    // A bearer token is the auth path an agent actually uses; a userOrFail()-only pattern
    // would report a token-authenticated action as unauthenticated.
    it('reports apiToken() authentication with the same sharper message', async () => {
      const results = await runDestroy(
        '    const userId = await this.apiTokenUserId()\n    return this.noContent()',
      )

      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain('Authenticated but not authorized')
    })

    // The scan blanks comments before any pattern runs.
    it('does not accept a commented-out authorize() as evidence', async () => {
      const results = await runDestroy(
        "    // await this.authorize('delete', Post)\n    return this.noContent()",
      )

      expect(results[0]?.status).toBe('fail')
    })

    it('warns about an Inertia response instead of the generic output warning', async () => {
      // No output schema: the case is about what the tool returns when nothing describes it.
      const results = await runIndex('    return this.inertia(pages.posts.Index, { posts: [] })', {
        schemas: undefined,
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.key).toBe('agent-route-inertia:GET:/posts')
      expect(results[0]?.message).toContain('page.props')
    })

    describe('readOnlyHint honesty', () => {
      // Unchecked, writing the hint would silence the authorization failure it answers.
      it('warns when readOnlyHint: true sits on an action that deletes', async () => {
        const results = await runDestroy(
          '    await Post.delete({ id: 1 })\n    return this.noContent()',
          { agent: { readOnlyHint: true } },
        )

        const honesty = results.find((r) => r.key === 'agent-route-annotation:DELETE:/posts/:id')
        expect(honesty?.status).toBe('warn')
        expect(honesty?.message).toContain('readOnlyHint: true')
        // And the exemption it bought is named as the reason this matters.
        expect(honesty?.message).toContain('exempts this route')
      })

      it('warns on a force-write behind the same claim', async () => {
        const results = await runDestroy(
          '    await Post.forceUpdate({ id: 1 }, { archived: true })\n    return this.noContent()',
          { agent: { readOnlyHint: true } },
        )

        expect(keys(results)).toContain('agent-route-annotation:DELETE:/posts/:id')
      })

      it('stays quiet when the action really only reads', async () => {
        const results = await runDestroy(
          '    const post = await Post.find(1)\n    return this.json({ ok: Boolean(post) })',
          { agent: { readOnlyHint: true } },
        )

        expect(keys(results)).not.toContain('agent-route-annotation:DELETE:/posts/:id')
      })

      // Nobody wrote the GET default, but it carries the same exemption and the same promise.
      it('judges the method default too, when a GET action mutates', async () => {
        const results = await runIndex(
          '    await Post.delete({ id: 1 })\n    return this.json({})',
        )

        const honesty = results.find((r) => r.key === 'agent-route-annotation:GET:/posts')
        expect(honesty?.status).toBe('warn')
        expect(honesty?.message).toContain('read-only tools by default')
      })

      // An unverifiable default would fire on every read route whose controller is unreadable.
      it('does not chase the method default into an unreadable body', async () => {
        const results = await run([
          route({
            path: '/posts',
            name: 'posts.index',
            agent: {},
            controller: { name: 'MissingController', action: 'index' },
            schemas: OUTPUT,
          }),
        ])

        expect(keys(results)).not.toContain('agent-route-annotation:GET:/posts')
      })

      // A plain update() is a mutation the earlier delete-only evidence missed.
      it('counts a plain update() as mutation evidence', async () => {
        const results = await runDestroy(
          "    await Post.update({ id: 1 }, { title: 'x' })\n    return this.noContent()",
          { agent: { readOnlyHint: true } },
        )

        expect(keys(results)).toContain('agent-route-annotation:DELETE:/posts/:id')
      })

      // Receiver discipline is pinned in controller-methods.test.ts, not re-tested here.
    })

    // Both forms are legal to Router's dispatch; a scanner reading only methods
    // downgraded every class-field action.
    it('reads a class-field action, not just a method', async () => {
      const results = await runDestroy(
        "    await this.authorize('delete', Post)\n    return this.noContent()",
        { declaration: 'field' },
      )

      // A clean pass, not the could-not-verify warn an unread body produces.
      expect(results[0]?.status).toBe('pass')
    })

    // A collision changes the verdict only for routes naming that class.
    it('does not report a controller collision unrelated to any agent route', async () => {
      await writeWorkspaceFiles(tempDir, {
        'app/Http/Controllers/PostController.ts': `
import { Controller } from '@guren/core'

export class PostController extends Controller {
  async destroy() {
    await this.authorize('delete', Post)
    return this.noContent()
  }
}
`,
        'modules/billing/app/Http/Controllers/InvoiceController.ts': `
import { Controller } from '@guren/core'

export class InvoiceController extends Controller {
  async index() { return this.json({}) }
}
`,
        'app/Http/Controllers/InvoiceController.ts': `
import { Controller } from '@guren/core'

export class InvoiceController extends Controller {
  async index() { return this.json({}) }
}
`,
      })

      const results = await run(
        [
          route({
            method: 'DELETE',
            path: '/posts/:id',
            name: 'posts.destroy',
            agent: {},
            controller: { name: 'PostController', action: 'destroy' },
            schemas: OUTPUT,
          }),
        ],
        tempDir,
      )

      expect(keys(results).some((key) => key.startsWith('agent-route-controller-collision:'))).toBe(false)
    })
  })

  // The metadata only reaches a definition through the real Router (route options, a chained
  // .agent(), or resource()'s per-action map), and the path judged is the joined one.
  describe('against a real Router', () => {
    // An `output` schema types the handler, so these cases return a value rather than a Response.
    const typedHandler = () => ({})

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
      router.delete('/posts/:id', { output: z.object({}) }, typedHandler).name('posts.destroy').agent({})

      const results = await run(router.definitions())

      expect(results[0]?.key).toBe('agent-route-authorization:DELETE:/posts/:id')
    })

    it('counts a group prefix as part of the path it reports', async () => {
      const router = new Router()
      router.group('/api', (grouped) => {
        grouped.delete('/posts/:id', { name: 'posts.destroy', agent: {}, output: z.object({}) }, typedHandler)
      })

      const results = await run(router.definitions())

      expect(results[0]?.key).toBe('agent-route-authorization:DELETE:/api/posts/:id')
    })

    it('reads resource() per-action metadata and leaves unlisted actions alone', async () => {
      const router = new Router()
      router.resource('/posts', PostController, { agent: { destroy: {} } })

      const results = await run(router.definitions())

      // Only `destroy` was declared, so `index` contributes nothing. Its two findings: the
      // unreadable-controller authorization warn (no controller sources here) and no output schema.
      expect(keys(results).every((key) => key.endsWith(':DELETE:/posts/:id'))).toBe(true)
      expect(statuses(results).every((status) => status === 'warn')).toBe(true)
    })

    // Stamped by real middleware rather than hand-written onto a definition.
    it('accepts authorization stamped by authorizeMiddleware on the chain', async () => {
      const router = new Router()
      router
        .delete('/posts/:id', { name: 'posts.destroy', agent: {}, output: z.object({}) }, typedHandler)
        .middleware(authorizeMiddleware('posts.destroy'))

      const results = await run(router.definitions())

      expect(keys(results)).not.toContain('agent-route-authorization:DELETE:/posts/:id')
      expect(results[0]?.status).toBe('pass')
    })
  })

  describe('the approval queue', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'guren-agent-routes-approval-'))
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    const gated = () =>
      route({
        method: 'DELETE',
        path: '/posts/:id',
        name: 'posts.destroy',
        agent: { approval: 'required', readOnlyHint: true },
        schemas: OUTPUT,
      })

    async function writeAppFile(contents: string): Promise<void> {
      await writeWorkspaceFiles(tempDir, { 'src/app.ts': contents })
    }

    it('fails when a readable mcpPlugin call configures no approvals', async () => {
      await writeAppFile(`
import { mcpPlugin } from '@guren/plugin-mcp'

export const providers = [mcpPlugin({ path: '/mcp' })]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      const finding = results.find((result) => result.key === 'agent-route-approval-store')

      expect(finding?.status).toBe('fail')
      expect(finding?.message).toContain('posts.destroy')
      expect(finding?.message).toContain('approvals')
      expect(finding?.filePath).toBe('src/app.ts')
    })

    it('fails on mcpPlugin() with no options at all', async () => {
      await writeAppFile(`
import { mcpPlugin } from '@guren/plugin-mcp'

export const providers = [mcpPlugin()]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      expect(keys(results)).toContain('agent-route-approval-store')
    })

    it('passes when the call carries an approvals queue', async () => {
      await writeAppFile(`
import { mcpPlugin } from '@guren/plugin-mcp'
import { store } from './approvals'

export const providers = [mcpPlugin({ approvals: { store, notify: () => {} } })]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      expect(keys(results)).not.toContain('agent-route-approval-store')
    })

    it('reads plugin options written behind a transparent wrapper', async () => {
      await writeAppFile(`
import { mcpPlugin, type McpPluginOptions } from '@guren/plugin-mcp'

export const providers = [mcpPlugin({ path: '/mcp' } satisfies McpPluginOptions)]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      // Read as unreadable, the positive-evidence-only rule turns a gated route with
      // nowhere to queue approvals into silence.
      expect(keys(results)).toContain('agent-route-approval-store')
    })

    it('reads an approvals queue written behind a transparent wrapper', async () => {
      // The unwrapped call is what makes this able to fail: alone, a wrapped configured call
      // is indistinguishable from an unreadable one. Pairing it with a readable queue-less
      // call means the wrapped one must be understood as configured to keep the finding away.
      await writeAppFile(`
import { mcpPlugin } from '@guren/plugin-mcp'
import { store } from './approvals'

export const providers = [
  mcpPlugin({ path: '/mcp' }),
  mcpPlugin({ approvals: { store, notify: () => {} } } as const),
]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      expect(keys(results)).not.toContain('agent-route-approval-store')
    })

    it('follows a local alias of the factory', async () => {
      await writeAppFile(`
import { mcpPlugin as mcp } from '@guren/plugin-mcp'

export const providers = [mcp({ path: '/mcp' })]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      expect(keys(results)).toContain('agent-route-approval-store')
    })

    // Positive evidence only: `guren check` has no per-finding ignore, so a false positive
    // here would be unsuppressible.
    it('stays silent when the plugin options are not an object literal', async () => {
      await writeAppFile(`
import { mcpPlugin } from '@guren/plugin-mcp'
import { mcpConfig } from './config'

export const providers = [mcpPlugin(mcpConfig)]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      expect(keys(results)).not.toContain('agent-route-approval-store')
    })

    it('stays silent when the options object spreads another', async () => {
      await writeAppFile(`
import { mcpPlugin } from '@guren/plugin-mcp'
import { base } from './config'

export const providers = [mcpPlugin({ ...base, path: '/mcp' })]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      expect(keys(results)).not.toContain('agent-route-approval-store')
    })

    it('stays silent for an app that never mounts the endpoint', async () => {
      await writeAppFile('export const providers = []\n')

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      expect(keys(results)).not.toContain('agent-route-approval-store')
    })

    it('stays silent when a same-named factory comes from elsewhere', async () => {
      await writeAppFile(`
import { mcpPlugin } from './my-own-plugin'

export const providers = [mcpPlugin({ path: '/mcp' })]
`)

      const results = await checkAgentRoutes({ cwd: tempDir, definitions: [gated()] })
      expect(keys(results)).not.toContain('agent-route-approval-store')
    })

    it('reports the missing queue once, naming every gated route', async () => {
      await writeAppFile(`
import { mcpPlugin } from '@guren/plugin-mcp'

export const providers = [mcpPlugin({})]
`)

      const results = await checkAgentRoutes({
        cwd: tempDir,
        definitions: [
          gated(),
          route({
            method: 'POST',
            path: '/payouts',
            name: 'payouts.store',
            agent: { approval: 'required', readOnlyHint: true },
            schemas: OUTPUT,
          }),
        ],
      })

      const findings = results.filter((result) => result.key === 'agent-route-approval-store')
      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('posts.destroy')
      expect(findings[0]?.message).toContain('payouts.store')
    })

    it('says nothing about the queue when no route declares approval', async () => {
      await writeAppFile(`
import { mcpPlugin } from '@guren/plugin-mcp'

export const providers = [mcpPlugin({ path: '/mcp' })]
`)

      const results = await checkAgentRoutes({
        cwd: tempDir,
        definitions: [route({ path: '/posts', name: 'posts.index', agent: {}, schemas: OUTPUT })],
      })

      expect(keys(results)).not.toContain('agent-route-approval-store')
      expect(results[0]?.status).toBe('pass')
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
