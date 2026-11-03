import { describe, test, expect, beforeAll } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  Controller,
  EventServiceProvider,
  MemoryApiTokenStore,
  createApiToken,
  createApp,
  type Application,
  type Router,
} from '@guren/core'

import { mcpPlugin } from './plugin'

class PostController extends Controller {
  async show() {
    return this.inertia('posts/Show', { post: { id: Number(this.ctx.req.param('id')), title: 'Hello' } })
  }
}

const SHOW_HTML = '<!DOCTYPE html><html><body>posts/Show</body></html>'

/**
 * MCP Apps on the App MCP endpoint (RFC 0038), end to end through the SDK's
 * own client: the tool metadata, the `ui://` resources, the result `_meta`,
 * and the shared props a tool call carries.
 */
describe('mcpPlugin MCP Apps (RFC 0038)', () => {
  const store = new MemoryApiTokenStore()
  let app: Application
  let token: string
  let narrowToken: string

  function registerRoutes(router: Router): void {
    router.get('/posts/:id', [PostController, 'show']).name('posts.show').agent({ ui: 'posts/Show' })
    router
      .put('/posts/:id', () => new Response(null, { status: 303, headers: { Location: '/posts/1' } }))
      .name('posts.update')
      .agent({ ui: { visibility: ['app'] } })
    router.get('/drafts/:id', () => Response.json({})).name('drafts.show').agent({ ui: 'drafts/Show' })
  }

  beforeAll(async () => {
    app = createApp({
      routes: registerRoutes,
      inertia: { share: () => ({ appName: 'Blog', auth: { user: { email: 'owner@example.com' } } }) },
      providers: [
        EventServiceProvider,
        mcpPlugin({
          ui: {
            pages: () => ({ mcpAppPages: { 'posts/Show': { html: SHOW_HTML, hash: 'abc123' } } }),
            presentation: { 'posts/Show': { prefersBorder: true } },
            sharedProps: ['appName'],
          },
        }),
      ],
    })
    app.auth.useTokens(store)
    await app.boot()

    const issued = await createApiToken(store, { name: 'test', userId: 42, abilities: ['tools:*'] })
    token = issued.plainTextToken
    const narrow = await createApiToken(store, { name: 'narrow', userId: 42, abilities: ['tool:posts.update'] })
    narrowToken = narrow.plainTextToken
  })

  async function connectClient(bearer: string = token): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    const client = new Client({ name: 'mcp-apps', version: '1.0.0' })
    await client.connect(transport)
    return client
  }

  test('publishes no page to a token that can call no tool naming it', async () => {
    const client = await connectClient(narrowToken)
    const { resources } = await client.listResources()
    expect(resources.map((resource) => resource.uri)).toEqual(['ui://guren-app/bridge'])
    await expect(client.readResource({ uri: 'ui://guren-app/pages/posts/Show?v=abc123' })).rejects.toThrow()

    const { contents } = await client.readResource({ uri: 'ui://guren-app/bridge' })
    const catalogue = JSON.parse((contents[0] as { text: string }).text) as { tools: Array<{ toolName: string }> }
    expect(catalogue.tools.map((tool) => tool.toolName)).toEqual(['posts.update'])
  })

  test('advertises resources and the extension', async () => {
    const client = await connectClient()
    const capabilities = client.getServerCapabilities()
    expect(capabilities?.resources).toBeDefined()
    expect(capabilities?.extensions?.['io.modelcontextprotocol/ui']).toEqual({})
  })

  test('links a tool to its built page and keeps visibility where no page was built', async () => {
    const client = await connectClient()
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    const uri = 'ui://guren-app/pages/posts/Show?v=abc123'
    expect(byName.get('posts.show')?._meta).toEqual({
      ui: { resourceUri: uri, visibility: ['model', 'app'] },
      'ui/resourceUri': uri,
    })
    expect(byName.get('posts.update')?._meta).toEqual({ ui: { visibility: ['app'] } })
    expect(byName.get('drafts.show')?._meta).toEqual({ ui: { visibility: ['model', 'app'] } })
  })

  test('lists the built page and the bridge catalogue', async () => {
    const client = await connectClient()
    const { resources } = await client.listResources()
    expect(resources.map((resource) => resource.uri)).toEqual([
      'ui://guren-app/pages/posts/Show?v=abc123',
      'ui://guren-app/bridge',
    ])
  })

  test('reads the page document with its presentation', async () => {
    const client = await connectClient()
    const { contents } = await client.readResource({ uri: 'ui://guren-app/pages/posts/Show?v=abc123' })
    expect(contents[0]).toMatchObject({
      mimeType: 'text/html;profile=mcp-app',
      text: SHOW_HTML,
      _meta: { ui: { csp: {}, prefersBorder: true } },
    })
  })

  test('refuses a page URI naming another build', async () => {
    const client = await connectClient()
    await expect(client.readResource({ uri: 'ui://guren-app/pages/posts/Show?v=stale' })).rejects.toThrow()
  })

  test('serves the bridge catalogue for the tools the caller can call', async () => {
    const client = await connectClient()
    const { contents } = await client.readResource({ uri: 'ui://guren-app/bridge' })
    const catalogue = JSON.parse((contents[0] as { text: string }).text) as { tools: Array<Record<string, unknown>> }
    expect(catalogue.tools.find((tool) => tool.toolName === 'posts.update')).toEqual({
      toolName: 'posts.update',
      method: 'PUT',
      path: '/posts/:id',
      inputSources: { id: 'path' },
      inputBodyNested: false,
      bridgeable: true,
    })
  })

  test('returns the Inertia page and the outcome in the result _meta', async () => {
    const client = await connectClient()
    const result = await client.callTool({ name: 'posts.show', arguments: { id: '1' } })
    const meta = result._meta as Record<string, Record<string, unknown>>

    expect(meta['dev.guren/response']).toEqual({ outcome: 'executed', status: 200, url: 'http://localhost/posts/1' })
    expect(meta['dev.guren/inertia-page']).toMatchObject({
      component: 'posts/Show',
      url: '/posts/1',
      props: { post: { id: 1, title: 'Hello' }, appName: 'Blog' },
    })
  })

  test('withholds shared props the app did not name, from the view and the model alike', async () => {
    const client = await connectClient()
    const result = await client.callTool({ name: 'posts.show', arguments: { id: '1' } })
    const page = (result._meta as Record<string, { props: Record<string, unknown> }>)['dev.guren/inertia-page']!
    const text = (result.content as Array<{ text: string }>)[0]!.text

    expect(page.props.auth).toBeUndefined()
    expect(JSON.parse(text).auth).toBeUndefined()
    expect(JSON.parse(text).appName).toBe('Blog')
  })

  test('reports a redirect as an absolute location', async () => {
    const client = await connectClient()
    const result = await client.callTool({ name: 'posts.update', arguments: { id: '1' } })
    expect((result._meta as Record<string, unknown>)['dev.guren/response']).toEqual({
      outcome: 'executed',
      status: 303,
      location: 'http://localhost/posts/1',
    })
  })

  test('still serves the shared props an ordinary browser request asks for', async () => {
    const response = await app.fetch(new Request('http://localhost/posts/1', { headers: { Accept: 'application/json' } }))
    const page = await response.json() as { props: Record<string, unknown> }
    expect(page.props.auth).toEqual({ user: { email: 'owner@example.com' } })
  })
})
