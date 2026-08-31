import { HonoRequest } from 'hono/request'
import {
  asRecord,
  flattenRequestQueries as flattenRequestQueriesByRuntimeRules,
  parseRequestBody as parseRequestBodyByRuntimeRules,
  parseRequestUploads as parseRequestUploadsByRuntimeRules,
  type RequestUploads,
} from '@guren/server/internal/request'

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
  const store = new Map<string, unknown>(Object.entries(contextValues))

  // The same class a live request is read through, so both query surfaces
  // below are Hono's own rather than a restatement of them. Both were restated
  // here once and both drifted: `query()` kept the LAST occurrence of a
  // repeated key where Hono keeps the FIRST, and — fixed by delegating rather
  // than by patching the copy again — it dropped a `__proto__` key outright,
  // because building the record by assignment hits the inherited setter where
  // Hono's null-prototype object has no setter to hit.
  //
  // Reading a body is what needs a `clone()` (see parseRequestBody); these two
  // read only the URL, so this wraps `request` directly and leaves it intact.
  const honoRequest = new HonoRequest(request)

  const req = {
    raw: request,
    path: parsedUrl.pathname,
    url: request.url,
    method: request.method,
    query: (key?: string) => (key === undefined ? honoRequest.query() : honoRequest.query(key)),
    queries: () => honoRequest.queries(),
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

/**
 * `@guren/server` is loaded lazily and memoized: this module is the factory
 * behind `vi.mock('@guren/core', …)` — and the testing package's own suite
 * mocks `@guren/server` with it — so a top-level import of either specifier
 * is circular under vitest's hoisting (TDZ on the hoisted binding). The
 * documented app pattern mocks `@guren/core`, which leaves `@guren/server`
 * real; a suite that mocks `@guren/server` itself gets a mock in which
 * `view()`/`viteAsset` are unavailable — circular by construction.
 */
type ServerModule = typeof import('@guren/server')
let loadedServer: ServerModule | undefined
let serverModulePromise: Promise<ServerModule> | undefined

function loadServer(): Promise<ServerModule> {
  serverModulePromise ??= import('@guren/server').then((mod) => {
    loadedServer = mod
    return mod
  })
  return serverModulePromise
}

/**
 * The mock's request body: the parsed value as sent, so an array stays an
 * array for `validateBody()` to judge.
 *
 * Nothing about a body is decided here. Which content types are read, how a
 * repeated `field[]` collapses, what an undecodable body falls back to — all
 * of it comes from the runtime's own parser, reached through
 * `@guren/server/internal/request`. The mock used to carry a second copy of
 * those rules, and every one of them drifted at least once: an uppercase media
 * type, a `;`-parameterized one, a repeated `field[]`, a `__proto__` field,
 * an undecodable body. Each was fixed in the copy; sharing the parser is what
 * stops the next one.
 *
 * What stays local is the adapter — see {@link honoRequestFor}.
 */
async function parseRequestBody(ctx: ControllerContext): Promise<unknown> {
  const req = honoRequestFor(ctx)
  return req ? parseRequestBodyByRuntimeRules({ req }) : {}
}

/**
 * The mock's uploads, behind {@link Controller.file} / {@link Controller.files}
 * — the same delegation as {@link parseRequestBody}, to the runtime's
 * `parseRequestUploads` rather than to its body parser.
 *
 * The two are a deliberate pair and not interchangeable: this one parses with
 * `{ all: true }`, so a field repeated in the body stays an array and `files()`
 * sees every part. The body parser flattens the same field to its first value.
 *
 * There is no media-type gate on this side either, and its absence is the fix.
 * The mock used to gate on Hono's rule and then read the body with
 * `Request.formData()`, which is case-sensitive on Bun where Hono lowercases
 * first — so `MULTIPART/FORM-DATA` threw out of `formData()` and `file()`
 * answered `null` for a body the runtime delivered the file for. Measured on
 * Bun; Node's `formData()` is case-insensitive, so the same suite run there
 * could not see it. Hono decides the media type inside `parseBody()` now, on
 * both sides, so there is nothing left to disagree about.
 */
async function parseRequestUploads(ctx: ControllerContext): Promise<RequestUploads> {
  const req = honoRequestFor(ctx)
  return req ? parseRequestUploadsByRuntimeRules({ req }) : {}
}

/**
 * The whole of what stays local, because the two sides hold different things:
 * the runtime is handed a Hono context, the mock holds a `Request`. A
 * `HonoRequest` bridges them, supplying the members the shared parsers read
 * (`header()`, `json()`, `parseBody()`) from the same class a live request
 * does — so even the media-type decision inside `parseBody()` is Hono's own
 * rather than a restatement of it.
 *
 * Answers `null` on the one failure that is the adapter's own: `clone()` throws
 * on a body already read, which cannot happen to the runtime because Hono hands
 * it the request before anything else touches it. Callers turn that into the
 * empty answer. Everything past this point is the shared parser's to answer,
 * including the `{}` it returns for a body no parser can decode — catching that
 * here too would let the mock swallow a throw the runtime would surface.
 */
function honoRequestFor(ctx: ControllerContext): HonoRequest | null {
  // Read outside the fallback on purpose: the fallback is for an unparseable
  // *body*, and a ctx with no request at all is a broken test setup. Swallowing
  // that into `{}` would turn a wiring mistake into a confusing validation
  // failure, and the runtime's parsers do not swallow it either.
  const raw = ctx.req.raw

  try {
    // Clone so the raw body stays readable — the real runtime caches the
    // parsed body in Hono, letting validateBody() and file() compose on one
    // request; here the clone is what preserves that property.
    return new HonoRequest(raw.clone())
  } catch {
    return null
  }
}

/**
 * Query data as a validation schema sees it: a repeated key as an array, a
 * single occurrence as a plain string (`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`,
 * `?page=2` → `{ page: '2' }`).
 *
 * Nothing about that shape is decided here — it is the runtime's own
 * `flattenRequestQueries`, reached through `@guren/server/internal/request`,
 * exactly as the body parser above reaches the runtime's parser. Only the
 * adapter is local, and it exists for one reason: the runtime calls
 * `ctx.req.queries()` unconditionally, while `queries()` is *optional* on
 * {@link ControllerContext}, so a hand-built context may not carry one.
 *
 * For a context that does, its own `queries()` is handed to the shared rule —
 * an override on a published type stays honored. For one that does not, the
 * grouping is re-derived from the required `req.url` through a `HonoRequest`,
 * which is the same grouping `createControllerContext` gets. That branch must
 * not fall back to `query()`: that surface is one value per key by
 * construction, which is the divergence this function exists to close.
 *
 * `ctx.req.queries` is tested for truthiness, never with `'queries' in ctx.req`
 * — a context built by spreading one and blanking the member carries the key
 * with an explicit `undefined`, so an `in` test would take the override branch
 * and call `undefined()`.
 */
function flattenContextQueries(ctx: ControllerContext): Record<string, unknown> {
  const { req } = ctx
  return flattenRequestQueriesByRuntimeRules({
    // Invoked as a method on `ctx.req`, never handed over as a bare reference.
    // `queries?: () => …` is satisfied by a *method* as readily as by an arrow,
    // and a method reading `this.url` is a reasonable way to write an override;
    // passing `{ queries }` would re-`this` it onto that fresh literal and read
    // `undefined`. The wrapper is what keeps the receiver.
    req: req.queries ? { queries: () => req.queries!() } : new HonoRequest(new Request(req.url)),
  })
}

export function createGurenControllerModule() {
  // Prime the memo now: continuations on one promise run in registration
  // order, so by the time an awaited view() render invokes a component that
  // calls the sync viteAsset below, the memo is already populated.
  void loadServer()

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

    text(body: string, init: ResponseInit = {}): Response {
      return new Response(body, {
        ...init,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...init.headers,
        },
      })
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
      // Mirrors the real inertia() engine: the page url defaults to the
      // request's pathname plus query string, per the Inertia protocol.
      let url = options.url as string | undefined
      if (url === undefined) {
        const { pathname, search } = new URL(request.url)
        url = `${pathname}${search}`
      }
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

      const serialized = JSON.stringify(payload).replace(/</gu, '\\u003c')

      return new Response(`<script data-page="app" type="application/json">${serialized}</script><div id="app"></div>`, {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Inertia': 'true',
        },
      })
    }

    /**
     * Delegates to the real `renderDocument()` from `@guren/server` — the
     * same engine `Controller.view()` uses — so the mock cannot drift on
     * escaping, the fragment guard, or response shaping. Importing
     * `@guren/server` here is established practice (`queue.ts` does), and
     * only the `@guren/core` specifier is replaced by `vi.mock`.
     */
    async view(
      component: ((props: never) => unknown) & { displayName?: string; name?: string },
      props: unknown,
      options: ResponseInit & { doctype?: boolean } = {},
    ): Promise<Response> {
      const { renderDocument } = await loadServer()
      return renderDocument(component as never, props as never, options)
    }
  }

  return {
    Controller,
    /**
     * The real `viteAsset()` from `@guren/server`: under vitest
     * (`NODE_ENV` is never `production`) it takes the dev branch and returns
     * deterministic dev-server URLs; a test that forces production gets the
     * real manifest lookup — including the missing-entry throw — rather
     * than a fiction that hides a forgotten build input. Sync by contract,
     * so it reads the lazily-primed memo (populated before any `view()`
     * render reaches a component; see `loadServer`).
     */
    viteAsset: (entry: string, options?: { manifestPaths?: string[] }): string => {
      if (!loadedServer) {
        throw new Error(
          'viteAsset(): the mock resolves @guren/server lazily — render through ' +
            'view(), or `await Promise.resolve()` once after creating the mock, ' +
            'before calling viteAsset() directly.',
        )
      }
      return loadedServer.viteAsset(entry, options)
    },
    parseRequestPayload: async (ctx: ControllerContext) => asRecord(await parseRequestBody(ctx)),
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

    // Mirrors the real Controller's split: validation sees the body as sent
    // (an array stays an array), while the field-by-field helpers see the
    // record view.
    //
    // Public like parsedBody below: TS4094 forbids private members on the
    // exported anonymous class type this factory returns. Boxed rather than
    // memoized by truthiness, because `null`, `''`, `0` and `false` are all
    // parsed bodies.
    public rawBody?: { value: unknown }

    // Deliberately the local raw parser, not `module.parseRequestPayload` —
    // that one narrows, which is what made a non-object body unreachable. No
    // fallback of its own either: an unparseable body already arrives as `{}`
    // from the parser above, which is also what `parseRequestPayload` reads,
    // so both views agree.
    //
    // Memoized for parity rather than for speed. Cloning the request means
    // there is nothing to exhaust here, so re-parsing is safe — but it is not
    // *equal*: the real Controller boxes its parse, so two `validateBody()`
    // calls in one action are handed the same object, where re-parsing hands
    // out two. A schema that mutates what it validates, or an identity check
    // across two reads, saw the mock and the runtime disagree.
    public async getRawBody(): Promise<unknown> {
      this.rawBody ??= { value: await parseRequestBody(this.ctx) }
      return this.rawBody.value
    }

    public async getBody(): Promise<Record<string, unknown>> {
      if (this.parsedBody) {
        return this.parsedBody
      }

      this.parsedBody = asRecord(await this.getRawBody())
      return this.parsedBody
    }

    // Public like parsedBody above: TS4094 forbids private members on the
    // exported anonymous class type this factory returns.
    //
    // Its type follows the runtime's upload read, which is what it now is: the
    // `{ all: true }` record `parseBody()` answers with, not the `FormData`
    // this used to hold. A non-multipart body is `{}` here rather than `null`
    // for the same reason — the runtime has no media-type gate to answer
    // `null` from. `file()` and `files()` are unaffected: a urlencoded field
    // arrives as a string, which fails their `instanceof File` test exactly as
    // an absent field does.
    public multipartBody?: Promise<RequestUploads>

    public readMultipart(): Promise<RequestUploads> {
      if (!this.multipartBody) {
        // Memoized so repeated file()/files() calls are one parse, and that
        // parse clones the request, mirroring Hono's cache. The undecodable
        // body is already handled inside the shared read, so what is memoized
        // is always a resolved promise — never a rejected one the two callers
        // would each have to guard.
        this.multipartBody = parseRequestUploads(this.ctx)
      }
      return this.multipartBody
    }

    public async file(name: string): Promise<File | null> {
      // Character for character the real Controller.file(): take the FIRST
      // part of the field, then require it to be a non-empty File — a leading
      // empty part means null, not "skip to the next one".
      const body = await this.readMultipart()
      const value = body[name]
      const candidate = Array.isArray(value) ? value[0] : value
      return candidate instanceof File && candidate.size > 0 ? candidate : null
    }

    public async files(name: string): Promise<File[]> {
      const body = await this.readMultipart()
      const value = body[name]
      const values = Array.isArray(value) ? value : value !== undefined ? [value] : []
      return values.filter((item): item is File => item instanceof File && item.size > 0)
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
      return this.runValidation(schema, await this.getRawBody(), 422)
    }

    public async validateBodySafe<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): Promise<{ success: true; data: T } | { success: false; errors: Record<string, string> }> {
      return this.runValidationSafe(schema, await this.getRawBody())
    }

    public validateQuery<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): T {
      return this.runValidation(schema, flattenContextQueries(this.ctx), 422)
    }

    public validateQuerySafe<T>(schema: {
      safeParse: (data: unknown) =>
        | { success: true; data: T }
        | { success: false; error: { issues?: Array<{ path: (string | number)[]; message: string }> } }
    }): { success: true; data: T } | { success: false; errors: Record<string, string> } {
      return this.runValidationSafe(schema, flattenContextQueries(this.ctx))
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

    // Read/write entry points a controller commonly reaches for. They are
    // inert, but they have to exist: tests drive model behaviour by spying
    // on them, and a spy cannot replace a method that was never defined.
    static async all(): Promise<unknown[]> {
      return []
    }

    static async create(): Promise<unknown> {
      return {}
    }

    static async findOrFail(): Promise<unknown> {
      return {}
    }

    static async first(): Promise<unknown> {
      return null
    }

    static async delete(): Promise<void> {}

    /** Chainable like the real query builder, and awaitable at any point. */
    static select(): Record<string, unknown> {
      const query: Record<string, unknown> = {
        get: async () => [],
        first: async () => null,
        then: (resolve: (value: unknown[]) => unknown) => resolve([]),
      }
      for (const method of ['where', 'whereNotNull', 'whereNull', 'orderBy', 'limit', 'offset']) {
        query[method] = () => query
      }
      return query
    }
  }
  /**
   * `defineModel()` is the function form of a model declaration, and
   * `@guren/core` exports it alongside the class form — so a controller
   * under test can reach it through any model module it imports. It returns
   * the same inert stub, named after the table it was given.
   */
  function defineModel(table: unknown, config: Record<string, unknown> = {}) {
    return class DefinedModel extends AuthenticatableModel {
      static override table = table
      static config = config
    }
  }

  // Second parameter mirrors the real `Resource<T, TData>`: the mock is what a
  // test file's `extends Resource<PostRecord, PostResourceData>` resolves to,
  // so a mirror stuck on one parameter rejects the shape the scaffolds emit.
  class Resource<T = Record<string, unknown>, TData extends Record<string, unknown> = Record<string, unknown>> {
    public resource: T
    public additionalData: Record<string, unknown> = {}

    constructor(resource: T) {
      this.resource = resource
    }

    toArray(): TData {
      return { ...(this.resource as Record<string, unknown>) } as TData
    }

    toJSON(): TData {
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
  /**
   * A module's `index.ts` calls `defineModule()` at import time and lists
   * providers that `extend ServiceProvider`, so both are evaluated as soon as
   * a controller reaches the module's public surface. Without them here, such
   * a controller cannot be loaded under this mock at all.
   *
   * `defineModule` mirrors the real one in
   * `packages/server/src/container/defineModule.ts` — same four fields, same
   * `providers` normalization — spelled out by hand because this file imports
   * nothing, so the mock never depends on a fresh framework build.
   */
  class ServiceProvider {
    constructor(public container: unknown) {}

    register(): void {}

    boot(): void {}
  }

  const defineModule = (definition: {
    name: string
    prefix?: string
    routes?: unknown
    providers?: unknown[]
  }) => ({
    name: definition.name,
    prefix: definition.prefix,
    routes: definition.routes,
    providers: definition.providers ?? [],
  })

  /**
   * Mirrors the real `definePlugin` in
   * `packages/server/src/container/definePlugin.ts` — hand-copied for the
   * same reason as `defineModule` above. Plugin packages call it at import
   * time (e.g. `@guren/plugin-markdown`), so controllers that transitively
   * import one cannot load under this mock without it. Each factory call
   * yields an independent provider extending the mock `ServiceProvider`,
   * with the configuration captured in a closure and `register`'s result
   * propagated (the real container awaits an async register).
   */
  const definePlugin = <TConfig>(definition: {
    name: string
    register: (container: unknown, config: TConfig) => void | Promise<void>
    boot?: (container: unknown, config: TConfig) => void | Promise<void>
    deferred?: boolean
    provides?: string[]
  }) => {
    return (config: TConfig) => {
      class PluginProvider extends ServiceProvider {
        static deferred = definition.deferred ?? false
        static provides = definition.provides ?? []
        override register(): void | Promise<void> {
          return definition.register(this.container, config)
        }
        override boot(): void | Promise<void> {
          return definition.boot?.(this.container, config)
        }
      }
      Object.defineProperty(PluginProvider, 'name', {
        value: `${definition.name}PluginProvider`,
      })
      return PluginProvider
    }
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
    defineModel,
    Resource,
    JsonResource,
    collect,
    ValidationException,
    AuthenticationException,
    ServiceProvider,
    defineModule,
    definePlugin,
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

  // Inertia v3: the payload lives in a JSON script element. Scan open tags
  // and check attributes with `includes` — chaining several `[^>]*` groups in
  // one regex backtracks polynomially on large HTML bodies. Tag names are
  // case-insensitive in HTML, so both patterns and the attribute comparison
  // are too.
  let scriptPayload: string | undefined
  const openTagPattern = /<script\b[^>]*>/gi
  let openTag: RegExpExecArray | null
  while ((openTag = openTagPattern.exec(body)) !== null) {
    const tag = openTag[0].toLowerCase()
    if (tag.includes('data-page="app"') && tag.includes('type="application/json"')) {
      const closeTagPattern = /<\/script\s*>/gi
      closeTagPattern.lastIndex = openTagPattern.lastIndex
      const closeTag = closeTagPattern.exec(body)
      if (closeTag) {
        scriptPayload = body.slice(openTagPattern.lastIndex, closeTag.index)
      }
      break
    }
  }

  let payload: InertiaPayload
  if (scriptPayload) {
    payload = JSON.parse(scriptPayload) as InertiaPayload
  } else {
    // Legacy (pre-v3): payload in the container's data-page attribute.
    const match = body.match(/data-page="([^"]+)"/)
    if (!match) {
      throw new Error('Unable to find Inertia payload in HTML response.')
    }
    payload = JSON.parse(decodeHtml(match[1])) as InertiaPayload
  }

  return {
    format: 'html',
    payload,
    body,
  }
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:quot|amp|lt|gt);/g, (entity) => HTML_DECODE_ENTITIES[entity] ?? entity)
}
