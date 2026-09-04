import { Controller, type Router } from '@guren/server'
import { resolveAttachmentEngine, resolveDeliveryRoute } from './engine.js'

/**
 * The signed attachment delivery route's controller (RFC 0015 §1). It hands the
 * *raw* `Request` to the engine so every semantic parameter is re-read from the
 * same `URLSearchParams` parse the signature canonicalizes with: Hono's query
 * decoder disagrees with `URLSearchParams` on malformed percent-encoding, and
 * that mismatch is a signed-URL rewrite primitive.
 */
export class AttachmentDeliveryController extends Controller {
  async show(): Promise<Response> {
    // A mounted route without a configured engine is a server misconfiguration;
    // the resolver's throw becomes a reported 500.
    const engine = resolveAttachmentEngine('The attachments delivery route')
    return engine.handleDeliveryRequest(this.ctx.req.raw)
  }
}

/**
 * Mount the signed delivery route (RFC 0015 §6) from the app's route registrar.
 *
 * Never throws and does not require `configureAttachments()` to have run: route
 * tooling invokes registrars against a bare `Router` with no providers booted.
 * The controller resolves the engine per request instead.
 */
export function registerAttachmentRoutes(router: Router): void {
  const { prefix, routeName } = resolveDeliveryRoute()
  router.get(`${prefix}/:id/:filename`, [AttachmentDeliveryController, 'show']).name(routeName)
}
