const HTML_ENTITIES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '&amp;',
  '"': '&quot;',
}

const HTML_DECODE_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
}

export interface ControllerContext {
  var?: {
    container?: {
      make: <T = unknown>(key: string) => T
    }
  }
  req: {
    raw: Request
    path: string
    url: string
    method: string
    query: (key?: string) => string | undefined | Record<string, string>
    queries?: () => Record<string, string[]>
    param?: (key?: string) => string | Record<string, string> | undefined
    header: (name: string) => string | undefined
  }
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  header: (name: string, value: string) => void
  status: (code: number) => void
}

export interface InertiaPayload {
  component: string
  props: Record<string, unknown>
  url: string
  version?: string
}

export function createControllerContext(
  url: string,
  init: RequestInit = {},
  contextValues: Record<string, unknown> = {},
): ControllerContext {
  const request = new Request(url, init)
  const parsedUrl = new URL(request.url)
  const searchParams = parsedUrl.searchParams
  const store = new Map<string, unknown>(Object.entries(contextValues))

  const req = {
    raw: request,
    path: parsedUrl.pathname,
    url: request.url,
    method: request.method,
    query: (key?: string) => {
      if (!key) {
        return Object.fromEntries(searchParams.entries())
      }

      return searchParams.get(key) ?? undefined
    },
    queries: () => {
      const values = new Map<string, string[]>()
      for (const [key, value] of searchParams.entries()) {
        const existing = values.get(key) ?? []
        existing.push(value)
        values.set(key, existing)
      }
      return Object.fromEntries(values)
    },
    param: () => undefined,
    header: (name: string) => request.headers.get(name) ?? undefined,
  }

  return {
    var: {
      container: {
        make: <T = unknown>(key: string) => store.get(key) as T,
      },
    },
    req,
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => { store.set(key, value) },
    header: () => {},
    status: () => {},
  }
}

export function createGurenControllerModule() {
  class Controller {
    public context: ControllerContext | undefined

    setContext(context: ControllerContext): void {
      this.context = context
    }

    public get ctx(): ControllerContext {
      if (!this.context) {
        throw new Error('Controller context has not been set.')
      }

      return this.context
    }

    make<T = unknown>(key: string): T {
      return this.ctx.var?.container?.make<T>(key) as T
    }

    inertia(
      componentOrPage: string | { id: string; component?: string },
      props: Record<string, unknown>,
      options: Record<string, unknown> = {},
    ): Response {
      const ctx = this.ctx
      const request = ctx.req.raw
      const component =
        typeof componentOrPage === 'string'
          ? componentOrPage
          : componentOrPage.component ?? componentOrPage.id
      const url =
        (options.url as string | undefined) ??
        ctx.req.path ??
        new URL(request.url).pathname
      const status = (options.status as number | undefined) ?? 200
      const payload: InertiaPayload = {
        component,
        props,
        url,
        version: options.version as string | undefined,
      }

      const prefersJson =
        request.headers.get('X-Inertia') === 'true' ||
        (request.headers.get('Accept') ?? '').toLowerCase().includes('json')

      if (prefersJson) {
        return new Response(JSON.stringify(payload), {
          status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Inertia': 'true',
          },
        })
      }

      const serialized = JSON.stringify(payload).replace(
        /[<>&"]/gu,
        (char) => HTML_ENTITIES[char] ?? char,
      )

      return new Response(`<div id="app" data-page="${serialized}"></div>`, {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Inertia': 'true',
        },
      })
    }
  }

  return {
    Controller,
    parseRequestPayload: async (ctx: ControllerContext) => {
      const request = ctx.req.raw
      const contentType = request.headers.get('Content-Type') ?? ''

      if (contentType.includes('application/json')) {
        return request.json()
      }

      if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await request.text()
        return Object.fromEntries(new URLSearchParams(text))
      }

      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData()
        const result: Record<string, unknown> = {}
        formData.forEach((value, key) => {
          result[key] = value
        })
        return result
      }

      return {}
    },
    formatValidationErrors: (error: { issues?: Array<{ path: (string | number)[]; message: string }> }) => {
      const errors: Record<string, string> = {}
      if (error?.issues) {
        for (const issue of error.issues) {
          const key = issue.path.join('.')
          if (!errors[key]) {
            errors[key] = issue.message
          }
        }
      }
      return errors
    },
  }
}

export function createControllerModuleMock() {
  const module = createGurenControllerModule()
  const buildValidationErrors = (issues: Array<{ path: (string | number)[]; message: string }> = []) => {
    const errors: Record<string, string[]> = {}

    for (const issue of issues) {
      const key = issue.path.join('.') || 'message'
      if (!errors[key]) {
        errors[key] = []
      }
      errors[key].push(issue.message)
    }

    if (Object.keys(errors).length === 0) {
      errors.message = ['The given data was invalid.']
    }

    return errors
  }

  class TestController extends module.Controller {
    public parsedBody?: Record<string, unknown>

    public runValidation<T>(
      schema: {
        safeParse: (data: unknown) =>
          | { success: true; data: T }
          | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
      },
      data: unknown,
      statusCode: number,
    ): T {
      const result = schema.safeParse(data)
      if (result.success) {
        return result.data
      }

      const error = new ValidationException(buildValidationErrors(result.error.issues))
      error.statusCode = statusCode
      throw error
    }

    public runValidationSafe<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }, data: unknown): { success: true; data: T } | { success: false; errors: Record<string, string> } {
      const result = schema.safeParse(data)
      if (result.success) {
        return { success: true, data: result.data }
      }

      const errors: Record<string, string> = {}
      for (const issue of result.error.issues ?? []) {
        const key = issue.path.join('.') || issue.message
        if (!errors[key]) {
          errors[key] = issue.message
        }
      }

      if (Object.keys(errors).length === 0) {
        errors.message = 'The given data was invalid.'
      }

      return { success: false, errors }
    }

    public get request(): ControllerContext['req'] {
      return this.ctx.req
    }

    public async getBody(): Promise<Record<string, unknown>> {
      if (this.parsedBody) {
        return this.parsedBody
      }

      this.parsedBody = ((await module.parseRequestPayload(this.ctx)) ?? {}) as Record<string, unknown>
      return this.parsedBody
    }

    public async input<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined> {
      const body = await this.getBody()
      if (key in body) {
        return body[key] as T
      }

      const queryValue = this.ctx.req.query(key)
      return (queryValue as T | undefined) ?? defaultValue
    }

    public async validateBody<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): Promise<T> {
      const body = await this.getBody()
      return this.runValidation(schema, body, 422)
    }

    public async validateBodySafe<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): Promise<{ success: true; data: T } | { success: false; errors: Record<string, string> }> {
      const body = await this.getBody()
      return this.runValidationSafe(schema, body)
    }

    public validateQuery<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): T {
      return this.runValidation(schema, this.ctx.req.query(), 422)
    }

    public validateQuerySafe<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): { success: true; data: T } | { success: false; errors: Record<string, string> } {
      return this.runValidationSafe(schema, this.ctx.req.query())
    }

    public validateParams<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): T {
      const paramResolver = (this.ctx.req as { param?: (key?: string) => unknown }).param
      const rawParams = typeof paramResolver === 'function' ? paramResolver() : {}
      const params =
        typeof rawParams === 'string'
          ? { id: rawParams }
          : rawParams && typeof rawParams === 'object'
            ? rawParams
            : {}

      return this.runValidation(schema, params, 400)
    }

    public validateParamsSafe<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): { success: true; data: T } | { success: false; errors: Record<string, string> } {
      const paramResolver = (this.ctx.req as { param?: (key?: string) => unknown }).param
      const rawParams = typeof paramResolver === 'function' ? paramResolver() : {}
      const params =
        typeof rawParams === 'string'
          ? { id: rawParams }
          : rawParams && typeof rawParams === 'object'
            ? rawParams
            : {}

      return this.runValidationSafe(schema, params)
    }

    public apiToken(): { token: unknown; userId: string | number; abilities: string[] } {
      const result = this.ctx.get('guren:api-token') as {
        token: unknown
        userId: string | number
        abilities: string[]
      } | undefined
      if (!result) {
        const error = new Error('Unauthenticated.') as Error & { statusCode: number }
        error.statusCode = 401
        throw error
      }
      return result
    }

    public apiTokenUserId(): string | number {
      return this.apiToken().userId
    }

    public created(data?: unknown, init: ResponseInit = {}): Response {
      if (data === undefined) {
        return new Response(null, { status: 201, ...init })
      }
      return new Response(JSON.stringify(data), {
        status: 201,
        ...init,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(init.headers ?? {}),
        },
      })
    }

    public noContent(): Response {
      return new Response(null, { status: 204 })
    }

    public json(data: unknown, init: ResponseInit = {}): Response {
      return new Response(JSON.stringify(data), {
        ...init,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(init.headers ?? {}),
        },
      })
    }

    public redirect(url: string, options: { status?: number } = {}): Response {
      const defaultStatus = this.ctx.req.method !== 'GET' ? 303 : 302
      const status = options.status ?? defaultStatus

      return new Response(null, {
        status,
        headers: {
          Location: url,
        },
      })
    }
  }

  class Event {}
  class Listener {}
  class Job {}
  class AuthenticatableModel {
    static table: unknown = null
    static recordType: unknown = {}
    static relationTypes: unknown = {}

    static async find(): Promise<unknown> {
      return null
    }

    static async where(): Promise<unknown[]> {
      return []
    }

    static async update(): Promise<void> {}

    // Relation registrars are no-ops so model modules that declare
    // relations at import time load cleanly under the mock.
    static hasMany(): void {}
    static hasOne(): void {}
    static belongsTo(): void {}
    static belongsToMany(): void {}
    static hasManyThrough(): void {}
    static morphMany(): void {}
    static morphTo(): void {}

    static async with(): Promise<unknown[]> {
      return []
    }

    static async withCount(): Promise<unknown[]> {
      return []
    }

    static async findWith(): Promise<unknown> {
      return null
    }
  }
  class Resource<T = Record<string, unknown>> {
    public resource: T
    public additionalData: Record<string, unknown> = {}

    constructor(resource: T) {
      this.resource = resource
    }

    toArray(): Record<string, unknown> {
      return { ...(this.resource as Record<string, unknown>) }
    }

    toJSON(): Record<string, unknown> {
      return {
        ...this.toArray(),
        ...this.additionalData,
      }
    }

    additional(data: Record<string, unknown>): this {
      this.additionalData = { ...this.additionalData, ...data }
      return this
    }

    when<V>(condition: boolean, value: V | (() => V)): V | undefined {
      if (!condition) {
        return undefined
      }
      return typeof value === 'function' ? (value as () => V)() : value
    }

    whenLoaded<V>(relation: string, value: V | (() => V), defaultValue?: V): V | undefined {
      const resource = this.resource as Record<string, unknown>
      const isLoaded = relation in resource && resource[relation] !== undefined

      if (!isLoaded) {
        return defaultValue
      }

      return typeof value === 'function' ? (value as () => V)() : value
    }

    static make<TResource, R extends Resource<TResource>>(
      this: new (resource: TResource) => R,
      resource: TResource,
    ): R {
      return new this(resource)
    }

    static collection<TResource, R extends Resource<TResource>>(
      this: new (resource: TResource) => R,
      resources: TResource[],
    ): Record<string, unknown>[] {
      return resources.map((resource) => new this(resource).toJSON())
    }
  }

  class JsonResource<T extends Record<string, unknown>> extends Resource<T> {
    toArray(): Record<string, unknown> {
      return { ...this.resource }
    }
  }

  const collect = <TResource, R extends Resource<TResource>>(
    resources: TResource[],
    resourceClass: new (resource: TResource) => R,
  ): Record<string, unknown>[] => {
    return resources.map((resource) => new resourceClass(resource).toJSON())
  }
  class ValidationException extends Error {
    statusCode = 422
    errors: Record<string, string[]>

    constructor(errors: Record<string, string[]>, message = 'The given data was invalid.') {
      super(message)
      this.name = 'ValidationException'
      this.errors = errors
    }

    static withMessages(messages: Record<string, string | string[]>): ValidationException {
      const errors: Record<string, string[]> = {}
      for (const [key, value] of Object.entries(messages)) {
        errors[key] = Array.isArray(value) ? value : [value]
      }
      return new ValidationException(errors)
    }

    static fromZodError(zodError: { issues?: Array<{ path: (string | number)[]; message: string }> }): ValidationException {
      const errors: Record<string, string[]> = {}
      if (zodError?.issues) {
        for (const issue of zodError.issues) {
          const key = issue.path.join('.') || 'message'
          if (!errors[key]) {
            errors[key] = []
          }
          errors[key].push(issue.message)
        }
      }
      return new ValidationException(errors)
    }
  }

  class AuthenticationException extends Error {
    statusCode = 401

    constructor(message = 'Unauthenticated.') {
      super(message)
      this.name = 'AuthenticationException'
    }
  }

  const getApiTokenOrFail = (
    ctx: ControllerContext,
  ): { token: unknown; userId: string | number; abilities: string[] } => {
    const result = ctx.get('guren:api-token') as {
      token: unknown
      userId: string | number
      abilities: string[]
    } | undefined
    if (!result) {
      throw new AuthenticationException('Unauthenticated.')
    }
    return result
  }

  class MemoryApiTokenStore {
    clear(): void {}
  }

  const createApiToken = async (
    _store: unknown,
    options: { name: string; userId: number | string; abilities: string[]; expiresIn?: number | null },
  ): Promise<{
    plainTextToken: string
    token: {
      id: string
      name: string
      userId: number | string
      abilities: string[]
      createdAt: Date
      lastUsedAt: Date | null
      expiresAt: Date | null
    }
  }> => {
    const expiresAt =
      typeof options.expiresIn === 'number' ? new Date(Date.now() + options.expiresIn) : null

    return {
      plainTextToken: 'test-token',
      token: {
        id: 'token-id',
        name: options.name,
        userId: options.userId,
        abilities: options.abilities,
        createdAt: new Date(),
        lastUsedAt: null,
        expiresAt,
      },
    }
  }

  const revokeApiToken = async (): Promise<void> => {}

  const getUserApiTokens = async (): Promise<
    Array<{
      id: string
      name: string
      abilities: string[]
      createdAt: Date
      lastUsedAt: Date | null
      expiresAt: Date | null
    }>
  > => {
    return []
  }

  const getApiToken = (): { userId: number | string; abilities: string[] } | null => {
    return null
  }
  const createEventManager = () => ({
    on: () => {},
    emit: async () => {},
  })
  const createMailManager = () => ({})
  const setMailManager = () => {}
  const setQueueDriver = () => {}
  const registerJob = () => {}
  class MemoryDriver {}
  const createCacheManager = () => ({
    store: () => ({
      remember: async (_key: string, _ttl: number, callback: () => Promise<unknown>) => callback(),
      delete: async () => {},
      clear: async () => {},
    }),
  })

  return {
    ...module,
    Controller: TestController,
    Event,
    Listener,
    Job,
    AuthenticatableModel,
    Resource,
    JsonResource,
    collect,
    ValidationException,
    AuthenticationException,
    MemoryApiTokenStore,
    createApiToken,
    revokeApiToken,
    getUserApiTokens,
    getApiToken,
    getApiTokenOrFail,
    createEventManager,
    createMailManager,
    setMailManager,
    setQueueDriver,
    registerJob,
    MemoryDriver,
    createCacheManager,
  }
}

export async function readInertiaResponse(response: Response): Promise<{
  format: 'json' | 'html'
  payload: InertiaPayload
  body?: string
}> {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return {
      format: 'json',
      payload: (await response.json()) as InertiaPayload,
    }
  }

  const body = await response.text()
  const match = body.match(/data-page="([^"]+)"/)

  if (!match) {
    throw new Error('Unable to find Inertia payload in HTML response.')
  }

  const decoded = decodeHtml(match[1])
  const payload = JSON.parse(decoded) as InertiaPayload

  return {
    format: 'html',
    payload,
    body,
  }
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:quot|amp|lt|gt);/g, (entity) => HTML_DECODE_ENTITIES[entity] ?? entity)
}
