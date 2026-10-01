import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createDevCenterHandler } from '../src/dev-center'
import { buildApplicationGraph } from '../src/application-graph'

const graph = buildApplicationGraph({ capturedAt: '2026-09-29T00:00:00Z', nodes: [], edges: [], unresolved: [], coverage: {} })
const request = () => new Request('http://localhost/_guren/graph.json')

function deferredGraph() {
  const releases: Array<(value: typeof graph) => void> = []
  const rejects: Array<(error: Error) => void> = []
  const load = () => new Promise<typeof graph>((resolve, reject) => { releases.push(resolve); rejects.push(reject) })
  return { releases, rejects, load }
}
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a read during a running scan waits for the next scan, which every such read shares', async () => {
  const scans = deferredGraph()
  const handler = createDevCenterHandler({ cwd: '/fixture', graph: scans.load })
  const first = handler.fetch(request())
  expect(scans.releases).toHaveLength(1)
  const during = [handler.fetch(request()), handler.fetch(request())]
  expect(scans.releases).toHaveLength(1)
  scans.releases[0]!(graph)
  expect(await (await first).json()).toEqual(graph)
  await macrotask()
  expect(scans.releases).toHaveLength(2)
  scans.releases[1]!({ ...graph, snapshot: { ...graph.snapshot, id: 'after-edit' } })
  for (const response of await Promise.all(during)) expect((await response.json()).snapshot.id).toBe('after-edit')
  expect(scans.releases).toHaveLength(2)
})

test('reads arriving before the follow-up starts share it, and an idle handler scans at once', async () => {
  const scans = deferredGraph()
  const handler = createDevCenterHandler({ cwd: '/fixture', graph: scans.load })
  const first = handler.fetch(request())
  const queued = handler.fetch(request())
  scans.releases[0]!(graph)
  const late = handler.fetch(request())
  await first
  await macrotask()
  expect(scans.releases).toHaveLength(2)
  const joined = handler.fetch(request())
  expect(scans.releases).toHaveLength(2)
  scans.releases[1]!({ ...graph, snapshot: { ...graph.snapshot, id: 'second' } })
  expect((await (await queued).json()).snapshot.id).toBe('second')
  expect((await (await late).json()).snapshot.id).toBe('second')
  await macrotask()
  expect(scans.releases).toHaveLength(3)
  scans.releases[2]!({ ...graph, snapshot: { ...graph.snapshot, id: 'third' } })
  expect((await (await joined).json()).snapshot.id).toBe('third')
  const idle = handler.fetch(request())
  expect(scans.releases).toHaveLength(4)
  scans.releases[3]!(graph)
  expect((await idle).status).toBe(200)
})

test('a failed scan still starts the follow-up for reads that arrived during it', async () => {
  const scans = deferredGraph()
  const handler = createDevCenterHandler({ cwd: '/fixture', graph: scans.load })
  const first = handler.fetch(request())
  const during = handler.fetch(request())
  scans.rejects[0]!(new Error('secret'))
  expect((await first).status).toBe(503)
  await macrotask()
  scans.releases[1]!(graph)
  expect(await (await during).json()).toEqual(graph)
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
