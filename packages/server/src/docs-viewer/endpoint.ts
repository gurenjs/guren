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
 * Whether the docs viewer is mounted for this process.
 *
 * Opt-in via `GUREN_DOCS=1` and never active in production: the viewer
 * renders the project's private knowledge bundle, so it must not be
 * reachable unless the developer asked for it.
 *
 * The environment reads use plain member access so that the deploy plugins'
 * `--define 'process.env.NODE_ENV="production"'` settles the production
 * branch at bundle time; an optional chain is a different expression and no
 * define matches it. See `mcp/endpoint.ts` for the full reasoning — and do
 * not add optional chaining back, a test reads this file for it.
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
