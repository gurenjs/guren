import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'

/**
 * The one upstream behaviour the scaffolded OAuth consent flow rests on, and
 * the one nothing else in this repository would notice changing.
 *
 * The consent form submits one `scope` field per ticked checkbox, so the
 * controller reads the body with `parseBody({ all: true })` — without which
 * repeated fields collapse to the last one and the screen grants exactly one
 * tool however many boxes were ticked. But Guren's CSRF middleware has
 * *already* called `parseBody()` on that request, with no options, to find
 * `_csrf_token`. If Hono's body cache were keyed on the request alone, the
 * controller's call would hand back the middleware's `all: false` result and
 * the flow would silently under-grant — a bug with no error, no log line, and
 * no failing test anywhere, because the collapse happens inside a framework
 * both halves trust.
 *
 * Measured here rather than assumed, and kept standing rather than measured
 * once: this file is the assertion that Hono keys the cache on the options
 * too. A Hono upgrade that changed it fails here instead of in someone's
 * deployed consent screen.
 *
 * `firstScope` is asserted as well, and it is the half that proves the probe
 * is testing anything: it must be the *collapsed* value, or the two calls were
 * never in conflict and the test would pass under any caching rule at all.
 */
describe('hono parseBody caching (consent form prerequisite)', () => {
  test('should honour all: true on a request whose body was already parsed without it', async () => {
    const app = new Hono()
    app.post('/consent', async (c) => {
      // What `createCsrfMiddleware` does, verbatim in shape.
      const first = await c.req.parseBody()
      // What the scaffolded McpOAuthController does.
      const second = await c.req.parseBody({ all: true })
      return Response.json({ first: first.scope, second: second.scope })
    })

    const body = new URLSearchParams()
    body.append('scope', 'tool:posts.index')
    body.append('scope', 'tool:posts.store')
    body.append('_csrf_token', 'token')

    const response = await app.fetch(
      new Request('http://localhost/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
    )

    expect(await response.json()).toEqual({
      // Collapsed, which is what makes the second call meaningful.
      first: 'tool:posts.store',
      second: ['tool:posts.index', 'tool:posts.store'],
    })
  })
})
