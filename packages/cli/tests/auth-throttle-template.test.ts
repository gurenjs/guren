import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'
import { AUTH_CONTEXT_KEY, ValidationException } from '@guren/core'

import { throttleLogin, throttlePasswordResetRequest, throttleProfileUpdate } from '../templates/scaffold/auth/app/Http/Middleware/AuthThrottle'
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

  describe('throttleProfileUpdate', () => {
    // Each test signs in as its own user id, since the counts share one store.
    function profileHarness(userId: number): Harness {
      const signIn: MiddlewareHandler = async (c, next) => {
        c.set(AUTH_CONTEXT_KEY as never, { id: async () => userId } as never)
        await next()
      }
      return harness(throttleProfileUpdate, signIn)
    }

    function update(app: Hono, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
      return Promise.resolve(app.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ name: 'Ada', ...fields }).toString(),
      }))
    }

    it('answers the sixth current password guess for one user with 429', async () => {
      const { app } = profileHarness(101)

      for (let attempt = 0; attempt < 5; attempt++) {
        expect((await update(app, { email: `guess-${attempt}@example.com`, currentPassword: `guess-${attempt}` })).status).toBe(200)
      }

      expect((await update(app, { email: 'guess-5@example.com', currentPassword: 'guess-5' })).status).toBe(429)
    })

    it('counts each user separately', async () => {
      const busy = profileHarness(102)
      for (let attempt = 0; attempt < 6; attempt++) {
        await update(busy.app, { currentPassword: 'wrong' })
      }

      expect((await update(profileHarness(103).app, { currentPassword: 'wrong' })).status).toBe(200)
    })

    it('does not count a save that carries no current password', async () => {
      const { app } = profileHarness(104)

      for (let attempt = 0; attempt < 6; attempt++) {
        expect((await update(app, {})).status).toBe(200)
        expect((await update(app, { currentPassword: '' })).status).toBe(200)
      }
    })

    it('counts a whitespace current password, which the controller verifies', async () => {
      const { app } = profileHarness(105)

      for (let attempt = 0; attempt < 5; attempt++) {
        await update(app, { currentPassword: ' ' })
      }

      expect((await update(app, { currentPassword: ' ' })).status).toBe(429)
    })

    it('puts the message under currentPassword for an Inertia request', async () => {
      const { app, caught } = profileHarness(106)
      const inertia = { 'x-inertia': 'true' }

      for (let attempt = 0; attempt < 6; attempt++) {
        await update(app, { currentPassword: 'wrong' }, inertia)
      }

      expect(caught()).toBeInstanceOf(ValidationException)
      expect((caught() as ValidationException).getFirstError('currentPassword')).toStartWith('Too many requests.')
    })
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
