import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'

/**
 * The one upstream behaviour the scaffolded OAuth consent flow rests on: Hono
 * keys its body cache on the parse *options*, not on the request alone. The
 * consent controller reads repeated `scope` checkboxes with
 * `parseBody({ all: true })` after the CSRF middleware already called
 * `parseBody()` with none; were the cache keyed on the request, it would get the
 * collapsed result and grant one tool however many boxes were ticked, with no
 * error and no log line. The collapsed `first` is asserted too — without it the
 * two calls were never in conflict and this would pass under any rule.
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
