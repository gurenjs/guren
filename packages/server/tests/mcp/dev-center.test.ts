import { afterEach, expect, test } from 'bun:test'
import { Application } from '../../src/http/Application'

const original = { ...process.env }
afterEach(() => { process.env = { ...original } })
const local = { server: { requestIP: () => ({ address: '127.0.0.1' }) } }
const DEV_CENTER_PATHS = ['/_guren', '/_guren/', '/_guren/graph.json', '/_guren/plans.json', '/_guren/plans/comments', '/_guren/plans/comments/review', '/_guren/plans/comments/feedback']

test('Dev Center uses the MCP opt-in and guards its shell, graph and plan routes', async () => {
  process.env.NODE_ENV = 'development'
  process.env.GUREN_MCP = '1'
  delete process.env.GUREN_ALLOW_UNVERIFIED_PEER
  const app = new Application()
  await app.boot()
  try {
    const page = await app.fetch(new Request('http://localhost/_guren'), local)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Dev Center')
    for (const path of DEV_CENTER_PATHS) {
      const req = () => new Request(`http://localhost${path}`)
      expect((await app.fetch(req())).status).toBe(403)
      expect((await app.fetch(req(), { server: { requestIP: () => ({ address: '203.0.113.1' }) } })).status).toBe(403)
      expect((await app.fetch(new Request(req(), { headers: { origin: 'https://hostile.example' } }), local)).status).toBe(403)
    }
    process.env.NODE_ENV = 'production'
    expect((await app.fetch(new Request('http://localhost/_guren'), local)).status).toBe(404)
    process.env.NODE_ENV = 'development'
    process.env.GUREN_MCP = '0'
    expect((await app.fetch(new Request('http://localhost/_guren'), local)).status).toBe(404)
  } finally { await app.stop() }
})

test('Dev Center is not mounted without opt-in or in production', async () => {
  for (const [mode, enabled] of [['development', '0'], ['production', '1']]) {
    process.env.NODE_ENV = mode
    process.env.GUREN_MCP = enabled
    const app = new Application()
    await app.boot()
    try {
      for (const path of DEV_CENTER_PATHS) expect((await app.fetch(new Request(`http://localhost${path}`), local)).status).toBe(404)
    }
    finally { await app.stop() }
  }
})

test('Dev Center feedback reaches the CLI handler in an auth app, which issues no token to the page', async () => {
  process.env.NODE_ENV = 'development'
  process.env.GUREN_MCP = '1'
  const app = new Application({ auth: {} })
  await app.boot()
  try {
    const post = (origin: string) => new Request('http://localhost/_guren/plans/comments/feedback', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ planDigest: 'x', feedback: { answers: [], elements: [] } }),
    })
    // Past CSRF and the guard: the CLI answers, and this directory has no plan named `comments`.
    const response = await app.fetch(post('http://localhost'), local)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'no-plan' } })
    expect((await app.fetch(post('https://hostile.example'), local)).status).toBe(403)
    // The guard covers the POST too: a request the handler would accept is refused from another machine.
    expect((await app.fetch(post('http://localhost'), { server: { requestIP: () => ({ address: '203.0.113.1' }) } })).status).toBe(403)
    // The exemption is the feedback route alone: any other Dev Center path still needs a token.
    expect((await app.fetch(new Request('http://localhost/_guren/plans/comments/review', { method: 'POST', headers: { origin: 'http://localhost' } }), local)).status).toBe(403)
  } finally { await app.stop() }
})
