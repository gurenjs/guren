import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpCancelledError, type HttpRequestConfig, type Page } from '@inertiajs/core'
import * as realInertiaReact from '@inertiajs/react'
import type { BridgeDeps, BridgeTool, ToolResultLike } from '../src/mcp-app-bridge'

let capturedOptions: Record<string, unknown> | undefined
const createInertiaAppMock = mock(async (options: Record<string, unknown>) => {
  capturedOptions = options
  return undefined
})
// Spread the real module: mock.module() is process-wide, as app.test.ts notes.
await mock.module('@inertiajs/react', () => ({ ...realInertiaReact, createInertiaApp: createInertiaAppMock }))

const { BridgeCatalogue, createMcpAppHttpClient, MCP_APP_CONTRACT, planVisit } = await import('../src/mcp-app-bridge')
const { installMemoryHistory } = await import('../src/mcp-app-history')
const { startMcpApp } = await import('../src/mcp-app')

const SANDBOX = 'https://abc123.claudemcpcontent.com'
const APP = 'https://blog.example.com'
const origins = { sandbox: SANDBOX, app: APP }

const tool = (toolName: string, method: string, path: string, extra: Partial<BridgeTool> = {}): BridgeTool => ({
  toolName,
  method,
  path,
  inputSources: {},
  inputBodyNested: false,
  bridgeable: true,
  ...extra,
})

const TOOLS = [
  tool('posts.show', 'GET', '/posts/:id', { inputSources: { id: 'path' } }),
  tool('posts.update', 'PUT', '/posts/:id', { inputSources: { id: 'path', title: 'body' } }),
  tool('posts.store', 'POST', '/posts', { inputSources: { title: 'body' } }),
  tool('posts.tags', 'PUT', '/posts/:id/tags', { inputBodyNested: true }),
  tool('posts.clash', 'POST', '/clash/:id', { bridgeable: false }),
]
const catalogue = new BridgeCatalogue(TOOLS)

const page = (component: string, url: string, props: Record<string, unknown> = {}): Page =>
  ({ component, url, props: { errors: {}, ...props }, version: 'v1' }) as unknown as Page

const executed = (response: Record<string, unknown>, inertiaPage?: Page): ToolResultLike => ({
  content: [{ type: 'text', text: '{}' }],
  _meta: {
    'dev.guren/response': { contract: MCP_APP_CONTRACT, bridge: 'ui://blog/bridge', outcome: 'executed', ...response },
    ...(inertiaPage ? { 'dev.guren/inertia-page': inertiaPage } : {}),
  },
})

describe('MCP_APP_CONTRACT', () => {
  it('matches the contract @guren/plugin-mcp writes', () => {
    const source = readFileSync(join(import.meta.dir, '../../plugin-mcp/src/mcp-apps.ts'), 'utf8')
    expect(Number(/export const MCP_APP_CONTRACT = (\d+)/.exec(source)?.[1])).toBe(MCP_APP_CONTRACT)
  })
})

describe('planVisit', () => {
  it('reads a visit on the sandbox origin as the app path Inertia resolved it from', () => {
    const plan = planVisit(catalogue, 'get', `${SANDBOX}/posts/12?tag=a&tag=b`, undefined, origins)
    expect(plan).toMatchObject({ kind: 'call', tool: { toolName: 'posts.show' }, arguments: { id: '12', tag: ['a', 'b'] } })
  })

  it('takes the application origin as the same app', () => {
    expect(planVisit(catalogue, 'get', `${APP}/posts/3`, undefined, origins)).toMatchObject({ kind: 'call', arguments: { id: '3' } })
  })

  it('reads another origin as external', () => {
    expect(planVisit(catalogue, 'get', 'https://elsewhere.example/x', undefined, origins)).toEqual({
      kind: 'external',
      method: 'GET',
      url: 'https://elsewhere.example/x',
    })
  })

  it('merges a JSON body and honours a spoofed method', () => {
    const plan = planVisit(catalogue, 'post', '/posts/12', { _method: 'put', title: 'New' }, origins)
    expect(plan).toMatchObject({ kind: 'call', method: 'PUT', tool: { toolName: 'posts.update' }, arguments: { id: '12', title: 'New' } })
    expect((plan as { arguments: Record<string, unknown> }).arguments).not.toHaveProperty('_method')
  })

  it('passes a nested body under "body"', () => {
    const plan = planVisit(catalogue, 'put', '/posts/1/tags', ['a', 'b'], origins)
    expect(plan).toMatchObject({ kind: 'call', arguments: { id: '1', body: ['a', 'b'] } })
  })

  it('refuses a tool with colliding inputs, a file, and any visit without a catalogue', () => {
    expect(planVisit(catalogue, 'post', '/clash/1', { id: 2 }, origins).kind).toBe('unmatched')
    expect(planVisit(catalogue, 'post', '/posts', { cover: new Blob(['x']) }, origins).kind).toBe('unmatched')
    expect(planVisit(undefined, 'get', '/posts/1', undefined, origins)).toMatchObject({ kind: 'unmatched', reason: 'read-only' })
  })

  it('picks the first tool registered for a path two tools match', () => {
    const first = new BridgeCatalogue([tool('posts.mine', 'GET', '/posts/mine'), tool('posts.show', 'GET', '/posts/:id')])
    expect(planVisit(first, 'get', '/posts/mine', undefined, origins)).toMatchObject({ tool: { toolName: 'posts.mine' } })
  })
})

describe('createMcpAppHttpClient', () => {
  let calls: Array<{ name: string; args: Record<string, unknown> }>
  let handOffs: string[]
  let pending: unknown[]
  let answers: Map<string, ToolResultLike | ((args: Record<string, unknown>) => ToolResultLike)>
  let current: Page

  const deps = (overrides: Partial<BridgeDeps> = {}): BridgeDeps => ({
    call: async (name, args) => {
      calls.push({ name, args })
      const answer = answers.get(name)
      if (!answer) throw new Error(`no answer for ${name}`)
      return typeof answer === 'function' ? answer(args) : answer
    },
    catalogue: () => catalogue,
    origins: () => origins,
    currentPage: () => current,
    hasComponent: async (name) => name.startsWith('posts/'),
    handOff: (url) => handOffs.push(url),
    pendingApproval: (visit) => pending.push(visit),
    ...overrides,
  })

  const send = (config: Partial<HttpRequestConfig> & { url: string }) =>
    createMcpAppHttpClient(deps()).request({ method: 'get', ...config } as HttpRequestConfig)

  beforeEach(() => {
    calls = []
    handOffs = []
    pending = []
    answers = new Map()
    current = page('posts/Show', '/posts/12', { post: { id: 12 } })
  })

  it('answers a visit with the page the tool rendered, on the current asset version', async () => {
    answers.set('posts.show', executed({ status: 200, url: `${APP}/posts/13` }, { ...page('posts/Show', '/posts/13'), version: 'other' }))
    const response = await send({ url: `${SANDBOX}/posts/13` })
    expect(response.headers['x-inertia']).toBe('true')
    expect(JSON.parse(response.data)).toMatchObject({ component: 'posts/Show', url: '/posts/13', version: 'v1' })
    expect(calls).toEqual([{ name: 'posts.show', args: { id: '13' } }])
  })

  it('follows a 303 as a GET and a 307 with the same method and body', async () => {
    answers.set('posts.store', executed({ status: 303, location: `${APP}/posts/40` }))
    answers.set('posts.show', (args) => executed({ status: 200, url: `${APP}/posts/${args.id}` }, page('posts/Show', `/posts/${args.id}`)))
    const response = await send({ method: 'post', url: '/posts', data: { title: 'T' } })
    expect(JSON.parse(response.data).url).toBe('/posts/40')
    expect(calls.map((call) => call.name)).toEqual(['posts.store', 'posts.show'])

    calls = []
    answers.set('posts.update', (args) => args.id === '1'
      ? executed({ status: 307, location: `${APP}/posts/2` })
      : executed({ status: 200, url: `${APP}/posts/2` }, page('posts/Show', '/posts/2')))
    await send({ method: 'put', url: '/posts/1', data: { title: 'T' } })
    expect(calls).toEqual([
      { name: 'posts.update', args: { id: '1', title: 'T' } },
      { name: 'posts.update', args: { id: '2', title: 'T' } },
    ])
  })

  it('hands a redirect off the application to the browser without changing the page', async () => {
    answers.set('posts.store', executed({ status: 302, location: 'https://pay.example/checkout' }))
    await expect(send({ method: 'post', url: '/posts', data: {} })).rejects.toBeInstanceOf(HttpCancelledError)
    expect(handOffs).toEqual(['https://pay.example/checkout'])
  })

  it('reports a 422 on the current page, one message per field, under the error bag', async () => {
    answers.set('posts.update', executed({ status: 422, errors: { title: ['Required.', 'Too short.'] } }))
    const response = await send({ method: 'put', url: '/posts/12', data: {}, headers: { 'X-Inertia-Error-Bag': 'edit' } })
    expect(JSON.parse(response.data)).toMatchObject({
      component: 'posts/Show',
      url: '/posts/12',
      props: { post: { id: 12 }, errors: { edit: { title: 'Required.' } } },
    })
  })

  it('holds a visit that waits for approval and reports other refusals as errors', async () => {
    answers.set('posts.update', {
      _meta: {
        'dev.guren/response': {
          contract: MCP_APP_CONTRACT,
          outcome: 'denied',
          reason: 'approval',
          message: 'Waiting for approval.',
          approval: { requestId: 'req-1', status: 'pending' },
        },
      },
    })
    await expect(send({ method: 'put', url: '/posts/12', data: { title: 'T' } })).rejects.toBeInstanceOf(HttpCancelledError)
    expect(pending).toEqual([{ requestId: 'req-1', toolName: 'posts.update', method: 'put', url: '/posts/12', data: { title: 'T' } }])

    answers.set('posts.update', { _meta: { 'dev.guren/response': { contract: MCP_APP_CONTRACT, outcome: 'failed', message: 'Boom.' } } })
    const response = await send({ method: 'put', url: '/posts/12', data: {} })
    expect(JSON.parse(response.data).props.errors).toEqual({ mcp: 'Boom.' })
  })

  it('opens an unmatched GET in the browser and refuses an unmatched mutation', async () => {
    await expect(send({ url: '/admin' })).rejects.toBeInstanceOf(HttpCancelledError)
    expect(handOffs).toEqual([`${APP}/admin`])
    const response = await send({ method: 'delete', url: '/posts/12' })
    expect(JSON.parse(response.data).props.errors.mcp).toContain('not available here')
    expect(calls).toEqual([])
  })

  it('hands off a page this document does not bundle, and a result on another contract', async () => {
    answers.set('posts.show', executed({ status: 200, url: `${APP}/users/1` }, page('users/Show', '/users/1')))
    await expect(send({ url: '/posts/1' })).rejects.toBeInstanceOf(HttpCancelledError)
    answers.set('posts.show', { _meta: { 'dev.guren/response': { contract: MCP_APP_CONTRACT + 1, outcome: 'executed', status: 200 } } })
    await expect(send({ url: '/posts/2' })).rejects.toBeInstanceOf(HttpCancelledError)
    expect(handOffs).toEqual([`${APP}/users/1`, `${APP}/posts/2`])
  })
})

describe('installMemoryHistory', () => {
  function fakeTarget() {
    const location = { href: `${SANDBOX}/mcp_apps?stable-origin=true` }
    const events: Event[] = []
    const native = { replaced: [] as string[], pushed: 0, failNext: false }
    const history: { state: unknown; replaceState(state: unknown, title: string, url: string): void; pushState(): void } = {
      state: null as unknown,
      replaceState(state: unknown, _title: string, url: string) {
        if (native.failNext) {
          native.failNext = false
          throw new DOMException('quota', 'QuotaExceededError')
        }
        history.state = state
        location.href = url
        native.replaced.push(new URL(url).pathname)
      },
      pushState() {
        native.pushed += 1
      },
    }
    return { target: { history: history as unknown as History, location, dispatchEvent: (event: Event) => events.push(event) > 0 }, events, native, location }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('sets the location before mounting and never pushes onto the tab', async () => {
    const { target, native, location } = fakeTarget()
    const memory = installMemoryHistory(target, '/posts/12')
    expect(location.href).toBe(`${SANDBOX}/posts/12`)
    target.history.pushState({ page: 13 }, '', '/posts/13')
    target.history.pushState({ page: 14 }, '', '/posts/14')
    expect(native.pushed).toBe(0)
    expect(memory.urls().map((url) => new URL(url).pathname)).toEqual(['/posts/12', '/posts/13', '/posts/14'])
  })

  it('moves back and forward in its own list and dispatches popstate with the entry state', async () => {
    const { target, events, location } = fakeTarget()
    const memory = installMemoryHistory(target, '/posts/12')
    target.history.pushState({ page: 13 }, '', '/posts/13')
    target.history.back()
    await tick()
    expect(location.href).toBe(`${SANDBOX}/posts/12`)
    expect(events.at(-1)?.type).toBe('popstate')
    target.history.back()
    await tick()
    expect(memory.index).toBe(0)
    expect(events).toHaveLength(1)
    target.history.forward()
    await tick()
    expect((events.at(-1) as PopStateEvent).state).toEqual({ page: 13 })

    target.history.back()
    target.history.pushState({ page: 20 }, '', '/posts/20')
    expect(memory.urls().map((url) => new URL(url).pathname)).toEqual(['/posts/12', '/posts/20'])
  })

  it('keeps an entry the browser refuses to write', () => {
    const { target, native } = fakeTarget()
    const memory = installMemoryHistory(target, '/posts/12')
    native.failNext = true
    expect(() => target.history.pushState({ page: 13 }, '', '/posts/13')).not.toThrow()
    expect(memory.urls()).toHaveLength(2)
  })
})

describe('startMcpApp', () => {
  const globalRef = globalThis as Record<string, unknown>
  const saved = { window: globalRef.window, document: globalRef.document }

  afterEach(() => {
    capturedOptions = undefined
    createInertiaAppMock.mockClear()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalRef[key]
      else globalRef[key] = value
    }
  })

  function fakeHost(result: ToolResultLike | undefined) {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
    const host = {
      ontoolresult: undefined as ((params: ToolResultLike) => void) | undefined,
      ontoolcancelled: undefined as ((params: unknown) => void) | undefined,
      async connect() {
        queueMicrotask(() => (result ? host.ontoolresult?.(result) : host.ontoolcancelled?.({})))
      },
      getHostCapabilities: () => ({ serverTools: {}, openLinks: {} }),
      getHostContext: () => ({ theme: 'light' }),
      async callServerTool(params: { name: string; arguments?: Record<string, unknown> }) {
        calls.push(params)
        return executed({ status: 200, url: `${APP}/posts/13` }, page('posts/Show', '/posts/13'))
      },
      async readServerResource({ uri }: { uri: string }) {
        expect(uri).toBe('ui://blog/bridge')
        return { contents: [{ text: JSON.stringify({ tools: TOOLS }) }] }
      },
      openLink: async () => ({}),
      sendMessage: async () => ({}),
      updateModelContext: async () => ({}),
    }
    return { host, calls }
  }

  function installDom() {
    const location = { href: `${SANDBOX}/mcp_apps`, origin: SANDBOX }
    const history = {
      state: null,
      replaceState(_state: unknown, _title: string, url: string) {
        location.href = url
      },
      pushState() {},
    }
    globalRef.window = { location, history, dispatchEvent: () => true, addEventListener() {}, removeEventListener() {} }
    const element = { textContent: '' }
    globalRef.document = { getElementById: () => element, addEventListener() {}, removeEventListener() {} }
    return { location, element }
  }

  it('mounts the result page at its own path and answers visits through the host', async () => {
    const { location } = installDom()
    const { host, calls } = fakeHost(executed({ status: 200, url: `${APP}/posts/12` }, page('posts/Show', '/posts/12')))
    await startMcpApp({ host, resolve: async () => ({ default: () => null }), setup: () => {} })

    expect(location.href).toBe(`${SANDBOX}/posts/12`)
    expect(capturedOptions?.page).toMatchObject({ component: 'posts/Show', url: '/posts/12' })
    const http = capturedOptions?.http as { request(config: HttpRequestConfig): Promise<{ data: string }> }
    const response = await http.request({ method: 'get', url: `${SANDBOX}/posts/13` } as HttpRequestConfig)
    expect(JSON.parse(response.data).url).toBe('/posts/13')
    expect(calls).toEqual([{ name: 'posts.show', arguments: { id: '13' } }])
  })

  it('shows that the call was cancelled and mounts nothing', async () => {
    const { element } = installDom()
    const { host } = fakeHost(undefined)
    await startMcpApp({ host, resolve: async () => ({ default: () => null }) })
    expect(element.textContent).toBe('The tool call was cancelled.')
    expect(createInertiaAppMock).not.toHaveBeenCalled()
  })
})
