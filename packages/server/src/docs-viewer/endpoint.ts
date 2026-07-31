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
 */
export function isDocsViewerEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production' &&
    process.env?.GUREN_DOCS === '1'
  )
}

/** Restricts the docs viewer to the developer's own machine. */
export function createDocsViewerAccessGuard(): MiddlewareHandler {
  return createLoopbackGuard('the docs viewer')
}
