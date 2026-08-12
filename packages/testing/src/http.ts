import type { Authenticatable } from '@guren/server'

/**
 * Test response wrapper with assertion methods.
 */
export class TestResponse {
  private response: Response
  private _body: string | null = null
  private _json: unknown = null

  constructor(response: Response) {
    this.response = response
  }

  /**
   * Get the raw response.
   */
  get raw(): Response {
    return this.response
  }

  /**
   * Get the status code.
   */
  get status(): number {
    return this.response.status
  }

  /**
   * Get response headers.
   */
  get headers(): Headers {
    return this.response.headers
  }

  /**
   * Get the response body as text.
   */
  async text(): Promise<string> {
    if (this._body === null) {
      this._body = await this.response.clone().text()
    }
    return this._body
  }

  /**
   * Get the response body as JSON.
   */
  async json<T = unknown>(): Promise<T> {
    if (this._json === null) {
      this._json = await this.response.clone().json()
    }
    return this._json as T
  }

  /**
   * Assert the response status code.
   */
  assertStatus(status: number): this {
    if (this.response.status !== status) {
      throw new Error(
        `Expected status ${status}, got ${this.response.status}`
      )
    }
    return this
  }

  /**
   * Assert the response is OK (200).
   */
  assertOk(): this {
    return this.assertStatus(200)
  }

  /**
   * Assert the response is Created (201).
   */
  assertCreated(): this {
    return this.assertStatus(201)
  }

  /**
   * Assert the response is No Content (204).
   */
  assertNoContent(): this {
    return this.assertStatus(204)
  }

  /**
   * Assert the response is Bad Request (400).
   */
  assertBadRequest(): this {
    return this.assertStatus(400)
  }

  /**
   * Assert the response is Unauthorized (401).
   */
  assertUnauthorized(): this {
    return this.assertStatus(401)
  }

  /**
   * Assert the response is Forbidden (403).
   */
  assertForbidden(): this {
    return this.assertStatus(403)
  }

  /**
   * Assert the response is Not Found (404).
   */
  assertNotFound(): this {
    return this.assertStatus(404)
  }

  /**
   * Assert the response is Unprocessable Entity (422).
   */
  assertUnprocessable(): this {
    return this.assertStatus(422)
  }

  /**
   * Assert the response is Internal Server Error (500).
   */
  assertServerError(): this {
    return this.assertStatus(500)
  }

  /**
   * Assert the response is a redirect.
   */
  assertRedirect(url?: string): this {
    const status = this.response.status
    if (status < 300 || status >= 400) {
      throw new Error(`Expected redirect status, got ${status}`)
    }

    if (url !== undefined) {
      const location = this.response.headers.get('Location')
      if (location !== url) {
        throw new Error(`Expected redirect to ${url}, got ${location}`)
      }
    }

    return this
  }

  /**
   * Assert the response has a specific header.
   */
  assertHeader(name: string, value?: string): this {
    const headerValue = this.response.headers.get(name)

    if (headerValue === null) {
      throw new Error(`Expected header ${name} to exist`)
    }

    if (value !== undefined && headerValue !== value) {
      throw new Error(
        `Expected header ${name} to be ${value}, got ${headerValue}`
      )
    }

    return this
  }

  /**
   * Assert the response does not have a specific header.
   */
  assertHeaderMissing(name: string): this {
    const headerValue = this.response.headers.get(name)

    if (headerValue !== null) {
      throw new Error(`Expected header ${name} to be missing`)
    }

    return this
  }

  /**
   * Assert the response body contains the expected JSON.
   */
  async assertJson(expected: unknown): Promise<this> {
    const json = await this.json()
    const expectedStr = JSON.stringify(expected)
    const actualStr = JSON.stringify(json)

    if (expectedStr !== actualStr) {
      throw new Error(
        `Expected JSON ${expectedStr}, got ${actualStr}`
      )
    }

    return this
  }

  /**
   * Assert the response JSON has a value at the given path.
   */
  async assertJsonPath(path: string, expected: unknown): Promise<this> {
    const json = await this.json()
    const value = getNestedValue(json, path)

    if (!deepEqual(value, expected)) {
      throw new Error(
        `Expected ${path} to be ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`
      )
    }

    return this
  }

  /**
   * Assert the response JSON contains the expected data (partial match).
   */
  async assertJsonContains(expected: Record<string, unknown>): Promise<this> {
    const json = await this.json() as Record<string, unknown>

    for (const [key, value] of Object.entries(expected)) {
      if (!deepEqual(json[key], value)) {
        throw new Error(
          `Expected ${key} to be ${JSON.stringify(value)}, got ${JSON.stringify(json[key])}`
        )
      }
    }

    return this
  }

  /**
   * Assert the response body contains the expected text.
   */
  async assertBodyContains(text: string): Promise<this> {
    const body = await this.text()

    if (!body.includes(text)) {
      throw new Error(`Expected body to contain "${text}"`)
    }

    return this
  }

  /**
   * Assert the response is successful (2xx).
   */
  assertSuccessful(): this {
    const status = this.response.status
    if (status < 200 || status >= 300) {
      throw new Error(`Expected successful status (2xx), got ${status}`)
    }
    return this
  }
}

/**
 * Test request builder for fluent API.
 */
export class TestRequestBuilder {
  private url: string
  private method: string
  private _headers: Record<string, string> = {}
  private _body: BodyInit | null = null
  private _cookies: Record<string, string> = {}
  private _session: Record<string, unknown> = {}
  private _user: Authenticatable | null = null
  private fetchFn: (request: Request) => Promise<Response>

  constructor(
    url: string,
    method: string,
    fetchFn: (request: Request) => Promise<Response>
  ) {
    this.url = url
    this.method = method
    this.fetchFn = fetchFn
  }

  /**
   * Set a header.
   */
  withHeader(name: string, value: string): this {
    this._headers[name] = value
    return this
  }

  /**
   * Set multiple headers.
   */
  withHeaders(headers: Record<string, string>): this {
    Object.assign(this._headers, headers)
    return this
  }

  /**
   * Set a cookie.
   */
  withCookie(name: string, value: string): this {
    this._cookies[name] = value
    return this
  }

  /**
   * Set multiple cookies.
   */
  withCookies(cookies: Record<string, string>): this {
    Object.assign(this._cookies, cookies)
    return this
  }

  /**
   * Set session data.
   */
  withSession(data: Record<string, unknown>): this {
    Object.assign(this._session, data)
    return this
  }

  /**
   * Set JSON body.
   */
  withJson(data: unknown): this {
    this._body = JSON.stringify(data)
    this._headers['Content-Type'] = 'application/json'
    return this
  }

  /**
   * Set form data body.
   */
  withForm(data: Record<string, string>): this {
    this._body = new URLSearchParams(data).toString()
    this._headers['Content-Type'] = 'application/x-www-form-urlencoded'
    return this
  }

  /**
   * Set raw body.
   */
  withBody(body: BodyInit, contentType?: string): this {
    this._body = body
    if (contentType) {
      this._headers['Content-Type'] = contentType
    }
    return this
  }

  /**
   * Set the authenticated user.
   */
  actingAs(user: Authenticatable): this {
    this._user = user
    return this
  }

  /**
   * Accept JSON responses.
   */
  acceptJson(): this {
    this._headers['Accept'] = 'application/json'
    return this
  }

  /**
   * Set as Inertia request.
   */
  asInertia(version?: string): this {
    this._headers['X-Inertia'] = 'true'
    if (version) {
      this._headers['X-Inertia-Version'] = version
    }
    return this
  }

  /**
   * Get request details for testing.
   */
  getRequestDetails(): {
    user: Authenticatable | null
    session: Record<string, unknown>
  } {
    return {
      user: this._user,
      session: this._session,
    }
  }

  /**
   * Send the request.
   */
  async send(): Promise<TestResponse> {
    // Build cookie header
    if (Object.keys(this._cookies).length > 0) {
      const cookieStr = Object.entries(this._cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
      this._headers['Cookie'] = cookieStr
    }

    if (this._user) {
      const userData = typeof this._user.getAuthIdentifier === 'function'
        ? { ...this._user, __authId: this._user.getAuthIdentifier() }
        : this._user
      this._headers['X-Testing-User'] = JSON.stringify(userData)
    }
    if (Object.keys(this._session).length > 0) {
      this._headers['X-Testing-Session'] = JSON.stringify(this._session)
    }

    const request = new Request(this.url, {
      method: this.method,
      headers: this._headers,
      body: this._body,
    })

    const response = await this.fetchFn(request)
    return new TestResponse(response)
  }
}

/**
 * Test client for making requests.
 */
export class TestClient {
  private baseUrl: string
  private fetchFn: (request: Request) => Promise<Response>
  private defaultHeaders: Record<string, string> = {}

  constructor(
    baseUrl: string,
    fetchFn: (request: Request) => Promise<Response>
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetchFn = fetchFn
  }

  /**
   * Set default headers for all requests.
   */
  setDefaultHeaders(headers: Record<string, string>): this {
    Object.assign(this.defaultHeaders, headers)
    return this
  }

  /**
   * Create a GET request.
   */
  get(path: string): TestRequestBuilder {
    return this.request('GET', path)
  }

  /**
   * Create a POST request.
   */
  post(path: string): TestRequestBuilder {
    return this.request('POST', path)
  }

  /**
   * Create a PUT request.
   */
  put(path: string): TestRequestBuilder {
    return this.request('PUT', path)
  }

  /**
   * Create a PATCH request.
   */
  patch(path: string): TestRequestBuilder {
    return this.request('PATCH', path)
  }

  /**
   * Create a DELETE request.
   */
  delete(path: string): TestRequestBuilder {
    return this.request('DELETE', path)
  }

  /**
   * Create a QUERY request (RFC 10008): safe and idempotent like GET, but
   * carries a request body like POST.
   */
  query(path: string): TestRequestBuilder {
    return this.request('QUERY', path)
  }

  /**
   * Create a request with any method.
   */
  request(method: string, path: string): TestRequestBuilder {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`
    const builder = new TestRequestBuilder(url, method, this.fetchFn)
    builder.withHeaders(this.defaultHeaders)
    return builder
  }
}

/**
 * Create a test client from an application fetch function.
 */
export function createTestClient(
  fetchFn: (request: Request) => Promise<Response>,
  baseUrl = 'http://localhost'
): TestClient {
  return new TestClient(baseUrl, fetchFn)
}

// Helper functions

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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return a === b

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }

  if (Array.isArray(a) || Array.isArray(b)) return false

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)

  if (aKeys.length !== bKeys.length) return false

  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]))
}
