/**
 * Server side of prototype mode (RFC 0021 Part 2): a route registered with the
 * `prototype` handler answers from the app's fixture module until a
 * controller replaces it. Development only; `Application` refuses to boot such
 * routes in production without `GUREN_PROTOTYPE_ROUTES=1`. The fixture
 * contract is consumed structurally, so this never imports the client package.
 */
import type { Context } from 'hono'
import { ValidationException } from '../errors/exceptions/ValidationException'
import { HttpException } from '../errors/HttpException'
import { getSessionFromContext } from '../http/middleware/session'
import type { ValidationSchema } from '../http/middleware/validation'
import { flattenRequestQueries, formatValidationErrors, parseRequestBody } from '../http/request'
import { inertia } from './inertia/InertiaEngine'
import { resolveSharedInertiaProps } from './inertia/shared'
import type { ContainerLike } from '../container/types'

const PROTOTYPE_HANDLER: unique symbol = Symbol.for('guren.prototype.handler')

/** The branded object `router.get(path, prototype)` registers; never a function, so contract wrapping cannot hide it. */
export interface PrototypeRouteHandler {
  readonly [PROTOTYPE_HANDLER]: true
}

export const prototype: PrototypeRouteHandler = Object.freeze({ [PROTOTYPE_HANDLER]: true as const })

export function isPrototypeHandler(value: unknown): value is PrototypeRouteHandler {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[PROTOTYPE_HANDLER] === true
}

export type PrototypeResult =
  | { kind: 'page'; component: string; props: Record<string, unknown> }
  | { kind: 'redirect'; to: string; params?: Record<string, string | number> }
  | { kind: 'location'; url: string }
  | { kind: 'errors'; errors: Record<string, string> }
  | { kind: 'not-found' }

export interface PrototypeServerContext {
  method: string
  url: string
  params: Record<string, string>
  query: Record<string, unknown>
  /** The raw request body, as the browser client hands it over; the route's schema has already validated it. */
  body: unknown
  state: unknown
  shared: Record<string, unknown>
  page(contract: { id: string; component?: string }, props: Record<string, unknown>): PrototypeResult
  redirect(to: string, params?: Record<string, string | number>): PrototypeResult
  location(url: string): PrototypeResult
  /** No error bag: the framework's `ValidationException` has none, so the client-side `bag` is ignored here. */
  errors(errors: Record<string, string>): PrototypeResult
  notFound(): PrototypeResult
  flash(key: string, value: unknown): void
}

export type PrototypeServerHandler = (ctx: PrototypeServerContext) => PrototypeResult | Promise<PrototypeResult>

/**
 * What `definePrototype()` from `@guren/inertia-client/prototype` produces,
 * seen from the server. Handlers are accepted at `(ctx: never) => unknown`:
 * the client types each one against its own manifest and page contracts,
 * which is contravariant with any concrete context declared here, and the
 * runtime hands over {@link PrototypeServerContext} and checks the result's `kind`.
 */
export interface PrototypeFixture {
  manifest: Record<string, { method: string; path: string }>
  shared?: Record<string, unknown>
  state?: () => unknown
  notFoundPage?: { id: string; component?: string }
  routes: Record<string, ((ctx: never) => unknown) | undefined>
}

export type PrototypeFixtureModule = { default: PrototypeFixture } | PrototypeFixture
export type PrototypeFixtureLoader = () => Promise<PrototypeFixtureModule>

/** Container key the loaded fixture is bound under once `Application` has validated the prototype routes. */
export const PROTOTYPE_FIXTURE_BINDING = 'prototype.fixture'

function isFixture(value: unknown): value is PrototypeFixture {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as PrototypeFixture).routes === 'object'
    && (value as PrototypeFixture).routes !== null
  )
}

export async function loadPrototypeFixture(loader: PrototypeFixtureLoader): Promise<PrototypeFixture> {
  const loaded = await loader()
  const fixture = isFixture(loaded) ? loaded : (loaded as { default?: unknown }).default
  if (!isFixture(fixture)) {
    throw new Error(
      'createApp({ prototype }) loaded a module that does not export a definePrototype() result as its default export.',
    )
  }
  return fixture
}

/** One `state()` per fixture per process: shared by every request, reset by a restart. */
const processState = new WeakMap<PrototypeFixture, unknown>()

function stateOf(fixture: PrototypeFixture): unknown {
  if (!processState.has(fixture)) {
    processState.set(fixture, fixture.state?.() ?? {})
  }
  return processState.get(fixture)
}

export interface PrototypeRouteLike {
  method: string
  path: string
  name?: string
  schemas?: {
    params?: ValidationSchema<unknown>
    query?: ValidationSchema<unknown>
    body?: ValidationSchema<unknown>
  }
}

export interface PrototypeRouteDependencies {
  container?: ContainerLike
  /** `Router.route()`, for a `redirect()` naming a route. */
  routeUrl(name: string, params?: Record<string, string | number>): string
}

function enforce(schema: ValidationSchema<unknown> | undefined, data: unknown): void {
  if (!schema) return
  const result = schema.safeParse(data)
  if (!result.success) {
    throw ValidationException.withMessages(formatValidationErrors(result.error))
  }
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The route's handler: the fixture entry for the route name, run against the
 * same context shape the browser client builds. The route contract is enforced
 * first (`params`, `query`, `body`; not `output`, which only a response has), so `guren
 * audit`'s "runtime-enforced" verdict stays true here.
 */
export function createPrototypeRouteHandler(
  route: PrototypeRouteLike,
  deps: PrototypeRouteDependencies,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const fixture = resolveFixture(deps.container)
    const name = route.name
    const handler = name ? (fixture.routes[name] as PrototypeServerHandler | undefined) : undefined
    if (!name || !handler) {
      throw new Error(`Prototype route ${route.method} ${route.path} has no fixture entry${name ? ` for "${name}"` : ''}.`)
    }

    const params = c.req.param() as Record<string, string>
    const query = flattenRequestQueries(c)
    enforce(route.schemas?.params, params)
    enforce(route.schemas?.query, query)
    const method = c.req.method.toUpperCase()
    const body = BODYLESS_METHODS.has(method) ? undefined : await parseRequestBody(c)
    enforce(route.schemas?.body, body)

    const session = getSessionFromContext(c)
    // The real resolvers win over the fixture's demo values: a signed-in user
    // from the session replaces `shared.auth`, a guest leaves it as resolved.
    const shared = { ...fixture.shared, ...(await resolveSharedInertiaProps(c, deps.container)) }
    const url = new URL(c.req.url)

    const result = await handler({
      method,
      url: `${url.pathname}${url.search}`,
      params,
      query,
      body,
      state: stateOf(fixture),
      shared,
      page: (contract, props) => ({ kind: 'page', component: componentOf(contract), props }),
      redirect: (to, redirectParams) => ({ kind: 'redirect', to, params: redirectParams }),
      location: (target) => ({ kind: 'location', url: target }),
      errors: (errors) => ({ kind: 'errors', errors }),
      notFound: () => ({ kind: 'not-found' }),
      flash: (key, value) => session?.flash(key, value),
    })

    if (!isResult(result)) {
      throw new Error(`Prototype entry "${name}" returned something other than page()/redirect()/errors()/location()/notFound().`)
    }
    return answer(result, c, fixture, shared, deps)
  }
}

const RESULT_KINDS = new Set(['page', 'redirect', 'location', 'errors', 'not-found'])

function componentOf(contract: { id: string; component?: string }): string {
  return contract.component ?? contract.id
}

function isResult(value: unknown): value is PrototypeResult {
  return typeof value === 'object' && value !== null && RESULT_KINDS.has(String((value as { kind?: unknown }).kind))
}

function resolveFixture(container: ContainerLike | undefined): PrototypeFixture {
  let fixture: unknown
  try {
    fixture = container?.make(PROTOTYPE_FIXTURE_BINDING)
  } catch {
    fixture = undefined
  }
  if (!isFixture(fixture)) {
    throw new Error(
      'A prototype route was dispatched before its fixture was loaded. Pass `prototype: () => import(...)` to '
        + 'createApp() and mount routes through the application, which validates and loads it at boot.',
    )
  }
  return fixture
}

async function answer(
  result: PrototypeResult,
  c: Context,
  fixture: PrototypeFixture,
  shared: Record<string, unknown>,
  deps: PrototypeRouteDependencies,
): Promise<Response> {
  switch (result.kind) {
    case 'page':
      return inertia(result.component, { ...shared, ...result.props }, { request: c.req.raw, container: deps.container })
    case 'redirect':
      return c.redirect(deps.routeUrl(result.to, result.params), 303)
    case 'location':
      // What an Inertia server does for an off-site redirect: the client
      // performs a full visit to the header's URL.
      if (c.req.header('X-Inertia')) {
        return new Response(null, { status: 409, headers: { 'X-Inertia-Location': result.url } })
      }
      return c.redirect(result.url, 302)
    case 'errors':
      throw ValidationException.withMessages(result.errors)
    case 'not-found':
      if (fixture.notFoundPage) {
        return inertia(
          componentOf(fixture.notFoundPage),
          { ...shared, status: 404, message: 'Not Found' },
          { request: c.req.raw, status: 404, container: deps.container },
        )
      }
      throw HttpException.notFound()
  }
}
