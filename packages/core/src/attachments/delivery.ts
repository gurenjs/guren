import { Controller, type Router } from '@guren/server'
import { resolveAttachmentEngine, resolveDeliveryRoute } from './engine.js'

/**
 * The signed attachment delivery route's controller (RFC 0015 §1). Thin on
 * purpose: it hands the raw `Request` to the engine, which owns
 * verification, variant resolution, and the redirect/proxy split — so the
 * serving contract is testable without HTTP.
 *
 * Raw on purpose, too: every semantic parameter must be re-read from the
 * same `URLSearchParams` parse the signature canonicalizes with. Hono's
 * query decoder disagrees with `URLSearchParams` on malformed
 * percent-encoding, and a parser mismatch there is a signed-URL rewrite
 * primitive.
 */
export class AttachmentDeliveryController extends Controller {
  async show(): Promise<Response> {
    // A mounted route without a configured engine is a server
    // misconfiguration; the resolver's throw goes through the
    // ExceptionHandler (reported, 500) like every other attachments API.
    const engine = resolveAttachmentEngine('The attachments delivery route')
    return engine.handleDeliveryRequest(this.ctx.req.raw)
  }
}

/**
 * Mount the signed delivery route (RFC 0015 §6) — call it from the app's
 * route registrar:
 *
 * ```ts
 * // routes/web.ts
 * import { registerAttachmentRoutes } from '@guren/core'
 *
 * export function registerWebRoutes(router: Router): void {
 *   registerAttachmentRoutes(router)
 *   // …app routes…
 * }
 * ```
 *
 * Registration never throws and does not require `configureAttachments()`
 * to have run: route tooling (`routes:types`, `guren check`, audit,
 * OpenAPI) invokes registrars against a bare `Router` with no providers
 * booted, so a config-dependent throw here would break every inspection
 * tool. The controller resolves the engine per request instead; at runtime
 * providers register before routes mount, so the configured prefix and
 * route name are picked up whenever they exist.
 */
export function registerAttachmentRoutes(router: Router): void {
  const { prefix, routeName } = resolveDeliveryRoute()
  router.get(`${prefix}/:id/:filename`, [AttachmentDeliveryController, 'show']).name(routeName)
}
