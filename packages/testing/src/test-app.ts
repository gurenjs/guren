import type { Hono } from 'hono'
import type { Router } from '@guren/server'
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
}) => ApplicationLike

/**
 * Options for creating a TestApp instance.
 */
export interface TestAppOptions {
  readonly boot?: BootCallback
  readonly providers?: ProviderConstructor[]
  readonly routes?: RouteRegistration
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
        const setCookie = r.headers.get('Set-Cookie') ?? ''
        const cookies = setCookie.split(',').map((c) => c.trim())
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
        const setCookie = r.headers.get('Set-Cookie') ?? ''
        const cookies = setCookie.split(',').map((c) => c.trim())
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
      // Fallback: use a plain Hono app when @guren/server is not available.
      const { Hono } = await import('hono')
      const hono = new Hono()
      if (options.boot) {
        await options.boot(hono)
      }

      const fetchFn = (request: Request) => Promise.resolve(hono.fetch(request))
      return new TestApp(fetchFn)
    }

    const application = new Application({
      boot: options.boot,
      providers: options.providers,
      routes: options.routes,
    })
    await application.boot()

    const fetchFn = (request: Request) => Promise.resolve(application.fetch(request))
    return new TestApp(fetchFn)
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
   * Return a new TestApp that injects the given user as the authenticated user.
   *
   * The user is injected by setting a custom header that auth middleware
   * can recognize in test mode.
   */
  actingAs(user: unknown): TestApp {
    const copy = new TestApp(this.fetchFn, this.baseUrl)
    copy.defaultHeaders = { ...this.defaultHeaders }
    copy.authenticatedUser = user
    return copy
  }

  /**
   * Return a new TestApp that sends `Accept: application/json` on every request.
   */
  json(): TestApp {
    const copy = new TestApp(this.fetchFn, this.baseUrl)
    copy.defaultHeaders = {
      ...this.defaultHeaders,
      Accept: 'application/json',
    }
    copy.authenticatedUser = this.authenticatedUser
    return copy
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
   * Make a request with any HTTP method.
   */
  private request(method: string, path: string, body?: unknown): PendingTestResponse {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`

    const headers: Record<string, string> = { ...this.defaultHeaders }

    if (body !== undefined && body !== null) {
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
      init.body = JSON.stringify(body)
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
