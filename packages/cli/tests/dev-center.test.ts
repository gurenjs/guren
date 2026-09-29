import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createDevCenterHandler } from '../src/dev-center'
import { buildApplicationGraph } from '../src/application-graph'

const graph = buildApplicationGraph({ capturedAt: '2026-09-29T00:00:00Z', nodes: [], edges: [], unresolved: [], coverage: {} })
const request = () => new Request('http://localhost/_guren/graph.json')

test('shares only in-flight graph reads and preserves partial graph payloads', async () => {
  let calls = 0
  let release!: (value: typeof graph) => void
  const handler = createDevCenterHandler({ cwd: '/fixture', graph: async () => { calls++; return new Promise((resolve) => { release = resolve }) } })
  const first = handler.fetch(request())
  const concurrent = handler.fetch(request())
  expect(calls).toBe(1)
  release(graph)
  expect(await (await first).json()).toEqual(graph)
  expect(await (await concurrent).json()).toEqual(graph)
  const next = handler.fetch(request())
  expect(calls).toBe(2)
  release({ ...graph, snapshot: { ...graph.snapshot, id: 'changed' } })
  expect((await (await next).json()).snapshot.id).toBe('changed')
})

test('failed reads can retry without exposing application exception text', async () => {
  let calls = 0
  const handler = createDevCenterHandler({ cwd: '/fixture', graph: async () => { if (++calls === 1) throw new Error('secret'); return graph } })
  const failure = await handler.fetch(request())
  expect(failure.status).toBe(503)
  expect(await failure.text()).not.toContain('secret')
  expect(await (await handler.fetch(request())).json()).toEqual(graph)
})

test('serves a self-contained shell with hashed scripts, no-store, and fixed routes', async () => {
  const handler = createDevCenterHandler({ cwd: '/fixture' })
  const response = await handler.fetch(new Request('http://localhost/_guren'))
  const html = await response.text()
  expect(response.headers.get('cache-control')).toBe('no-store')
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)]
  expect(scripts).toHaveLength(1)
  const digest = createHash('sha256').update(scripts[0]![1]!).digest('base64')
  expect(response.headers.get('content-security-policy')).toContain(`script-src 'sha256-${digest}'`)
  expect(html).toContain('/_guren/docs')
  expect(html).not.toContain('__GUREN_DEV_CENTER_SCRIPT__')
  expect((await handler.fetch(new Request('http://localhost/_guren/unknown'))).status).toBe(404)
  expect((await handler.fetch(new Request('http://localhost/_guren/graph.json', { method: 'POST' }))).status).toBe(405)
})
