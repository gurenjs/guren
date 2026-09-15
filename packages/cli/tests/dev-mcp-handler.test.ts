import { describe, expect, test } from 'bun:test'

import { createDevMcpHandler, type DevMcpHandler } from '../src/dev-mcp/handler'
import type { DevMcpApi } from '../src/dev-mcp/server'
import type { EntityContext } from '../src/entity-context'
import type { ModelInfo } from '../src/model-parser'
import type { ProjectContext } from '../src/context'
import {
  connectDevMcpClient,
  DEV_MCP_ENDPOINT,
  toolText,
  type ProtocolEra,
} from './dev-mcp-client'

const POST_MODEL: ModelInfo = {
  className: 'Post',
  filePath: 'app/Models/Post.ts',
  tableName: 'posts',
  relationships: [{ name: 'author', type: 'belongsTo', relatedModel: 'User' }],
  usesAuth: false,
  hasSoftDeletes: false,
  attachments: null,
  fillable: null,
  hidden: null,
  visible: null,
  casts: null,
  docsTags: [],
}

const PROJECT_CONTEXT: ProjectContext = {
  framework: { name: 'guren', version: '0.2.0' },
  models: [POST_MODEL],
  routes: [
    { method: 'GET', path: '/posts', name: 'posts.index' },
    {
      method: 'POST',
      path: '/posts',
      name: 'posts.store',
      agent: { description: 'Create a post.', destructiveHint: false },
    },
  ],
  pages: ['posts/Index'],
  controllers: ['PostController'],
  resources: [],
  events: [],
  jobs: [],
  middleware: [],
  listeners: [],
  validators: [],
  policies: [],
  commands: [],
}

const ENTITY_CONTEXT: EntityContext = {
  entity: 'Post',
  model: {
    filePath: 'app/Models/Post.ts',
    tableName: 'posts',
    relationships: [],
    attachments: [],
    attachmentsUnreadable: false,
    usesAuth: false,
    hasSoftDeletes: false,
    fillable: POST_MODEL.fillable,
    hidden: POST_MODEL.hidden,
    visible: POST_MODEL.visible,
    casts: POST_MODEL.casts,
  },
  referencedBy: [],
  routes: [],
  unverifiedRoutes: [],
  pages: [],
  factories: [],
  seeders: [],
  tests: [],
  docs: [],
  issues: [],
}

function createMockApi(overrides: Partial<DevMcpApi> = {}): DevMcpApi {
  return {
    generateContext: async () => PROJECT_CONTEXT,
    renderContextMarkdown: () => '# Context',
    generateEntityContext: async (entity) => {
      if (entity.toLowerCase() !== 'post') throw new Error(`Model "${entity}" not found.`)
      return ENTITY_CONTEXT
    },
    renderEntityContextMarkdown: (ctx) => `# ${ctx.entity}`,
    loadContextRoutes: async () => PROJECT_CONTEXT.routes,
    runCheck: async ({ cwd }) => ({ cwd, checks: [], passCount: 1, warnCount: 0, failCount: 0 }),
    runGate: async ({ cwd, changed }) => ({ cwd, ok: true, changed: changed ?? false, stages: [] }),
    listModels: async () => [POST_MODEL],
    generateGuidelines: async () => '# Guidelines',
    runDoctor: async ({ cwd }) => ({
      cwd,
      checks: [],
      fixableChecks: [],
      manualChecks: [],
      hasWarnings: false,
      hasFailures: false,
      recommendedCommands: [],
    }),
    suggestNextSteps: async () => [],
    makeFeature: async (name) => [`app/Models/${name}.ts`],
    makeController: async (name) => `app/Http/Controllers/${name}.ts`,
    makeModel: async (name) => `app/Models/${name}.ts`,
    makeView: async (name) => `resources/js/pages/${name}.tsx`,
    makeTest: async (name) => `tests/${name}.test.ts`,
    generateRouteTypes: async () => ({ outputPath: '.guren/routes.gen.ts', definitions: [] }),
    generatePageTypes: async () => ({ outputPath: '.guren/pages.gen.ts' }),
    generateDataTypes: async () => ({ outputPath: '.guren/data.gen.ts', definitions: [] }),
    generateChannelTypes: async () => ({ outputPath: '.guren/channels.gen.ts' }),
    generateAgentTypes: async () => ({ outputPath: '.guren/agents.gen.ts' }),
    generateApiClientTypes: async () => ({ outputPath: '.guren/api-client.gen.ts' }),
    buildDocsGraphReport: async () => ({ nodes: [], edges: [], focus: [] }),
    renderDocsGraphMarkdown: () => '# Docs graph',
    ...overrides,
  }
}

function handlerWith(overrides: Partial<DevMcpApi> = {}, cwd = '/app'): DevMcpHandler {
  return createDevMcpHandler({ cwd, api: createMockApi(overrides) })
}

const connect = (handler: DevMcpHandler, era: ProtocolEra) =>
  connectDevMcpClient((request) => handler.fetch(request), era)

describe('createDevMcpHandler', () => {
  for (const era of ['modern', 'legacy'] as const) {
    describe(`${era} client`, () => {
      test('negotiates the era it asked for', async () => {
        const handler = handlerWith()
        const client = await connect(handler, era)

        expect(client.getProtocolEra()).toBe(era)

        await client.close()
        await handler.close()
      })

      test('lists the Dev MCP tools', async () => {
        const handler = handlerWith()
        const client = await connect(handler, era)

        const { tools } = await client.listTools()

        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining([
            'guren_get_context',
            'guren_entity_context',
            'guren_docs_graph',
            'guren_agent_surface',
            'guren_check',
            'guren_gate',
            'guren_codegen',
          ]),
        )
        const entity = tools.find((tool) => tool.name === 'guren_entity_context')
        expect(entity?.inputSchema.properties).toHaveProperty('entity')

        await client.close()
        await handler.close()
      })

      test('calls a tool with the cwd it was built for', async () => {
        const seen: string[] = []
        const handler = handlerWith(
          {
            runCheck: async ({ cwd }) => {
              seen.push(cwd)
              return { cwd, checks: [], passCount: 3, warnCount: 0, failCount: 0 }
            },
          },
          '/projects/blog',
        )
        const client = await connect(handler, era)

        const result = await client.callTool({ name: 'guren_check', arguments: {} })

        expect(seen).toEqual(['/projects/blog'])
        expect(JSON.parse(toolText(result))).toMatchObject({ passCount: 3 })

        await client.close()
        await handler.close()
      })

      test('reports a thrown lookup as a tool error, not a protocol failure', async () => {
        const handler = handlerWith()
        const client = await connect(handler, era)

        const result = await client.callTool({
          name: 'guren_entity_context',
          arguments: { entity: 'Invoice' },
        })

        expect(result.isError).toBe(true)
        expect(toolText(result)).toContain('Model "Invoice" not found.')

        await client.close()
        await handler.close()
      })

      test('reads the agent surface from the loaded routes', async () => {
        const handler = handlerWith()
        const client = await connect(handler, era)

        const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
        const payload = JSON.parse(toolText(result)) as {
          routesLoaded: boolean
          tools: Array<{ toolName: string }>
        }

        expect(payload.routesLoaded).toBe(true)
        expect(payload.tools.map((tool) => tool.toolName)).toEqual(['posts.store'])

        await client.close()
        await handler.close()
      })

      // The SDK reshaped both registrations in v2 (`registerPrompt` takes a config
      // object, `registerResource` a metadata argument); a wrong shape registers
      // fine and fails only when a client asks for it.
      test('answers its prompts', async () => {
        const handler = handlerWith()
        const client = await connect(handler, era)

        const { prompts } = await client.listPrompts()
        expect(prompts.map((prompt) => prompt.name)).toEqual(
          expect.arrayContaining(['guren_review', 'guren_plan_feature']),
        )

        const review = await client.getPrompt({ name: 'guren_review', arguments: {} })
        expect(JSON.stringify(review.messages)).toContain('Review the recent code changes')

        const plan = await client.getPrompt({
          name: 'guren_plan_feature',
          arguments: { feature: 'comments' },
        })
        expect(JSON.stringify(plan.messages)).toContain('Plan the implementation of: comments')

        await client.close()
        await handler.close()
      })

      test('serves its resources, including the entity template', async () => {
        const handler = handlerWith()
        const client = await connect(handler, era)

        const { resources } = await client.listResources()
        expect(resources.map((resource) => resource.uri)).toEqual(
          expect.arrayContaining(['guren://context', 'guren://guidelines']),
        )

        const context = await client.readResource({ uri: 'guren://context' })
        expect(JSON.stringify(context.contents)).toContain('guren')

        const { resourceTemplates } = await client.listResourceTemplates()
        expect(resourceTemplates.map((template) => template.uriTemplate)).toContain(
          'guren://context/{entity}',
        )

        const entity = await client.readResource({ uri: 'guren://context/Post' })
        expect(JSON.stringify(entity.contents)).toContain('# Post')

        await client.close()
        await handler.close()
      })
    })
  }

  test('answers a GET with 405, since there is no session stream to open', async () => {
    const handler = handlerWith()

    const response = await handler.fetch(new Request(DEV_MCP_ENDPOINT, { method: 'GET' }))

    expect(response.status).toBe(405)
    await handler.close()
  })

  test('marks a route list that failed to load as incomplete', async () => {
    const handler = handlerWith({
      loadContextRoutes: async (_cwd, _routesFile, loadErrors) => {
        loadErrors?.push('routes/web.ts threw: boom')
        return []
      },
    })
    const client = await connect(handler, 'modern')

    const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
    const payload = JSON.parse(toolText(result)) as { routesLoaded: boolean; loadErrors: string[] }

    expect(payload.routesLoaded).toBe(false)
    expect(payload.loadErrors).toEqual(['routes/web.ts threw: boom'])

    await client.close()
    await handler.close()
  })
})
