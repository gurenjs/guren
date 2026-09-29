import { describe, expect, test } from 'bun:test'
import { Application } from '../../server/src/http/Application'
import { ExceptionHandler } from '../../server/src/errors/ExceptionHandler'
import { connectDevMcpClient, toolText, LOOPBACK_ENV } from './dev-mcp-client'
import { fetchRuntimeErrors, runtimeOrigin } from '../src/runtime-errors'

describe('runtime error client', () => {
  test('requires an explicit loopback HTTP origin', () => {
    for (const value of ['https://localhost', 'http://example.com', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost?token=x', 'http://localhost/#x']) {
      expect(() => runtimeOrigin(value)).toThrow()
    }
    expect(runtimeOrigin('http://127.0.0.1:3333').port).toBe('3333')
    expect(runtimeOrigin('http://[::1]').hostname).toBe('[::1]')
  })

  test('a real failed request is visible through identical HTTP and MCP payloads', async () => {
    const previous = { ...process.env }
    process.env.NODE_ENV = 'development'
    process.env.GUREN_MCP = '1'
    delete process.env.GUREN_ALLOW_UNVERIFIED_PEER
    const app = new Application({ routes(router) {
      router.get('/failure/:id', () => { throw new Error('private-message') }).name('failure')
    } })
    const exceptionHandler = new ExceptionHandler({ debug: false })
    exceptionHandler.report(() => {})
    app.container.instance('exception.handler', exceptionHandler)
    let client
    try {
      await app.boot()
      const response = await app.fetch(new Request('http://localhost/failure/private-value'), LOOPBACK_ENV)
      expect(response.status).toBe(500)
      const http = await app.fetch(new Request('http://localhost/_guren/runtime/errors'), LOOPBACK_ENV)
      const payload = await http.json()
      client = await connectDevMcpClient((request) => app.fetch(request, LOOPBACK_ENV), 'modern')
      const mcp = JSON.parse(toolText(await client.callTool({ name: 'guren_get_runtime_errors', arguments: {} })))
      expect(mcp).toEqual(payload)
      expect(mcp.events).toHaveLength(1)
      expect(mcp.events[0].route.name).toBe('failure')
      expect(JSON.stringify(mcp)).not.toContain('private-message')
      expect(JSON.stringify(mcp)).not.toContain('private-value')
      const next = JSON.parse(toolText(await client.callTool({ name: 'guren_get_runtime_errors', arguments: mcp.nextCursor })))
      expect(next.events).toEqual([])
    } finally { await client?.close(); await app.stop(); process.env = previous }
  })

  test('does not follow redirects and distinguishes unsupported / oversized data from an empty feed', async () => {
    let path = ''
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
      path = new URL(request.url).pathname
      const limit = new URL(request.url).searchParams.get('limit')
      if (limit === '1') return Response.redirect('http://example.com')
      if (limit === '2') return new Response('x'.repeat(1024 * 1024 + 1))
      return Response.json({})
    } })
    try {
      for (const limit of [1, 2, 3]) expect((await fetchRuntimeErrors(server.url.origin, { limit })).status).toBe('unavailable')
      expect(path).toBe('/_guren/runtime/errors')
      await expect(fetchRuntimeErrors(server.url.origin, { limit: 101 })).rejects.toThrow()
    } finally { await server.stop(true) }
  })
})
