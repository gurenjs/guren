import { HonoRequest } from 'hono/request'
import type { Context, InertiaResponse, ResolvedSharedInertiaProps } from '@guren/server'
import {
  asRecord,
  parseRequestBody,
  type RequestBodyContext,
  VALIDATED_INPUT_CONTEXT_KEY,
  type ValidatedInputRecord,
} from '@guren/server/internal/request'
import {
  AuthenticationException,
  Controller as RuntimeController,
  type InertiaPageContractLike,
  type InertiaResponseOptions,
  JsonResource,
  Resource,
  ServiceProvider,
  ValidationException,
  acceptsJson,
  collect,
  defineModule,
  definePlugin,
  formatValidationErrors,
  serializePage,
} from '@guren/server/internal/testing'

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
      has?: (key: string) => boolean
    }
    [key: string]: unknown
  }
  req: {
    raw: Request
    path: string
    url: string
    method: string
    query: (key?: string) => string | undefined | Record<string, string>
    queries: () => Record<string, string[]>
    param: (key?: string) => string | Record<string, string> | undefined
    header: (name: string) => string | undefined
    json: HonoRequest['json']
    parseBody: HonoRequest['parseBody']
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

/**
 * Context values that stand in for the route contract middleware, for a controller
 * action reading `this.validated()`: spread into `createControllerContext`'s
 * `contextValues`. Values are passed through as the schemas would have parsed them.
 */
export function contractInput(input: {
  route?: string
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}): Record<string, unknown> {
  return { [VALIDATED_INPUT_CONTEXT_KEY]: { route: undefined, ...input } satisfies ValidatedInputRecord }
}

export function createControllerContext(
  url: string,
  init: RequestInit = {},
  contextValues: Record<string, unknown> = {},
): ControllerContext {
  const request = new Request(url, init)
  const parsedUrl = new URL(request.url)
  const store = new Map<string, unknown>(Object.entries(contextValues))
  // Context values double as bindings. An unbound key is `undefined` rather than the
  // Container's throw; `has()` is what lets `gate` or `i18n` seeded here resolve.
  const container = {
    make: <T = unknown>(key: string) => store.get(key) as T,
    has: (key: string) => store.has(key),
  }

  // One HonoRequest per request, as a live one has: its body cache is what lets
  // `validateBody()` and `file()` read the same body in one action.
  const honoRequest = new HonoRequest(request)

  const req = {
    raw: request,
    path: parsedUrl.pathname,
    url: request.url,
    method: request.method,
    query: (key?: string) => (key === undefined ? honoRequest.query() : honoRequest.query(key)),
    queries: () => honoRequest.queries(),
    // Hono answers `{}` on a route with no parameters, and `validateParams()` hands it on as is.
    param: () => ({}),
    header: (name: string) => request.headers.get(name) ?? undefined,
    json: honoRequest.json.bind(honoRequest),
    parseBody: honoRequest.parseBody.bind(honoRequest),
  }

  return {
    // Hono's `c.var` reads the same store `c.set()` writes.
    get var() {
      return { ...Object.fromEntries(store), container }
    },
    req,
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => { store.set(key, value) },
    header: () => {},
    status: () => {},
  }
}

/**
 * `@guren/server` is loaded lazily and memoized: this module is the factory behind
 * `vi.mock('@guren/core', …)`, so a top-level import of either specifier is circular
 * under vitest's hoisting (TDZ on the hoisted binding). A suite that mocks
 * `@guren/server` itself gets a mock without `view()`/`viteAsset`.
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
 * The Inertia response without a booted app: no shared props, root document, asset
 * version or SSR, which is why the mock keeps it. The JSON-or-HTML choice and the
 * payload escaping are the engine's own.
 */
function renderInertia(
  request: Request,
  componentOrPage: string | InertiaPageContractLike,
  props: Record<string, unknown>,
  options: InertiaResponseOptions,
): InertiaResponse<string, Record<string, unknown>> {
  const component =
    typeof componentOrPage === 'string'
      ? componentOrPage
      : componentOrPage.component ?? componentOrPage.id
  let url = options.url
  if (url === undefined) {
    const { pathname, search } = new URL(request.url)
    url = `${pathname}${search}`
  }
  const payload: InertiaPayload = {
    component,
    props,
    url,
    version: options.version,
  }
  const serialized = serializePage(payload)
  const prefersJson = request.headers.has('X-Inertia') || acceptsJson(request)

  const response = new Response(
    prefersJson ? serialized : `<script data-page="app" type="application/json">${serialized}</script><div id="app"></div>`,
    {
      status: options.status ?? 200,
      headers: {
        'Content-Type': prefersJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
        'X-Inertia': 'true',
        Vary: 'Accept',
        ...options.headers,
      },
    },
  )

  return Object.assign(response, { __gurenInertia: { component, props } })
}

export function createGurenControllerModule() {
  // Prime the memo now: continuations on one promise run in registration order, so
  // the memo is populated before an awaited view() render reaches the sync viteAsset.
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
      return renderInertia(this.ctx.req.raw, componentOrPage, props, options as InertiaResponseOptions)
    }

    /**
     * Delegates to the real `renderDocument()` — the same engine `Controller.view()`
     * uses — so the mock cannot drift on escaping, the fragment guard or shaping.
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
     * The real `viteAsset()`: under vitest it takes the dev branch, while a test that
     * forces production gets the real manifest lookup and its missing-entry throw.
     * Sync by contract, so it reads the lazily-primed memo (see `loadServer`).
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
    parseRequestPayload: async (ctx: ControllerContext) =>
      asRecord(await parseRequestBody(ctx as unknown as RequestBodyContext)),
    formatValidationErrors,
  }
}

/**
 * The runtime's own `Controller`, so every request, validation and response helper is
 * the one production runs. Overridden only where the runtime needs a booted app.
 * Top-level rather than inside the factory: the declaration then names the base
 * class, which is what lets it keep its private members (TS4094).
 */
class TestController extends RuntimeController {
  // Also takes the context `createControllerContext()` is typed as, whose container
  // stands in for the one the router would pass to `setContainer()`.
  override setContext(context: Context | ControllerContext): void {
    super.setContext(context as unknown as Context)
    const container = (context as ControllerContext).var?.container
    if (container) {
      this.setContainer(container)
    }
  }

  protected override inertia<Component extends string, Props extends Record<string, unknown>>(
    component: Component,
    props: Props,
    options?: InertiaResponseOptions,
  ): Promise<InertiaResponse<Component, Props & ResolvedSharedInertiaProps>>
  protected override inertia<TPage extends InertiaPageContractLike>(
    page: TPage,
    props: NonNullable<TPage['__props']>,
    options?: InertiaResponseOptions,
  ): Promise<InertiaResponse<TPage['id'], NonNullable<TPage['__props']> & ResolvedSharedInertiaProps>>
  protected override async inertia(
    componentOrPage: string | InertiaPageContractLike,
    props: Record<string, unknown>,
    options: InertiaResponseOptions = {},
  ): Promise<Response> {
    return renderInertia(this.ctx.req.raw, componentOrPage, props, options)
  }
}

export function createControllerModuleMock() {
  const module = createGurenControllerModule()

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

    // Inert, but they have to exist: tests drive model behaviour by spying on them,
    // and a spy cannot replace a method that was never defined.
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
   * The function form of a model declaration, reachable through any model module a
   * controller imports. Returns the same inert stub, named after the table.
   */
  function defineModel(table: unknown, config: Record<string, unknown> = {}) {
    return class DefinedModel extends AuthenticatableModel {
      static override table = table
      static config = config
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

  // Inertia v3: the payload lives in a JSON script element. Attributes are checked
  // with `includes` because chaining several `[^>]*` groups in one regex backtracks
  // polynomially on large bodies. HTML tag names are case-insensitive, so this is too.
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
