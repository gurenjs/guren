import { afterEach, expect, test } from 'bun:test'
import { Application } from '../../src/http/Application'

// The auth app's session middleware signs cookies with it; set before `original`, so every test keeps it.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const original = { ...process.env }
afterEach(() => { process.env = { ...original } })
const local = { server: { requestIP: () => ({ address: '127.0.0.1' }) } }
const DEV_CENTER_PATHS = ['/_guren', '/_guren/', '/_guren/graph.json', '/_guren/plans.json', '/_guren/plans/comments', '/_guren/plans/comments/review', '/_guren/plans/comments/feedback', '/_guren/plans/comments/evidence', '/_guren/plans/comments/readiness/approve', `/_guren/browser/2026-10-31T00-00-00Z-posts/screenshots/${'0'.repeat(64)}`, '/_guren/ui', '/_guren/ui.json', '/_guren/mcp-apps', '/_guren/mcp-apps/sandbox', '/_guren/boards', '/_guren/boards.json', '/_guren/boards/demo', '/_guren/boards/demo/board.json', '/_guren/boards/demo/status', '/_guren/boards/demo/ops']

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
    // A loopback page on another port passes the guard; the route's own Origin check refuses it before the CLI does.
    const otherPort = await app.fetch(post('http://localhost:5173'), local)
    expect(otherPort.status).toBe(403)
    expect(await otherPort.json()).toMatchObject({ error: { code: 'cross-origin' } })
    // The guard covers the POST too: a request the handler would accept is refused from another machine.
    expect((await app.fetch(post('http://localhost'), { server: { requestIP: () => ({ address: '203.0.113.1' }) } })).status).toBe(403)
    // The exemption is the feedback route alone: any other Dev Center path still needs a token.
    expect((await app.fetch(new Request('http://localhost/_guren/plans/comments/review', { method: 'POST', headers: { origin: 'http://localhost' } }), local)).status).toBe(403)
  } finally { await app.stop() }
})

test('Dev Center board edits reach the CLI handler in an auth app, on the terms the feedback route has', async () => {
  process.env.NODE_ENV = 'development'
  process.env.GUREN_MCP = '1'
  const app = new Application({ auth: {} })
  await app.boot()
  try {
    const post = (origin: string, path = '/_guren/boards/demo/ops') => new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify([{ op: 'remove', id: 'nobody' }]),
    })
    // Past CSRF and the guard: the CLI answers, and this directory has no board named `demo`.
    const response = await app.fetch(post('http://localhost'), local)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'no-board' } })
    expect((await app.fetch(post('https://hostile.example'), local)).status).toBe(403)
    // A loopback page on another port passes the guard; the route's own Origin check refuses it before the CLI does.
    const otherPort = await app.fetch(post('http://localhost:5173'), local)
    expect(otherPort.status).toBe(403)
    expect(await otherPort.json()).toMatchObject({ error: { code: 'cross-origin' } })
    expect((await app.fetch(post('http://localhost'), { server: { requestIP: () => ({ address: '203.0.113.1' }) } })).status).toBe(403)
    // The exemption is the ops route alone: the board's other paths still need a token.
    expect((await app.fetch(post('http://localhost', '/_guren/boards/demo/board.json'), local)).status).toBe(403)
    expect((await app.fetch(post('http://localhost', '/_guren/boards/demo'), local)).status).toBe(403)
  } finally { await app.stop() }
})
