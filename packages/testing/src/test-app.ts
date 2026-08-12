import type { Hono } from 'hono'
import type { I18nPluginOptions, Router } from '@guren/server'
import { TestResponse } from './http'

type BootCallback = (app: Hono) => void | Promise<void>
type ProviderLike = { register?(): unknown; boot?(): unknown }
type ProviderConstructor = new (...args: unknown[]) => ProviderLike
type RouteRegistration = (router: Router) => void | Promise<void>
type ApplicationLike = {
  boot(): Promise<void>
  fetch(request: Request): Response | Promise<Response>
}
type ApplicationConstructor = new (options: {
  boot?: BootCallback
  providers?: ProviderConstructor[]
  routes?: RouteRegistration
  auth?: Record<string, unknown>
  i18n?: I18nPluginOptions
}) => ApplicationLike

/**
 * Options for creating a TestApp instance.
 */
export interface TestAppOptions {
  readonly boot?: BootCallback
  readonly providers?: ProviderConstructor[]
  readonly routes?: RouteRegistration
  /**
   * Mirrors `createApp({ auth })`: pass `{}` (or full auth options) to mount
   * session + CSRF middleware so tests exercise production-like behavior.
   * Required for `withCsrf()` to work. Ignored by the Hono fallback used when
   * `@guren/server` is not installed.
   */
  readonly auth?: Record<string, unknown>
  /**
   * Mirrors `createApp({ i18n })`: required when controllers under test use
   * `this.t()`/`this.tc()`. Ignored by the Hono fallback.
   */
  readonly i18n?: I18nPluginOptions
}

/**
 * Fake ExecutionContext exposed by `TestApp.fromWorkers()`, so tests can
 * await promises the handler passed to `ctx.waitUntil()`.
 */
export interface WorkersTestContext {
  /** Promises passed to ctx.waitUntil by the handler, for tests to await. */
  readonly waitUntilPromises: Promise<unknown>[]
}

type WorkersExecutionContext = {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

type WorkersHandler = {
  fetch(
    request: Request,
    env: unknown,
    ctx: WorkersExecutionContext,
  ): Response | Promise<Response>
}

export interface WorkersTestAppOptions {
  readonly env?: unknown
  readonly baseUrl?: string
}

/**
 * A promise-like TestResponse that allows chaining assertions
 * directly on the result of HTTP method calls.
 *
 * This enables the fluent syntax:
 *   await app.get('/posts').assertStatus(200).assertJsonCount(3, 'data')
 */
export class PendingTestResponse implements PromiseLike<TestResponse> {
  private promise: Promise<TestResponse>

  constructor(promise: Promise<TestResponse>) {
    this.promise = promise
  }

  then<TResult1 = TestResponse, TResult2 = never>(
    onfulfilled?: ((value: TestResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected)
  }

  /**
   * Assert the response status code.
   */
  assertStatus(code: number): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then((r) => {
        r.assertStatus(code)
        return r
      }),
    )
  }

  /**
   * Assert the response is OK (200).
   */
  assertOk(): PendingTestResponse {
    return this.assertStatus(200)
  }

  /**
   * Assert the response is Created (201).
   */
  assertCreated(): PendingTestResponse {
    return this.assertStatus(201)
  }

  /**
   * Assert the response is No Content (204).
   */
  assertNoContent(): PendingTestResponse {
    return this.assertStatus(204)
  }

  /**
   * Assert the response is a redirect.
   */
  assertRedirect(url?: string): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then((r) => {
        r.assertRedirect(url)
        return r
      }),
    )
  }

  /**
   * Assert the response is Not Found (404).
   */
  assertNotFound(): PendingTestResponse {
    return this.assertStatus(404)
  }

  /**
   * Assert the response is Forbidden (403).
   */
  assertForbidden(): PendingTestResponse {
    return this.assertStatus(403)
  }

  /**
   * Assert the response is Unauthorized (401).
   */
  assertUnauthorized(): PendingTestResponse {
    return this.assertStatus(401)
  }

  /**
   * Assert the response is Unprocessable Entity (422).
   */
  assertUnprocessable(): PendingTestResponse {
    return this.assertStatus(422)
  }

  /**
   * Assert the response JSON matches the expected value.
   */
  assertJson(expected: Record<string, unknown>): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then(async (r) => {
        await r.assertJson(expected)
        return r
      }),
    )
  }

  /**
   * Assert the response JSON array (or a nested key) has the expected count.
   */
  assertJsonCount(count: number, key?: string): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then(async (r) => {
        const json = await r.json()
        const target = key ? getNestedValue(json, key) : json

        if (!Array.isArray(target)) {
          throw new Error(
            `Expected ${key ? `"${key}"` : 'response'} to be an array, got ${typeof target}`,
          )
        }

        if (target.length !== count) {
          throw new Error(
            `Expected ${key ? `"${key}"` : 'response'} to have ${count} items, got ${target.length}`,
          )
        }

        return r
      }),
    )
  }

  /**
   * Assert the response JSON has the given keys.
   */
  assertJsonStructure(keys: string[]): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then(async (r) => {
        const json = (await r.json()) as Record<string, unknown>

        for (const key of keys) {
          if (!(key in json)) {
            throw new Error(`Expected JSON to have key "${key}"`)
          }
        }

        return r
      }),
    )
  }

  /**
   * Assert a value at a dot-notation path in the JSON response.
   */
  assertJsonPath(path: string, value: unknown): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then(async (r) => {
        await r.assertJsonPath(path, value)
        return r
      }),
    )
  }

  /**
   * Assert the response is an Inertia response with the given component.
   */
  assertInertia(component: string, props?: Record<string, unknown>): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then(async (r) => {
        const json = (await r.json()) as Record<string, unknown>

        const inertiaComponent = json.component
        if (inertiaComponent !== component) {
          throw new Error(
            `Expected Inertia component "${component}", got "${String(inertiaComponent)}"`,
          )
        }

        if (props) {
          const inertiaProps = json.props as Record<string, unknown> | undefined
          if (!inertiaProps) {
            throw new Error('Expected Inertia response to have props')
          }

          for (const [key, expectedValue] of Object.entries(props)) {
            const actual = inertiaProps[key]
            const expectedStr = JSON.stringify(expectedValue)
            const actualStr = JSON.stringify(actual)

            if (expectedStr !== actualStr) {
              throw new Error(
                `Expected Inertia prop "${key}" to be ${expectedStr}, got ${actualStr}`,
              )
            }
          }
        }

        return r
      }),
    )
  }

  /**
   * Assert the response has a specific cookie.
   */
  assertCookie(name: string, value?: string): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then((r) => {
        const cookies = r.headers.getSetCookie()
        const found = cookies.some((c) => {
          const [pair] = c.split(';')
          const [cookieName, cookieValue] = pair.split('=')
          if (cookieName.trim() !== name) return false
          if (value !== undefined && cookieValue?.trim() !== value) return false
          return true
        })

        if (!found) {
          throw new Error(
            value !== undefined
              ? `Expected cookie "${name}" with value "${value}"`
              : `Expected cookie "${name}" to exist`,
          )
        }

        return r
      }),
    )
  }

  /**
   * Assert the response does not have a specific cookie.
   */
  assertCookieMissing(name: string): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then((r) => {
        const cookies = r.headers.getSetCookie()
        const found = cookies.some((c) => {
          const [pair] = c.split(';')
          const [cookieName] = pair.split('=')
          return cookieName.trim() === name
        })

        if (found) {
          throw new Error(`Expected cookie "${name}" to be missing`)
        }

        return r
      }),
    )
  }

  /**
   * Assert the response has a specific header.
   */
  assertHeader(name: string, value?: string): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then((r) => {
        r.assertHeader(name, value)
        return r
      }),
    )
  }

  /**
   * Assert the response does not have a specific header.
   */
  assertHeaderMissing(name: string): PendingTestResponse {
    return new PendingTestResponse(
      this.promise.then((r) => {
        r.assertHeaderMissing(name)
        return r
      }),
    )
  }
}

/**
 * Integrated HTTP test client that wraps the Application class.
 *
 * Uses `app.fetch()` internally so no running HTTP server is needed.
 *
 * @example
 * ```typescript
 * const app = await TestApp.create({
 *   boot: (hono) => {
 *     hono.get('/posts', (c) => c.json([{ id: 1 }]))
 *   },
 * })
 *
 * await app.get('/posts').assertOk().assertJsonCount(1)
 * await app.actingAs(user).get('/dashboard').assertOk()
 * await app.json().post('/api/posts', { title: 'Test' }).assertCreated()
 * ```
 */
export class TestApp {
  private baseUrl: string
  private fetchFn: (request: Request) => Promise<Response>
  private defaultHeaders: Record<string, string> = {}
  private authenticatedUser: unknown = null
  /** Present when created via fromWorkers(); propagated across builder copies. */
  workers?: WorkersTestContext

  private constructor(
    fetchFn: (request: Request) => Promise<Response>,
    baseUrl = 'http://localhost',
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetchFn = fetchFn
  }

  /**
   * Create a new TestApp by booting an Application instance.
   *
   * The Application is imported dynamically to avoid hard coupling at the
   * module level. If the import fails (e.g., in a test environment without
   * @guren/server installed), a lightweight Hono-based fallback is used.
  */
  static async create(options: TestAppOptions = {}): Promise<TestApp> {
    // Enable test mode so that attachAuthContext() accepts the X-Testing-User header.
    if (typeof process !== 'undefined') {
      process.env.GUREN_TESTING = '1'
    }

    let Application: ApplicationConstructor | undefined

    try {
      ;({ Application } = await import('@guren/core') as { Application: ApplicationConstructor })
    } catch {
      try {
        // @guren/core is not always installed (it aggregates @guren/server);
        // fall back to the peer dependency, which exports the same Application.
        ;({ Application } = await import('@guren/server') as { Application: ApplicationConstructor })
      } catch {
        // Fallback: use a plain Hono app when @guren/server is not available.
        const { Hono } = await import('hono')
        const hono = new Hono()
        if (options.boot) {
          await options.boot(hono)
        }

        const fetchFn = (request: Request) => Promise.resolve(hono.fetch(request))
        return new TestApp(fetchFn)
      }
    }

    const application = new Application({
      boot: options.boot,
      providers: options.providers,
      routes: options.routes,
      auth: options.auth,
      i18n: options.i18n,
    })
    await application.boot()

    const fetchFn = (request: Request) => Promise.resolve(application.fetch(request))
    return new TestApp(fetchFn)
  }

  /**
   * Create a TestApp from an existing Application instance — typically the one
   * exported by `src/app.ts` — booting it if it has not booted yet.
   *
   * `fetch` is bound to the instance internally, so there is no need for the
   * `TestApp.fromFetch((request) => app.fetch(request))` arrow wrapper: an
   * unbound `app.fetch` reference throws because it reads instance state.
   *
   * Booting is left to the app, whose `boot()` is expected to be idempotent
   * (@guren/server's Application reuses its first boot), so several test files
   * may call this on the same instance.
   *
   * @example
   * import app from '../src/app'
   *
   * const http = await TestApp.fromApp(app)
   * await http.get('/').assertOk()
   */
  static async fromApp(app: ApplicationLike, baseUrl = 'http://localhost'): Promise<TestApp> {
    // Set before boot() so boot-time code sees test mode; fromFetch repeats it.
    process.env.GUREN_TESTING = '1'
    await app.boot()

    return TestApp.fromFetch((request) => app.fetch(request), baseUrl)
  }

  /**
   * Create a TestApp from an existing fetch function.
   * Useful when you already have a Hono app or Application instance.
   */
  static fromFetch(
    fetchFn: (request: Request) => Response | Promise<Response>,
    baseUrl = 'http://localhost',
  ): TestApp {
    process.env.GUREN_TESTING = '1'
    return new TestApp(
      (req) => Promise.resolve(fetchFn(req)),
      baseUrl,
    )
  }

  /**
   * Create a TestApp from a Cloudflare Workers-style fetch handler
   * (`{ fetch(request, env, ctx) }`).
   *
   * A single fake ExecutionContext is shared across all requests made
   * through the returned TestApp; promises passed to `ctx.waitUntil()` are
   * collected in `workers.waitUntilPromises` for tests to await.
   */
  static fromWorkers(
    handler: WorkersHandler,
    options: WorkersTestAppOptions = {},
  ): TestApp & { workers: WorkersTestContext } {
    process.env.GUREN_TESTING = '1'

    const waitUntilPromises: Promise<unknown>[] = []
    const ctx: WorkersExecutionContext = {
      waitUntil(promise) {
        waitUntilPromises.push(promise)
      },
      passThroughOnException() {},
    }

    const app = new TestApp(
      (req) => Promise.resolve(handler.fetch(req, options.env ?? {}, ctx)),
      options.baseUrl,
    )

    app.workers = { waitUntilPromises }
    // The assertion only narrows the optional `workers` field to required.
    return app as TestApp & { workers: WorkersTestContext }
  }

  /**
   * Return a new TestApp that injects the given user as the authenticated user.
   *
   * The user is injected by setting a custom header that auth middleware
   * can recognize in test mode.
   */
  actingAs(user: unknown): TestApp {
    const copy = new TestApp(this.fetchFn, this.baseUrl)
    copy.defaultHeaders = { ...this.defaultHeaders }
    copy.authenticatedUser = user
    copy.workers = this.workers
    return copy
  }

  /**
   * Prime the CSRF protection: performs a GET request to `path`, captures the
   * session and XSRF-TOKEN cookies, and returns a TestApp that sends them
   * (plus the `X-XSRF-TOKEN` header) on every subsequent request — so POST,
   * PUT, PATCH, and DELETE pass the CSRF middleware like a real browser.
   *
   * @example
   * const http = TestApp.fromFetch((request) => app.fetch(request)).actingAs(user)
   * const csrf = await http.withCsrf()
   * await csrf.post('/tasks', { title: 'hello' }) // no more 403
   */
  async withCsrf(path = '/'): Promise<TestApp> {
    const response = await this.request('GET', path)

    const cookies = new Map<string, string>()
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';')
      const separator = pair.indexOf('=')
      if (separator > 0) {
        cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
      }
    }

    const xsrfToken = cookies.get('XSRF-TOKEN')
    if (!xsrfToken) {
      throw new Error(
        `withCsrf(): GET ${path} did not set an XSRF-TOKEN cookie. ` +
          'Ensure session + CSRF middleware are enabled (auth option in createApp).',
      )
    }

    const copy = new TestApp(this.fetchFn, this.baseUrl)
    copy.defaultHeaders = {
      ...this.defaultHeaders,
      Cookie: [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      'X-XSRF-TOKEN': decodeURIComponent(xsrfToken),
    }
    copy.authenticatedUser = this.authenticatedUser
    copy.workers = this.workers
    return copy
  }

  /**
   * Return a new TestApp that sends `Accept: application/json` on every request.
   */
  json(): TestApp {
    return this.withHeaders({ Accept: 'application/json' })
  }

  /**
   * Return a new TestApp that sends the given headers on every request.
   *
   * @example
   * const en = http.withHeaders({ 'Accept-Language': 'en' })
   * await en.get('/') // rendered with the English locale
   */
  withHeaders(headers: Record<string, string>): TestApp {
    const copy = new TestApp(this.fetchFn, this.baseUrl)
    copy.defaultHeaders = {
      ...this.defaultHeaders,
      ...headers,
    }
    copy.authenticatedUser = this.authenticatedUser
    copy.workers = this.workers
    return copy
  }

  /**
   * Return a new TestApp that sends the given header on every request.
   */
  withHeader(name: string, value: string): TestApp {
    return this.withHeaders({ [name]: value })
  }

  /**
   * Make a GET request.
   */
  get(path: string): PendingTestResponse {
    return this.request('GET', path)
  }

  /**
   * Make a POST request.
   */
  post(path: string, body?: unknown): PendingTestResponse {
    return this.request('POST', path, body)
  }

  /**
   * Make a PUT request.
   */
  put(path: string, body?: unknown): PendingTestResponse {
    return this.request('PUT', path, body)
  }

  /**
   * Make a PATCH request.
   */
  patch(path: string, body?: unknown): PendingTestResponse {
    return this.request('PATCH', path, body)
  }

  /**
   * Make a DELETE request.
   */
  delete(path: string, body?: unknown): PendingTestResponse {
    return this.request('DELETE', path, body)
  }

  /**
   * Make a QUERY request (RFC 10008): safe and idempotent like GET, but
   * carries a request body like POST.
   */
  query(path: string, body?: unknown): PendingTestResponse {
    return this.request('QUERY', path, body)
  }

  /**
   * Make a request with any HTTP method.
   */
  private request(method: string, path: string, body?: unknown): PendingTestResponse {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`

    const headers: Record<string, string> = { ...this.defaultHeaders }

    // FormData bodies get their multipart boundary from fetch itself.
    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
    }

    if (this.authenticatedUser) {
      // Inject authenticated user as a JSON-encoded header that test-aware
      // auth middleware can read. Preserve the auth identifier so the
      // deserialized object can reconstruct getAuthIdentifier().
      const user = this.authenticatedUser as Record<string, unknown>
      const authId =
        typeof (user as { getAuthIdentifier?: unknown }).getAuthIdentifier === 'function'
          ? (user as { getAuthIdentifier(): unknown }).getAuthIdentifier()
          : user.id ?? null
      headers['X-Testing-User'] = JSON.stringify({ ...user, __authId: authId })
    }

    const init: RequestInit = {
      method,
      headers,
    }

    if (body !== undefined && body !== null) {
      init.body = body instanceof FormData ? body : JSON.stringify(body)
    }

    const promise = (async () => {
      const request = new Request(url, init)
      const response = await this.fetchFn(request)
      return new TestResponse(response)
    })()

    return new PendingTestResponse(promise)
  }
}

/**
 * Factory helper for creating test model instances.
 *
 * @example
 * ```typescript
 * const user = await factory(UserFactory)
 * const users = await factory(UserFactory, 3)
 * ```
 */
export async function factory<T>(
  factoryClass: new () => { create(overrides?: Partial<T>): Promise<T> },
  count?: number,
): Promise<T | T[]> {
  const instance = new factoryClass()
  if (count !== undefined && count > 0) {
    const results: T[] = []
    for (let i = 0; i < count; i++) {
      results.push(await instance.create())
    }
    return results
  }

  return instance.create()
}

// --- Internal helpers ---

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current = obj

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined
    }
    if (typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }

  return current
}
