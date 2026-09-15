import { describe, expect, test } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { createDevMcpHandler, type DevMcpHandler } from '../src/dev-mcp/handler'
import type { DevMcpApi, DevMcpCodegenOptions } from '../src/dev-mcp/server'

const ENDPOINT = 'http://127.0.0.1:3333/_guren/mcp'

function createMockApi(overrides: Partial<DevMcpApi> = {}): DevMcpApi {
  const context = {
    framework: { name: 'guren', version: '0.2.0' },
    models: [{ className: 'Post' }],
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
  }

  return {
    generateContext: async () => context,
    renderContextMarkdown: () => '# Context',
    generateEntityContext: async (entity) => {
      if (entity.toLowerCase() !== 'post') throw new Error(`Model "${entity}" not found.`)
      return { entity: 'Post' }
    },
    renderEntityContextMarkdown: () => '# Post',
    loadContextRoutes: async () => context.routes,
    runCheck: async () => ({ cwd: '/app', checks: [], passCount: 1, warnCount: 0, failCount: 0 }),
    runGate: async () => ({ ok: true }),
    listModels: async () => [{ className: 'Post', tableName: 'posts', relationships: [] }],
    generateGuidelines: async () => '# Guidelines',
    runDoctor: async () => ({ checks: [] }),
    suggestNextSteps: async () => [],
    makeFeature: async (name) => [`app/Models/${name}.ts`],
    makeController: async (name) => `app/Http/Controllers/${name}.ts`,
    makeModel: async (name) => `app/Models/${name}.ts`,
    makeView: async (name) => `resources/js/pages/${name}.tsx`,
    makeTest: async (name) => `tests/${name}.test.ts`,
    makeRoute: async (name) => `routes/${name}.ts`,
    generateRouteTypes: async (_: DevMcpCodegenOptions) => ({ definitions: [] }),
    generatePageTypes: async () => undefined,
    generateDataTypes: async () => ({ definitions: [] }),
    generateChannelTypes: async () => undefined,
    generateAgentTypes: async () => undefined,
    generateApiClientTypes: async () => undefined,
    buildDocsGraphReport: async () => ({ nodes: [], edges: [] }),
    renderDocsGraphMarkdown: () => '# Docs graph',
    ...overrides,
  }
}

function transportTo(handler: DevMcpHandler) {
  return new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  })
}

async function connect(handler: DevMcpHandler, era: 'modern' | 'legacy'): Promise<Client> {
  const client = new Client(
    { name: 'dev-mcp-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  )
  await client.connect(transportTo(handler))
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as Array<{ type: string; text?: string }>
  return first?.text ?? ''
}

describe('createDevMcpHandler', () => {
  for (const era of ['modern', 'legacy'] as const) {
    describe(`${era} client`, () => {
      test('negotiates the era it asked for', async () => {
        const handler = createDevMcpHandler({ cwd: '/app', api: createMockApi() })
        const client = await connect(handler, era)

        expect(client.getProtocolEra()).toBe(era)

        await client.close()
        await handler.close()
      })

      test('lists the Dev MCP tools', async () => {
        const handler = createDevMcpHandler({ cwd: '/app', api: createMockApi() })
        const client = await connect(handler, era)

        const { tools } = await client.listTools()
        const names = tools.map((tool) => tool.name)

        expect(names).toEqual(
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
        const handler = createDevMcpHandler({
          cwd: '/projects/blog',
          api: createMockApi({
            runCheck: async ({ cwd }) => {
              seen.push(cwd)
              return { cwd, checks: [], passCount: 3, warnCount: 0, failCount: 0 }
            },
          }),
        })
        const client = await connect(handler, era)

        const result = await client.callTool({ name: 'guren_check', arguments: {} })

        expect(seen).toEqual(['/projects/blog'])
        expect(JSON.parse(textOf(result))).toMatchObject({ passCount: 3 })

        await client.close()
        await handler.close()
      })

      test('reports a thrown lookup as a tool error, not a protocol failure', async () => {
        const handler = createDevMcpHandler({ cwd: '/app', api: createMockApi() })
        const client = await connect(handler, era)

        const result = await client.callTool({
          name: 'guren_entity_context',
          arguments: { entity: 'Invoice' },
        })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toContain('Model "Invoice" not found.')

        await client.close()
        await handler.close()
      })

      test('reads the agent surface from the loaded routes', async () => {
        const handler = createDevMcpHandler({ cwd: '/app', api: createMockApi() })
        const client = await connect(handler, era)

        const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
        const payload = JSON.parse(textOf(result)) as { routesLoaded: boolean; tools: Array<{ toolName: string }> }

        expect(payload.routesLoaded).toBe(true)
        expect(payload.tools.map((tool) => tool.toolName)).toEqual(['posts.store'])

        await client.close()
        await handler.close()
      })
    })
  }

  test('answers a GET with 405, since there is no session stream to open', async () => {
    const handler = createDevMcpHandler({ cwd: '/app', api: createMockApi() })

    const response = await handler.fetch(new Request(ENDPOINT, { method: 'GET' }))

    expect(response.status).toBe(405)
    await handler.close()
  })

  test('marks a route list that failed to load as incomplete', async () => {
    const handler = createDevMcpHandler({
      cwd: '/app',
      api: createMockApi({
        loadContextRoutes: async (_cwd, _routesFile, loadErrors) => {
          loadErrors?.push('routes/web.ts threw: boom')
          return []
        },
      }),
    })
    const client = await connect(handler, 'modern')

    const result = await client.callTool({ name: 'guren_agent_surface', arguments: {} })
    const payload = JSON.parse(textOf(result)) as { routesLoaded: boolean; loadErrors: string[] }

    expect(payload.routesLoaded).toBe(false)
    expect(payload.loadErrors).toEqual(['routes/web.ts threw: boom'])

    await client.close()
    await handler.close()
  })
})
