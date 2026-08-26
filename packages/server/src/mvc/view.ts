import type { FC } from 'hono/jsx'
// The narrow runtime entry, deliberately: the `hono/jsx` barrel drags the
// client-side DOM renderer and streaming modules (+8 modules, ~53 KB) onto
// every app's cold-start path, and `jsx()` bottoms out in the same element
// construction `createElement()` does for this call shape.
import { jsx } from '../jsx-runtime'

/** Options for {@link renderDocument} / `Controller.view()` (RFC 0014). */
export type ViewOptions = ResponseInit & {
  /**
   * Prepend `<!doctype html>` and require a full document (an `<html>` root).
   * Pass `false` for an intentional fragment response — no doctype, no check.
   */
  doctype?: boolean
}

/**
 * Does the rendered output begin with an `<html>` root, allowing leading
 * whitespace and complete comments? A hand-rolled linear scan rather than a
 * regex: the equivalent pattern (`(?:\s|<!--.*?-->)*<html`) backtracks
 * exponentially on adversarial comment runs (CodeQL js/redos), and the body
 * being scanned can embed user-influenced raw markup.
 */
function startsWithHtmlRoot(body: string): boolean {
  let i = 0
  while (i < body.length) {
    const ch = body.charCodeAt(i)
    // \t \n \v \f \r or space
    if (ch === 32 || (ch >= 9 && ch <= 13)) {
      i++
      continue
    }
    if (body.startsWith('<!--', i)) {
      const end = body.indexOf('-->', i + 4)
      if (end === -1) return false
      i = end + 3
      continue
    }
    break
  }
  if (body.slice(i, i + 5).toLowerCase() !== '<html') return false
  const next = body.charCodeAt(i + 5)
  return next === 62 /* > */ || next === 32 || (next >= 9 && next <= 13)
}

/**
 * Render a `hono/jsx` component to a plain server-rendered HTML `Response` —
 * the engine behind `Controller.view()` (RFC 0014), separated the way
 * `inertia()` is from `Controller.inertia()`.
 */
export async function renderDocument<P>(
  component: FC<P>,
  props: P,
  options: ViewOptions = {},
): Promise<Response> {
  // Build a real hono element and let hono own the reduction. Invoking the
  // component directly and reducing the result by hand looks equivalent and
  // is not: it skips hono's escaping of raw strings inside a `Child[]` (a
  // stored-XSS hole caught in the RFC 0014 review).
  const body = String(await jsx(component as never, props as never, undefined).toString())

  if (options.doctype !== false && !startsWithHtmlRoot(body)) {
    const name = component.displayName ?? (component as { name?: string }).name ?? 'component'
    throw new Error(
      `view(): ${name} rendered a fragment, not a document. ` +
        'Wrap the page in your Layout (an <html> root), or pass { doctype: false } ' +
        'for an intentional fragment response. Without <html>/<head>, <title> and ' +
        '<meta> tags are not hoisted and the page ships unstyled.',
    )
  }

  const { doctype, headers: headersInit, ...init } = options
  const headers = new Headers(headersInit)
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8')
  }

  return new Response((doctype === false ? '' : '<!doctype html>') + body, { ...init, headers })
}
