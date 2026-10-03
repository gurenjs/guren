import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'
import { ValidationException } from '@guren/core'

import { throttleLogin, throttlePasswordResetRequest } from '../templates/scaffold/auth/app/Http/Middleware/AuthThrottle'
import { AUTH_THROTTLE_TRANSLATIONS } from '../src/lang'

const TEMPLATE = join(import.meta.dir, '../templates/scaffold/auth/app/Http/Middleware/AuthThrottle.ts')
const BLOG_TEMPLATE = join(import.meta.dir, '../../create-app/templates/blog')

interface Harness {
  app: Hono
  caught: () => unknown
}

// The throttles share the default in-memory store for the whole process, so
// every test posts its own email address.
function harness(throttle: MiddlewareHandler, setup?: MiddlewareHandler): Harness {
  let caught: unknown
  const app = new Hono()
  if (setup) app.use(setup)
  app.post('/login', throttle, async (c) => {
    const body = (c.req.header('content-type') ?? '').includes('application/json')
      ? await c.req.json()
      : await c.req.parseBody()
    return c.json({ body })
  })
  app.onError((error, c) => {
    caught = error
    return c.text('error', 500)
  })
  return { app, caught: () => caught }
}

function post(app: Hono, email: string, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(app.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ email, password: 'secret' }).toString(),
  }))
}

describe('scaffolded AuthThrottle', () => {
  it('leaves the body readable for the controller', async () => {
    const { app } = harness(throttleLogin)

    const form = await post(app, 'form-body@example.com')
    expect(await form.json()).toEqual({ body: { email: 'form-body@example.com', password: 'secret' } })

    const json = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'json-body@example.com' }),
    })
    expect(await json.json()).toEqual({ body: { email: 'json-body@example.com' } })
  })

  it('answers the sixth login for one address with 429 and the login message', async () => {
    const { app } = harness(throttleLogin)

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await post(app, 'json-client@example.com')).status).toBe(200)
    }
    const limited = await post(app, ' JSON-Client@example.com ')

    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    const body = (await limited.json()) as { message: string; retryAfter: number }
    expect(body.message).toBe(AUTH_THROTTLE_TRANSLATIONS.throttle.replace(':seconds', String(body.retryAfter)))
  })

  it('counts each address separately', async () => {
    const { app } = harness(throttleLogin)

    for (let attempt = 0; attempt < 6; attempt++) {
      await post(app, 'busy@example.com')
    }

    expect((await post(app, 'quiet@example.com')).status).toBe(200)
  })

  it('throws a ValidationException for an Inertia request, so the form shows the message', async () => {
    const { app, caught } = harness(throttleLogin)
    const inertia = { 'x-inertia': 'true' }

    for (let attempt = 0; attempt < 5; attempt++) {
      await post(app, 'inertia@example.com', inertia)
    }
    await post(app, 'inertia@example.com', inertia)

    expect(caught()).toBeInstanceOf(ValidationException)
    expect((caught() as ValidationException).getFirstError('message')).toStartWith('Too many login attempts.')
  })

  it('reads the message from the request translator when the app has one', async () => {
    const translator: MiddlewareHandler = async (c, next) => {
      const t = (key: string, replacements?: Record<string, string | number>) =>
        key === 'auth.too_many_requests' ? `Encore ${replacements?.seconds} secondes.` : key
      c.set('t' as never, t as never)
      c.set('tc' as never, t as never)
      await next()
    }
    const { app } = harness(throttlePasswordResetRequest, translator)

    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await post(app, 'translated@example.com')).status).toBe(200)
    }
    const limited = await post(app, 'translated@example.com')

    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { message: string }).message).toMatch(/^Encore \d+ secondes\.$/)
  })

  it('restates the published translations as its fallback messages', async () => {
    const source = await readFile(TEMPLATE, 'utf8')
    for (const message of Object.values(AUTH_THROTTLE_TRANSLATIONS)) {
      expect(source).toContain(`fallbackMessage: '${message}'`)
    }
  })

  // The blog's copy of the file is pinned by scaffold-blog-sync.test.ts.
  it('ships the same translations in the blog starter', async () => {
    expect(JSON.parse(await readFile(join(BLOG_TEMPLATE, 'lang/en/auth.json'), 'utf8')))
      .toEqual(AUTH_THROTTLE_TRANSLATIONS)
  })

  // workerd refuses a timer while a module evaluates, and the default store starts one.
  it('starts no timer when the module is imported', () => {
    const script = [
      "import '@guren/core'",
      'let started = 0',
      'const original = globalThis.setInterval',
      'globalThis.setInterval = ((...args) => { started++; return original(...args) })',
      `await import(${JSON.stringify(TEMPLATE)})`,
      'console.log(started)',
    ].join('\n')
    const result = Bun.spawnSync([process.execPath, '-e', script], { cwd: join(import.meta.dir, '..') })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('0')
  })
})
