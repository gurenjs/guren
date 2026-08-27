import { Controller, type Router } from '@guren/server'
import {
  DEFAULT_DELIVERY_PREFIX,
  DEFAULT_DELIVERY_ROUTE_NAME,
  getActiveAttachmentEngine,
} from './engine.js'

/**
 * The signed attachment delivery route's controller (RFC 0015 §1). Thin on
 * purpose: it parses the request and hands everything to the engine, which
 * owns verification, variant resolution, and the redirect/proxy split —
 * so the serving contract is testable without HTTP.
 */
export class AttachmentDeliveryController extends Controller {
  async show(): Promise<Response> {
    const engine = getActiveAttachmentEngine()
    if (!engine) {
      // A mounted route without a configured engine is a server
      // misconfiguration, not a client error — say so plainly.
      return new Response(
        'Attachments are not configured. Call configureAttachments({ ..., delivery: {} }) at boot.',
        { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )
    }

    const params = this.ctx.req.param() as Record<string, string>
    return engine.handleDeliveryRequest({
      url: new URL(this.ctx.req.url),
      id: params.id ?? '',
      variant: this.query('variant'),
      disposition: this.query('disposition'),
      ifNoneMatch: this.ctx.req.header('if-none-match'),
      method: this.ctx.req.method,
    })
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
  const delivery = getActiveAttachmentEngine()?.deliveryRoute
  const prefix = delivery?.prefix ?? DEFAULT_DELIVERY_PREFIX
  const routeName = delivery?.routeName ?? DEFAULT_DELIVERY_ROUTE_NAME
  router.get(`${prefix}/:id/:filename`, [AttachmentDeliveryController, 'show']).name(routeName)
}
