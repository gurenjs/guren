import type { Context } from 'hono'

/**
 * A browser navigation: it accepts HTML and is not an Inertia visit, an XHR or a
 * JSON caller, each of which needs a JSON payload. `ExceptionHandler` and the
 * CSRF middleware both answer an HTML page by this one rule.
 */
export function wantsHtmlResponse(ctx: Context): boolean {
  if (!ctx?.req?.header) return false
  const accept = ctx.req.header('accept') ?? ''
  const isJsonRequest =
    accept.includes('application/json') ||
    ctx.req.header('x-requested-with') === 'XMLHttpRequest' ||
    ctx.req.header('x-inertia') === 'true'

  return !isJsonRequest && accept.includes('text/html')
}
