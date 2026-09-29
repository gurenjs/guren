import { afterEach, describe, expect, test } from 'bun:test'
import { Application } from '../../src/http/Application'
import { ExceptionHandler } from '../../src/errors/ExceptionHandler'
import { RuntimeErrorBuffer, RUNTIME_ERRORS_BINDING, RUNTIME_ERRORS_PATH } from '../../src/mcp/runtime-errors'

const original = { ...process.env }
afterEach(() => { process.env = { ...original } })
const detail = { method: 'GET', status: 500, correlation: 'unavailable' as const }
const env = { server: { requestIP: () => ({ address: '127.0.0.1' }) } }

function enable(): void {
  process.env.NODE_ENV = 'development'
  process.env.GUREN_MCP = '1'
  delete process.env.GUREN_ALLOW_UNVERIFIED_PEER
}

describe('development runtime error buffer', () => {
  test('bounds retention, expires events, and reports stale/restart cursors', () => {
    let now = 1000
    const buffer = new RuntimeErrorBuffer('/project', () => now)
    for (let index = 0; index < 105; index++) buffer.record(new Error('secret'), detail)
    const result = buffer.read({ limit: 100 })
    expect(result.events).toHaveLength(100)
    expect(result.events[0]!.sequence).toBe(6)
    expect(result.dropped).toBe(5)
    expect(result.cursorExpired).toBe(true)
    const page = buffer.read({ after: 100, limit: 2 })
    expect(page.events.map((entry) => entry.sequence)).toEqual([101, 102])
    now += 15 * 60_000
    expect(buffer.read().events).toEqual([])
    expect(buffer.read().dropped).toBe(105)
    buffer.reset()
    expect(buffer.read(result.nextCursor).cursorExpired).toBe(true)
    expect(buffer.read().sessionId).not.toBe(result.sessionId)
  })

  test('limits bytes, omits free text and paths outside the project, and returns detached events', () => {
    const buffer = new RuntimeErrorBuffer(process.cwd())
    const error = new Error('password=secret')
    error.stack = `Error: password=secret\n    at show (${process.cwd()}/packages/server/src/errors/ExceptionHandler.ts:10:20)\n    at secret (/external/secret.ts:1:2)\n    at escape (${process.cwd()}/../secret.ts:1:2)\n    at missing (${process.cwd()}/secret.ts:1:2)`
    buffer.record(error, detail)
    const result = buffer.read()
    expect(result.events[0]!.frames).toEqual([{ file: 'packages/server/src/errors/ExceptionHandler.ts', line: 10, column: 20 }])
    expect(JSON.stringify(result)).not.toContain('secret')
    result.events[0]!.frames[0]!.file = 'mutated'
    expect(buffer.read().events[0]!.frames[0]!.file).toBe('packages/server/src/errors/ExceptionHandler.ts')
    for (let index = 0; index < 100; index++) buffer.record(error, { ...detail, route: { method: 'GET', pattern: '/' + 'x'.repeat(4000) } })
    expect(buffer.read({ limit: 100 }).events.length).toBeLessThan(100)
    buffer.record(error, { ...detail, route: { method: 'GET', pattern: '/' + 'x'.repeat(9000) } })
    expect(JSON.stringify(buffer.read({ limit: 100 })).length).toBeLessThan(280_000)
    expect(buffer.read().dropped).toBeGreaterThan(0)
  })

  test('rejects malformed cursors and limits', () => {
    const buffer = new RuntimeErrorBuffer('/project')
    for (const query of [{ after: -1 }, { after: NaN }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }]) expect(() => buffer.read(query)).toThrow()
  })

  test('captures one original exception with custom rendering, exclusions and app isolation', async () => {
    enable()
    const app = new Application({ routes(router) { router.get('/broken/:id', () => { throw new Error('password=secret') }).name('broken') } })
    const other = new Application()
    const handler = new ExceptionHandler()
    let reported = 0
    handler.report(() => { reported++ })
    handler.render(Error, (_error, ctx) => ctx.text('custom', 503))
    app.container.instance('exception.handler', handler)
    await app.boot()
    try {
      const response = await app.fetch(new Request('http://localhost/broken/private-value?token=secret', { headers: { cookie: 'password=secret' } }), env)
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('custom')
      expect(reported).toBe(1)
      const buffer = app.container.make<RuntimeErrorBuffer>(RUNTIME_ERRORS_BINDING)
      const report = buffer.read()
      expect(report.events).toHaveLength(1)
      expect(report.events[0]!.route).toMatchObject({ pattern: '/broken/:id', name: 'broken' })
      expect(JSON.stringify(report)).not.toContain('secret')
      expect(JSON.stringify(report)).not.toContain('private-value')
      expect(other.container.make<RuntimeErrorBuffer>(RUNTIME_ERRORS_BINDING).read().events).toEqual([])
      handler.dontReport(Error)
      await app.fetch(new Request('http://localhost/broken/2'), env)
      expect(buffer.read().events).toHaveLength(1)
      await app.stop()
      expect(buffer.read().events).toEqual([])
    } finally { await app.stop(); await other.stop() }
  })

  test('clears failures recorded by an in-flight request while stop drains it', async () => {
    enable()
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const proceed = new Promise<void>((resolve) => { release = resolve })
    const app = new Application({ routes(router) {
      router.get('/slow', async () => { entered(); await proceed; throw new Error('late failure') })
    } })
    const handler = new ExceptionHandler({ debug: false })
    handler.report(() => {})
    app.container.instance('exception.handler', handler)
    try {
      await app.boot()
      const address = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
      const request = fetch(`http://127.0.0.1:${address.port}/slow`, { headers: { connection: 'close' } })
      await ready
      const stopped = app.stop()
      release()
      const response = await request
      expect(response.status).toBe(500)
      await response.text()
      await stopped
      expect(app.container.make<RuntimeErrorBuffer>(RUNTIME_ERRORS_BINDING).read().events).toEqual([])
    } finally { release(); await app.stop(true) }
  })

  test('HTTP reads use the loopback guard; production and disabled apps expose no collector', async () => {
    enable()
    const app = new Application()
    await app.boot()
    try {
      const read = (headers?: HeadersInit, address?: string) => app.fetch(new Request(`http://localhost${RUNTIME_ERRORS_PATH}`, { headers }),
        address ? { server: { requestIP: () => ({ address }) } } : undefined)
      expect((await read({}, '127.0.0.1')).status).toBe(200)
      expect((await read({ origin: 'https://evil.example' }, '127.0.0.1')).status).toBe(403)
      expect((await read({}, '192.0.2.1')).status).toBe(403)
      expect((await read()).status).toBe(403)
      process.env.NODE_ENV = 'production'
      expect((await read({}, '127.0.0.1')).status).toBe(404)
      const production = new Application()
      expect(production.container.has(RUNTIME_ERRORS_BINDING)).toBe(false)
      process.env.NODE_ENV = 'development'
      delete process.env.GUREN_MCP
      const disabled = new Application()
      expect(disabled.container.has(RUNTIME_ERRORS_BINDING)).toBe(false)
    } finally { await app.stop() }
  })
})
