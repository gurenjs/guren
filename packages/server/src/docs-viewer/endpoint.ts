/**
 * Identity and activation rules for the dev-only docs viewer (RFC 0005).
 *
 * Mirrors the MCP endpoint: opt-in via environment variable, never
 * active in production, and every route behind the shared loopback
 * guard. All routes are `GET`, so no CSRF exemption is involved.
 */
import type { MiddlewareHandler } from 'hono'
import { createLoopbackGuard } from '../http/middleware/loopback-guard'

export const DOCS_VIEWER_PATH = '/_guren/docs'

/**
 * Whether the docs viewer is mounted: opt-in via `GUREN_DOCS=1`, never in
 * production — it renders the project's private knowledge bundle. Plain
 * `process.env.X` access on purpose: the deploy plugins' `--define
 * 'process.env.NODE_ENV="production"'` settles that branch at bundle time, and
 * an optional chain is a different expression no define matches (`mcp/endpoint.ts`; a test greps this file).
 */
export function isDocsViewerEnabled(): boolean {
  if (typeof process === 'undefined') {
    return false
  }
  if (process.env.NODE_ENV === 'production') {
    return false
  }

  return process.env.GUREN_DOCS === '1'
}

/**
 * Restricts the docs viewer to the developer's own machine: cross-origin
 * browser requests are rejected, and so is any request whose socket peer
 * is not loopback — including one whose peer the runtime cannot report.
 */
export function createDocsViewerAccessGuard(): MiddlewareHandler {
  return createLoopbackGuard('the docs viewer')
}
