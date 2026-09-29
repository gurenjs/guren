import { createHash } from 'node:crypto'
import { freshApplicationGraph } from './application-graph-fresh'
import type { GraphResult } from './application-graph'
import { devCenterShell } from './dev-center-shell'

/** The mounting server owns activation and peer/origin checks, as for dev MCP. */
export function createDevCenterHandler(options: {
  cwd: string
  graph?: (cwd: string) => Promise<GraphResult>
}): { fetch(request: Request): Promise<Response> } {
  let inFlight: Promise<GraphResult> | undefined
  return {
    async fetch(request) {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      const path = new URL(request.url).pathname
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET' } })
      if (path === '/_guren/graph.json') {
        // Concurrent tabs share the in-flight scan; the next completed read is always fresh.
        inFlight ??= (options.graph ?? freshApplicationGraph)(options.cwd)
        const scan = inFlight
        try { return Response.json(await scan, { headers }) }
        catch { return Response.json({ schemaVersion: 1, error: { code: 'collection-failed', message: 'Graph collection failed.' } }, { headers, status: 503 }) }
        finally { if (inFlight === scan) inFlight = undefined }
      }
      if (path !== '/_guren' && path !== '/_guren/') return new Response('Not found', { status: 404, headers })
      const html = devCenterShell()
      const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)]
        .map((match) => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`).join(' ')
      return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      } })
    },
  }
}
