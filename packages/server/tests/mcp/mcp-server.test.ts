import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../src/mcp/create-mcp-server'
import type { GurenCliApi } from '../../src/mcp/create-mcp-server'

function createMockCli(): GurenCliApi {
  return {
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
    generateRouteTypes: async () => {},
    generatePageTypes: async () => {},
    generateDataTypes: async () => {},
    generateChannelTypes: async () => {},
  }
}

let testDir: string

async function createTestClient() {
  const mcpServer = createMcpServer({
    cwd: testDir,
    cli: createMockCli(),
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
    expect(tools).toHaveLength(9)
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
