import { createHash } from 'node:crypto'
import { freshApplicationGraph } from './application-graph-fresh'
import type { GraphResult } from './application-graph'
import { devCenterShell } from './dev-center-shell'

/** The mounting server owns activation and peer/origin checks, as for dev MCP. */
export function createDevCenterHandler(options: {
  cwd: string
  graph?: (cwd: string) => Promise<GraphResult>
}): { fetch(request: Request): Promise<Response> } {
  const load = options.graph ?? freshApplicationGraph
  let running: Promise<GraphResult> | undefined
  let queued: Promise<GraphResult> | undefined
  const start = (): Promise<GraphResult> => {
    const scan = new Promise<GraphResult>((resolve) => resolve(load(options.cwd)))
    running = scan
    const settle = () => { if (running === scan) running = undefined }
    scan.then(settle, settle)
    return scan
  }
  // A read joins only a scan that starts after it arrived: one started earlier may predate an edit
  // and still report `stable`. Everything arriving mid-scan shares one follow-up.
  const scanAfterArrival = (): Promise<GraphResult> => {
    if (queued) return queued
    if (!running) return start()
    queued = running.then(() => undefined, () => undefined).then(() => {
      queued = undefined
      return start()
    })
    return queued
  }
  return {
    async fetch(request) {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      const path = new URL(request.url).pathname
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET' } })
      if (path === '/_guren/graph.json') {
        try { return Response.json(await scanAfterArrival(), { headers }) }
        catch { return Response.json({ schemaVersion: 1, error: { code: 'collection-failed', message: 'Graph collection failed.' } }, { headers, status: 503 }) }
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
