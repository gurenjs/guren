import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../src/mcp/create-mcp-server'
import type { CodegenOptions, CodegenResult, GurenCliApi } from '../../src/mcp/create-mcp-server'

const ROUTE_MANIFEST = [{ method: 'GET', path: '/posts', name: 'posts.index' }]
const RESOURCE_DEFINITIONS = [{ className: 'PostResource', dataName: 'Post' }]

type CodegenCall = { generator: string; options: CodegenOptions; definitions?: unknown[] }

function createMockCli(overrides: Partial<GurenCliApi> = {}, calls?: CodegenCall[]): GurenCliApi {
  const record =
    (generator: string, result?: CodegenResult) => async (options: CodegenOptions) => {
      calls?.push({ generator, options })
      return result
    }

  return {
    // The base mock stands in for a current @guren/cli; the tool gates on
    // this list because @guren/cli is resolved from the app at runtime.
    CONTEXT_ROUTE_FEATURES: ['agent'],
    generateContext: async () => ({
      framework: { name: 'guren', version: '0.2.0' },
      models: [{ className: 'Post' }, { className: 'User' }],
      routes: [{ method: 'GET', path: '/posts' }],
      pages: ['Posts/Index', 'Posts/Show'],
      controllers: ['PostController', 'UserController'],
      resources: ['PostResource'],
      events: ['PostCreated'],
      jobs: ['SendWelcomeEmail'],
      middleware: ['auth'],
      listeners: ['NotifyAuthor'],
      validators: ['CreatePostValidator'],
    }),
    renderContextMarkdown: (ctx) => `# Context\n${JSON.stringify(ctx)}`,
    generateEntityContext: async (entity: string) => {
      if (entity.toLowerCase() !== 'post') {
        throw new Error(`Model "${entity}" not found. Available models: Post, User`)
      }
      return {
        entity: 'Post',
        model: { filePath: 'app/Models/Post.ts', tableName: 'posts', relationships: [] },
        routes: [{ method: 'GET', path: '/posts', controller: { name: 'PostController', action: 'index' } }],
        pages: [{ id: 'posts/Index', filePath: 'resources/js/pages/posts/Index.tsx' }],
      }
    },
    renderEntityContextMarkdown: (ctx) => `# Post\n${JSON.stringify(ctx)}`,
    runCheck: async () => ({
      cwd: '/test',
      checks: [
        { key: 'empty-methods', title: 'Empty methods', status: 'pass', message: 'All good' },
        { key: 'missing-tests', title: 'Missing tests', status: 'warn', message: 'PostController has no test' },
      ],
      passCount: 1,
      warnCount: 1,
      failCount: 0,
    }),
    listModels: async () => [
      {
        className: 'Post',
        filePath: 'app/Models/Post.ts',
        tableName: 'posts',
        relationships: [{ name: 'author', type: 'belongsTo', relatedModel: 'User' }],
        usesAuth: false,
        hasSoftDeletes: true,
      },
      {
        className: 'User',
        filePath: 'app/Models/User.ts',
        tableName: 'users',
        relationships: [{ name: 'posts', type: 'hasMany', relatedModel: 'Post' }],
        usesAuth: true,
        hasSoftDeletes: false,
      },
    ],
    generateGuidelines: async () => '# Coding Guidelines\n\nUse PascalCase for classes.',
    runDoctor: async () => ({
      checks: [{ name: 'package.json', status: 'pass' }],
      passCount: 1,
      warnCount: 0,
      failCount: 0,
    }),
    suggestNextSteps: async () => [
      { title: 'Add tests for PostController', priority: 'high' },
    ],
    makeFeature: async (name) => [
      `app/Http/Controllers/${name}Controller.ts`,
      `app/Models/${name}.ts`,
      `resources/js/pages/${name.toLowerCase()}s/Index.tsx`,
    ],
    makeController: async (name) => `app/Http/Controllers/${name}.ts`,
    makeModel: async (name) => `app/Models/${name}.ts`,
    makeView: async (name) => `resources/js/pages/${name}.tsx`,
    makeTest: async (name) => `tests/${name}.test.ts`,
    makeRoute: async (name) => `routes/${name}.ts`,
    generateRouteTypes: record('generateRouteTypes', { definitions: ROUTE_MANIFEST }),
    generatePageTypes: record('generatePageTypes'),
    generateDataTypes: record('generateDataTypes', { definitions: RESOURCE_DEFINITIONS }),
    generateChannelTypes: record('generateChannelTypes'),
    generateApiClientTypes: async (definitions: unknown[], options: CodegenOptions & { resources?: unknown[] }) => {
      calls?.push({ generator: 'generateApiClientTypes', options, definitions })
    },
    ...overrides,
  }
}

let testDir: string

async function createTestClient(overrides: Partial<GurenCliApi> = {}, calls?: CodegenCall[]) {
  const mcpServer = createMcpServer({
    cwd: testDir,
    cli: createMockCli(overrides, calls),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)

  return client
}

describe('Guren MCP Server', () => {
  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'guren-mcp-test-'))
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('lists all tools', async () => {
    const client = await createTestClient()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)

    expect(names).toContain('guren_get_context')
    expect(names).toContain('guren_entity_context')
    expect(names).toContain('guren_check')
    expect(names).toContain('guren_list_models')
    expect(names).toContain('guren_generate_guidelines')
    expect(names).toContain('guren_doctor')
    expect(names).toContain('guren_make_feature')
    expect(names).toContain('guren_make_component')
    expect(names).toContain('guren_codegen')
    expect(names).toContain('guren_agent_surface')
    expect(tools).toHaveLength(10)
  })

  test('guren_docs_graph registers only when the CLI provides it', async () => {
    const bare = await createTestClient()
    const bareNames = (await bare.listTools()).tools.map((tool) => tool.name)
    expect(bareNames).not.toContain('guren_docs_graph')

    const withGraph = await createTestClient({
      buildDocsGraphReport: async () => ({ focus: [], nodes: [], edges: [] }),
      renderDocsGraphMarkdown: () => '# Docs Graph',
    })
    const names = (await withGraph.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('guren_docs_graph')
  })

  test('guren_docs_graph narrows by path and returns markdown by default', async () => {
    const seen: Array<Record<string, unknown>> = []
    const client = await createTestClient({
      buildDocsGraphReport: async (options) => {
        seen.push(options)
        return {
          focus: ['app/Http/Controllers/PostController.ts'],
          nodes: [{ id: 'docs/adr/0001-posts.md', kind: 'doc', label: 'Posts are public' }],
          edges: [
            {
              from: 'docs/adr/0001-posts.md',
              to: 'app/Http/Controllers/PostController.ts',
              relation: 'governs',
              verdict: 'pass',
            },
          ],
        }
      },
      renderDocsGraphMarkdown: (report) =>
        `# Docs Graph\nNeighborhood of: ${(report as { focus: string[] }).focus.join(', ')}`,
    })

    const result = await client.callTool({
      name: 'guren_docs_graph',
      arguments: { path: 'app/Http/Controllers/PostController.ts' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text

    expect(seen[0]).toMatchObject({ path: 'app/Http/Controllers/PostController.ts' })
    expect(text).toContain('Neighborhood of: app/Http/Controllers/PostController.ts')
  })

  test('guren_entity_context returns markdown by default', async () => {
    const client = await createTestClient()
    const result = await client.callTool({
      name: 'guren_entity_context',
      arguments: { entity: 'Post' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text

    expect(result.isError).toBeFalsy()
    expect(text).toStartWith('# Post')
  })

  test('guren_entity_context returns JSON when requested', async () => {
    const client = await createTestClient()
    const result = await client.callTool({
      name: 'guren_entity_context',
      arguments: { entity: 'Post', format: 'json' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const parsed = JSON.parse(text)

    expect(parsed.entity).toBe('Post')
    expect(parsed.routes[0].controller.name).toBe('PostController')
  })

  test('guren_entity_context surfaces resolution errors as isError', async () => {
    const client = await createTestClient()
    const result = await client.callTool({
      name: 'guren_entity_context',
      arguments: { entity: 'Ghost' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text

    expect(result.isError).toBe(true)
    expect(text).toContain('Model "Ghost" not found')
  })

  test('guren_get_context returns JSON by default', async () => {
    const client = await createTestClient()
    const result = await client.callTool({ name: 'guren_get_context', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const parsed = JSON.parse(text)

    expect(parsed.framework.name).toBe('guren')
    expect(parsed.models).toHaveLength(2)
    expect(parsed.controllers).toContain('PostController')
  })

  test('guren_get_context returns markdown when requested', async () => {
    const client = await createTestClient()
    const result = await client.callTool({
      name: 'guren_get_context',
      arguments: { format: 'markdown' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text

    expect(text).toStartWith('# Context')
  })

  // The route-shaped half of this tool is proven CLI-side (a real Router
  // through routeDefinitionToContextRoute); what belongs here is the
  // filtering and the reported shape.
  test('guren_agent_surface reports only routes that declare agent metadata', async () => {
    const client = await createTestClient({
      generateContext: async () => ({
        framework: { name: 'guren', version: '0.2.0' },
        models: [],
        routes: [
          { method: 'GET', path: '/posts', name: 'posts.index' },
          {
            method: 'DELETE',
            path: '/posts/:id',
            name: 'posts.destroy',
            agent: { description: 'Delete a post.', destructiveHint: true, approval: 'required' },
            authorization: { ability: 'posts.destroy', abilities: ['posts.destroy'], mode: 'all' },
          },
        ],
        pages: [],
        controllers: [],
        resources: [],
        events: [],
        jobs: [],
        middleware: [],
        listeners: [],
        validators: [],
      }),
    })

    const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const { tools } = JSON.parse(text)

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      toolName: 'posts.destroy',
      method: 'DELETE',
      path: '/posts/:id',
      description: 'Delete a post.',
      approval: 'required',
      annotations: { destructiveHint: true },
      authorization: { ability: 'posts.destroy' },
    })
  })

  // Annotations are reported as declared: the GET → readOnlyHint default is
  // the derivation layer's rule, and a second copy of it here could disagree.
  test('guren_agent_surface fills in no annotation defaults', async () => {
    const client = await createTestClient({
      generateContext: async () => ({
        framework: { name: 'guren', version: '0.2.0' },
        models: [],
        routes: [{ method: 'GET', path: '/posts', name: 'posts.index', agent: {}, summary: 'List posts.' }],
        pages: [],
        controllers: [],
        resources: [],
        events: [],
        jobs: [],
        middleware: [],
        listeners: [],
        validators: [],
      }),
    })

    const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
    const { tools } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    expect(tools[0].annotations).toEqual({})
    // Falls back to the route's OpenAPI description ?? summary.
    expect(tools[0].description).toBe('List posts.')
    expect(tools[0].approval).toBe('not-required')
  })

  // @guren/cli is resolved from the app, so it can predate the field this
  // tool reads — and an older CLI's routes carry no `agent` at all, which is
  // indistinguishable from an app exposing nothing. Reporting an empty list
  // there would answer a question this server cannot answer.
  // The probe reads a field off the @guren/cli module namespace, so a mock
  // spelling it any other way proves only that the mock agrees with itself.
  // This one takes the real module's exports: a rename or a casing slip on
  // either side fails here, which is exactly how the first version of this
  // probe shipped reading a name the CLI never exported.
  test('guren_agent_surface probes the capability the real @guren/cli exports', async () => {
    const cliModule = (await import('@guren/cli')) as Record<string, unknown>

    expect(cliModule.CONTEXT_ROUTE_FEATURES).toEqual(['agent'])

    const client = await createTestClient({
      CONTEXT_ROUTE_FEATURES: cliModule.CONTEXT_ROUTE_FEATURES as readonly string[],
      loadContextRoutes: async () => [
        { method: 'GET', path: '/posts', name: 'posts.index', agent: { description: 'List posts.' } },
      ],
    })

    const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    expect(payload.supported).toBe(true)
    expect(payload.tools).toHaveLength(1)
  })

  // Reading only the routes keeps an interactive, uncached tool off a full
  // project scan; an older CLI without the entry still answers the long way.
  test('guren_agent_surface prefers the routes-only entry over the whole context', async () => {
    const called: string[] = []
    const client = await createTestClient({
      loadContextRoutes: async () => {
        called.push('loadContextRoutes')
        return []
      },
      generateContext: async () => {
        called.push('generateContext')
        throw new Error('should not be reached when the routes-only entry exists')
      },
    })

    await client.callTool({ name: 'guren_agent_surface', arguments: {} })

    expect(called).toEqual(['loadContextRoutes'])
  })

  // A routes file that throws degrades to zero routes. Reporting that as an
  // empty tool surface is the confident-looking "no routes" the CLI's own
  // loader warns about — indistinguishable from an app exposing nothing.
  test('guren_agent_surface reports a route graph that failed to load', async () => {
    const client = await createTestClient({
      loadContextRoutes: async (_cwd, _routesFile, loadErrors) => {
        loadErrors?.push('Cannot find module ./does-not-exist')
        return []
      },
    })

    const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    expect(payload.routesLoaded).toBe(false)
    expect(payload.loadErrors).toEqual(['Cannot find module ./does-not-exist'])
    expect(payload.note).toContain('not evidence')
  })

  // The same degradation through the older whole-context path.
  test('guren_agent_surface carries routesError from the fallback path', async () => {
    const client = await createTestClient({
      loadContextRoutes: undefined,
      generateContext: async () => ({
        framework: { name: 'guren', version: '0.2.0' },
        models: [],
        routes: [],
        routesError: 'boom',
        pages: [],
        controllers: [],
        resources: [],
        events: [],
        jobs: [],
        middleware: [],
        listeners: [],
        validators: [],
      }),
    })

    const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    expect(payload.routesLoaded).toBe(false)
    expect(payload.loadErrors).toEqual(['boom'])
  })

  test('guren_agent_surface says so when the app CLI predates agent metadata', async () => {
    const client = await createTestClient({ CONTEXT_ROUTE_FEATURES: undefined })

    const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    expect(payload.supported).toBe(false)
    expect(payload.tools).toBeUndefined()
    expect(payload.reason).toContain('predates agent route metadata')
  })

  test('guren_check returns check report', async () => {
    const client = await createTestClient()
    const result = await client.callTool({ name: 'guren_check', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const report = JSON.parse(text)

    expect(report.passCount).toBe(1)
    expect(report.warnCount).toBe(1)
    expect(report.failCount).toBe(0)
    expect(report.checks).toHaveLength(2)
  })

  test('guren_list_models returns model info', async () => {
    const client = await createTestClient()
    const result = await client.callTool({ name: 'guren_list_models', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const models = JSON.parse(text)

    expect(models).toHaveLength(2)
    expect(models[0].className).toBe('Post')
    expect(models[0].relationships[0].type).toBe('belongsTo')
    expect(models[1].usesAuth).toBe(true)
  })

  test('guren_generate_guidelines returns markdown', async () => {
    const client = await createTestClient()
    const result = await client.callTool({ name: 'guren_generate_guidelines', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text

    expect(text).toContain('Coding Guidelines')
  })

  test('guren_doctor returns health report', async () => {
    const client = await createTestClient()
    const result = await client.callTool({ name: 'guren_doctor', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const report = JSON.parse(text)

    expect(report.passCount).toBe(1)
  })

  test('guren_doctor with next steps', async () => {
    const client = await createTestClient()
    const result = await client.callTool({
      name: 'guren_doctor',
      arguments: { next: true },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const report = JSON.parse(text)

    expect(report.nextSteps).toBeDefined()
    expect(report.nextSteps[0].title).toContain('Add tests')
  })

  test('guren_make_feature creates files', async () => {
    const client = await createTestClient()
    const result = await client.callTool({
      name: 'guren_make_feature',
      arguments: { name: 'Article' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const data = JSON.parse(text)

    expect(data.created).toHaveLength(3)
    expect(data.created[0]).toContain('ArticleController')
  })

  test('guren_codegen generates manifests', async () => {
    const client = await createTestClient()
    const result = await client.callTool({ name: 'guren_codegen', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    const data = JSON.parse(text)

    expect(data.generated).toContain('.guren/routes.gen.ts')
    expect(data.generated).toContain('.guren/pages.gen.ts')
    expect(data.generated).toContain('types/generated/routes.d.ts')
    expect(data.generated).toContain('.guren/api-client.gen.ts')
    expect(data.skipped).toEqual([])
  })

  test('guren_codegen forces every generator and feeds the client the route manifest', async () => {
    const calls: CodegenCall[] = []
    const client = await createTestClient({}, calls)
    await client.callTool({ name: 'guren_codegen', arguments: {} })

    expect(calls.map((call) => call.generator)).toEqual([
      'generateRouteTypes',
      'generatePageTypes',
      'generateDataTypes',
      'generateChannelTypes',
      'generateApiClientTypes',
    ])
    for (const call of calls) {
      expect(call.options.force).toBe(true)
    }
    expect(calls.at(-1)?.definitions).toEqual(ROUTE_MANIFEST)
    // Resource definitions must ride along, or every `resource` response
    // hint resolves to "unknown Resource" and the regenerated client
    // silently loses its typed json().
    expect((calls.at(-1)?.options as { resources?: unknown[] }).resources).toEqual(RESOURCE_DEFINITIONS)
  })

  test('guren_codegen surfaces generator warnings in the tool payload', async () => {
    const warning = 'Route "posts.search" declares a resource response hint referencing "GhostResource", but no matching Resource class was found in app/Http/Resources — response left untyped.'
    const client = await createTestClient({
      generateApiClientTypes: async () => ({ outputPath: '.guren/api-client.gen.ts', warnings: [warning] }),
    })
    const result = await client.callTool({ name: 'guren_codegen', arguments: {} })
    const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    // The MCP client is the only console this run has — warnings must land
    // in the payload, not on the server process's stderr.
    expect(data.warnings).toEqual([warning])
    expect(data.generated).toContain('.guren/api-client.gen.ts')
  })

  test('guren_codegen skips the API client when route generation failed', async () => {
    const client = await createTestClient({
      generateRouteTypes: async () => {
        throw new Error('routes/web.ts not found')
      },
    })
    const result = await client.callTool({ name: 'guren_codegen', arguments: {} })
    const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    expect(data.generated).not.toContain('.guren/api-client.gen.ts')
    expect(data.skipped).toContainEqual({
      artifacts: ['.guren/api-client.gen.ts'],
      reason: 'route generation produced no manifest to build a client from',
    })
  })

  test('guren_codegen reports a partial failure as an error, with the reason', async () => {
    const client = await createTestClient({
      generateDataTypes: async () => {
        throw new Error('app/Http/Resources not found')
      },
    })
    const result = await client.callTool({ name: 'guren_codegen', arguments: {} })
    const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    expect(result.isError).toBe(true)
    expect(data.generated).toContain('.guren/routes.gen.ts')
    expect(data.skipped).toEqual([
      { artifacts: ['.guren/data.gen.ts'], reason: 'app/Http/Resources not found' },
    ])
  })

  test('guren_codegen skips an artifact a generator reports as empty', async () => {
    const client = await createTestClient({
      generatePageTypes: async () => ({ outputPath: '' }),
    })
    const result = await client.callTool({ name: 'guren_codegen', arguments: {} })
    const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    // Nothing to describe is a shape, not a failure — an app with no page
    // components must not make the whole run report an error.
    expect(result.isError).toBe(false)
    expect(data.generated).not.toContain('.guren/pages.gen.ts')
    expect(data.skipped).toEqual([
      { artifacts: ['.guren/pages.gen.ts'], reason: 'nothing to generate' },
    ])
  })

  test('guren_codegen reports why a generator declined, not just that it wrote nothing', async () => {
    const client = await createTestClient({
      generatePageTypes: async () => ({
        outputPath: '',
        skipped: { message: 'this app has no @guren/inertia-client dependency and no routes/web.ts' },
      }),
    })
    const result = await client.callTool({ name: 'guren_codegen', arguments: {} })
    const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    // "nothing to generate" would be false here — page components were found
    // and deliberately ignored, and the agent that just wrote one is exactly
    // who has to hear that.
    expect(data.skipped).toEqual([
      {
        artifacts: ['.guren/pages.gen.ts'],
        reason: 'this app has no @guren/inertia-client dependency and no routes/web.ts',
      },
    ])
  })

  test('guren_codegen is an error when nothing could be generated', async () => {
    const failing = async () => {
      throw new Error('routes/web.ts not found')
    }
    const client = await createTestClient({
      generateRouteTypes: failing,
      generatePageTypes: failing,
      generateDataTypes: failing,
      generateChannelTypes: failing,
    })
    const result = await client.callTool({ name: 'guren_codegen', arguments: {} })
    const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

    expect(result.isError).toBe(true)
    expect(data.generated).toEqual([])
    // The API client makes a fifth: it has no manifest to work from either.
    expect(data.skipped).toHaveLength(5)
  })

  test('lists resources', async () => {
    const client = await createTestClient()
    const { resources } = await client.listResources()

    expect(resources.map((r) => r.uri)).toContain('guren://context')
    expect(resources.map((r) => r.uri)).toContain('guren://guidelines')
  })

  test('reads context resource', async () => {
    const client = await createTestClient()
    const result = await client.readResource({ uri: 'guren://context' })
    const text = (result.contents[0] as { text: string }).text
    const parsed = JSON.parse(text)

    expect(parsed.framework.name).toBe('guren')
  })

  test('lists the entity context resource template', async () => {
    const client = await createTestClient()
    const { resourceTemplates } = await client.listResourceTemplates()

    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('guren://context/{entity}')
  })

  test('reads entity context through the resource template', async () => {
    const client = await createTestClient()
    const result = await client.readResource({ uri: 'guren://context/Post' })
    const text = (result.contents[0] as { text: string }).text

    expect(text).toStartWith('# Post')
  })

  test('reads guidelines resource', async () => {
    const client = await createTestClient()
    const result = await client.readResource({ uri: 'guren://guidelines' })
    const text = (result.contents[0] as { text: string }).text

    expect(text).toContain('Coding Guidelines')
  })

  test('lists prompts', async () => {
    const client = await createTestClient()
    const { prompts } = await client.listPrompts()
    const names = prompts.map((p) => p.name)

    expect(names).toContain('guren_review')
    expect(names).toContain('guren_plan_feature')
  })

  test('guren_review prompt includes context', async () => {
    const client = await createTestClient()
    const result = await client.getPrompt({ name: 'guren_review', arguments: {} })

    expect(result.messages).toHaveLength(1)
    const text = (result.messages[0].content as { type: string; text: string }).text
    expect(text).toContain('project naming conventions')
    expect(text).toContain('Framework: guren')
  })

  test('guren_plan_feature prompt includes models', async () => {
    const client = await createTestClient()
    const result = await client.getPrompt({
      name: 'guren_plan_feature',
      arguments: { feature: 'Comment system with threading' },
    })

    expect(result.messages).toHaveLength(1)
    const text = (result.messages[0].content as { type: string; text: string }).text
    expect(text).toContain('Comment system with threading')
    expect(text).toContain('Post')
    expect(text).toContain('belongsTo(author)')
  })
})
