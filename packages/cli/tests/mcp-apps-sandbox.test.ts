import { describe, expect, test } from 'bun:test'
import { mcpAppsPageOrigin, mcpAppsSandboxOrigin } from '../src/dev-center-links'
import { mcpAppsSandboxCsp, serveMcpAppsSandbox } from '../src/mcp-apps-sandbox'

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

  test('answers 400 to a csp parameter that is not a JSON object', () => {
    expect(sandbox('?csp=nope').status).toBe(400)
    expect(sandbox(`?csp=${encodeURIComponent('[1]')}`).status).toBe(400)
    expect(sandbox(`?csp=${'x'.repeat(9000)}`).status).toBe(400)
  })
})
