import { describe, expect, test } from 'bun:test'
import { mcpAppsPageOrigin, mcpAppsSandboxOrigin } from '../src/dev-center-links'
import { mcpAppsSandboxCsp, sandboxScript, serveMcpAppsSandbox } from '../src/mcp-apps-sandbox'
import { SandboxTransport } from '../src/dev-center-page/sandbox-transport'

const sandbox = (query = '') => serveMcpAppsSandbox(new Request(`http://127.0.0.1:3000/_guren/mcp-apps/sandbox${query}`))

describe('MCP Apps sandbox origins', () => {
  test('pair localhost with 127.0.0.1 on the same port, and nothing else', () => {
    expect(mcpAppsSandboxOrigin('http://localhost:3000')).toBe('http://127.0.0.1:3000')
    expect(mcpAppsPageOrigin('http://127.0.0.1:3000')).toBe('http://localhost:3000')
    expect(mcpAppsSandboxOrigin('http://localhost')).toBe('http://127.0.0.1')
    expect(mcpAppsSandboxOrigin('http://127.0.0.1:3000')).toBeUndefined()
    expect(mcpAppsSandboxOrigin('http://app.test:3000')).toBeUndefined()
    expect(mcpAppsSandboxOrigin('https://localhost:3000')).toBeUndefined()
    expect(mcpAppsPageOrigin('http://localhost:3000')).toBeUndefined()
    expect(mcpAppsPageOrigin('not a url')).toBeUndefined()
  })
})

describe('serveMcpAppsSandbox', () => {
  test('refuses every host but 127.0.0.1', async () => {
    for (const url of ['http://localhost:3000', 'http://app.test:3000', 'http://[::1]:3000']) {
      expect(serveMcpAppsSandbox(new Request(`${url}/_guren/mcp-apps/sandbox`)).status).toBe(404)
    }
  })

  test('writes the page origin into the relay rather than reading the referrer', async () => {
    const html = await sandbox().text()
    expect(html).toContain('const HOST = "http://localhost:3000";')
    expect(html).not.toContain('document.referrer')
  })

  test('applies the restrictive default CSP, with no self source', () => {
    const csp = sandbox().headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain('frame-ancestors http://localhost:3000')
    expect(csp).not.toContain("'self'")
  })

  test('widens the CSP by the declared domains only', () => {
    const declared = { resourceDomains: ['https://cdn.example.com'], connectDomains: ['https://api.example.com'] }
    const csp = sandbox(`?csp=${encodeURIComponent(JSON.stringify(declared))}`).headers.get('content-security-policy')!
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.com")
    expect(csp).toContain('connect-src https://api.example.com')
  })

  test('drops a domain that would add a keyword or a directive', () => {
    const csp = mcpAppsSandboxCsp({
      resourceDomains: ["'unsafe-eval'", 'https://a.example.com; script-src *', 'https://b.example.com other'],
      connectDomains: ['*'],
    }, 'http://localhost:3000')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('a.example.com')
    expect(csp).not.toContain('b.example.com')
    expect(csp).toContain("connect-src 'none'")
  })

  test('drops the dev server\'s own hosts, which a view in a real host could never reach', () => {
    const csp = mcpAppsSandboxCsp({
      connectDomains: ['127.0.0.1:3000', 'http://127.0.0.1:3000', '127.0.0.1:*', 'localhost:3000', 'http://0.0.0.0:3000', 'https://api.example.com'],
    }, 'http://localhost:3000')
    expect(csp).toContain('connect-src https://api.example.com;')
  })

  test('answers 400 to a csp parameter that is not a JSON object', () => {
    expect(sandbox('?csp=nope').status).toBe(400)
    expect(sandbox(`?csp=${encodeURIComponent('[1]')}`).status).toBe(400)
    expect(sandbox(`?csp=${'x'.repeat(9000)}`).status).toBe(400)
  })
})

const HOST = 'http://localhost:3000'
const RESOURCE_READY = 'ui/notifications/sandbox-resource-ready'

/** Runs the relay over fake windows, recording what it posts each way. */
function runRelay() {
  const toParent: Array<[unknown, string]> = []
  const toView: Array<[unknown, string]> = []
  const attributes: Record<string, string> = {}
  const viewWindow = { postMessage: (data: unknown, origin: string) => { toView.push([data, origin]) } }
  const written: string[] = []
  const contentDocument = { open: () => {}, write: (html: string) => { written.push(html) }, close: () => {} }
  const inner = { title: '', contentDocument, contentWindow: viewWindow, setAttribute: (name: string, value: string) => { attributes[name] = value } }
  const parent = { postMessage: (data: unknown, origin: string) => { toParent.push([data, origin]) } }
  let listener: (event: { source: unknown; origin: string; data: unknown }) => void = () => {}
  const window = { self: {}, top: {}, parent, addEventListener: (_type: string, fn: typeof listener) => { listener = fn } }
  const document = { createElement: () => inner, body: { appendChild: () => {}, textContent: '' } }
  new Function('window', 'document', 'location', sandboxScript(HOST))(window, document, { origin: 'http://127.0.0.1:3000' })
  return {
    toParent, toView, written, attributes,
    fromHost: (data: unknown, origin = HOST) => listener({ source: parent, origin, data }),
    fromView: (data: unknown, source: unknown = viewWindow, origin = 'http://127.0.0.1:3000') => listener({ source, origin, data }),
  }
}

describe('the sandbox relay', () => {
  test('announces itself to the page origin it was served for', () => {
    const relay = runRelay()
    expect(relay.toParent).toEqual([[{ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, HOST]])
  })

  test('loads the view in a frame that cannot navigate the top window', () => {
    const relay = runRelay()
    expect(relay.attributes.sandbox).toBe('allow-scripts allow-same-origin allow-forms')
  })

  test('loads the first resource-ready from the host and ignores every later one', () => {
    const relay = runRelay()
    relay.fromHost({ jsonrpc: '2.0', method: RESOURCE_READY, params: { html: '<p>first</p>' } })
    relay.fromHost({ jsonrpc: '2.0', method: RESOURCE_READY, params: { html: '<p>second</p>' } })
    expect(relay.written).toEqual(['<p>first</p>'])
    expect(relay.toView).toEqual([])
  })

  test('drops a host message from another origin', () => {
    const relay = runRelay()
    relay.fromHost({ jsonrpc: '2.0', method: RESOURCE_READY, params: { html: '<p>x</p>' } }, 'https://hostile.example')
    relay.fromHost({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: {} }, 'https://hostile.example')
    expect(relay.written).toEqual([])
    expect(relay.toView).toEqual([])
  })

  test('forwards protocol messages both ways and never a sandbox-reserved one', () => {
    const relay = runRelay()
    const input = { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: {} }
    relay.fromHost(input)
    relay.fromHost({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-anything', params: {} })
    expect(relay.toView).toEqual([[input, 'http://127.0.0.1:3000']])
    const initialize = { jsonrpc: '2.0', id: 0, method: 'ui/initialize', params: {} }
    relay.fromView(initialize)
    relay.fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} })
    expect(relay.toParent.slice(1)).toEqual([[initialize, HOST]])
  })

  test('drops a view-side message from another window or another origin', () => {
    const relay = runRelay()
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }
    relay.fromView(message, {})
    relay.fromView(message, undefined, 'https://hostile.example')
    expect(relay.toParent).toHaveLength(1)
  })
})

describe('SandboxTransport', () => {
  function transport() {
    const sent: Array<[unknown, string]> = []
    const proxy = { postMessage: (data: unknown, origin: string) => { sent.push([data, origin]) } }
    let listener: ((event: MessageEvent<unknown>) => void) | undefined
    const target = {
      addEventListener: (_type: string, fn: (event: MessageEvent<unknown>) => void) => { listener = fn },
      removeEventListener: () => { listener = undefined },
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>
    const received: unknown[] = []
    const subject = new SandboxTransport({ contentWindow: proxy as unknown as Window }, 'http://127.0.0.1:3000', () => {}, target)
    subject.onmessage = (message) => { received.push(message) }
    const deliver = (data: unknown, source: unknown = proxy, origin = 'http://127.0.0.1:3000') =>
      listener?.({ source, origin, data } as unknown as MessageEvent<unknown>)
    return { subject, sent, received, deliver }
  }

  test('posts to the proxy origin only', async () => {
    const { subject, sent } = transport()
    await subject.send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: {} })
    expect(sent[0]![1]).toBe('http://127.0.0.1:3000')
  })

  test('accepts JSON-RPC from the proxy frame on its origin and nothing else', async () => {
    const { subject, received, deliver } = transport()
    await subject.start()
    const message = { jsonrpc: '2.0', id: 0, method: 'ui/initialize', params: {} }
    deliver(message, {})
    deliver(message, undefined, 'http://localhost:3000')
    deliver({ id: 0, method: 'ui/initialize' })
    deliver(message)
    expect(received).toEqual([message])
  })

  test('stops listening once closed', async () => {
    const { subject, received, deliver } = transport()
    await subject.start()
    await subject.close()
    deliver({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    expect(received).toEqual([])
  })
})
