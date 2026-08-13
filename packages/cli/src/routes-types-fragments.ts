/**
 * Static code fragments emitted by the route type generators.
 *
 * These string constants represent TypeScript code that is identical
 * regardless of which routes are defined.  Keeping them separate from
 * the builder logic makes both easier to read and modify.
 */

/** Module augmentations for @inertiajs/react and @inertiajs/core. */
export const DECLARATION_MODULE_AUGMENTATION = `\
declare module '@inertiajs/react' {
  interface BaseInertiaLinkProps {
    href: Guren.RouteUrl
  }
}

declare module '@inertiajs/core' {
  interface Router {
    visit(href: Guren.RouteUrl, options?: VisitOptions): void
    get(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    post(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    put(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    patch(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    delete(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'method'>): void
    replace(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'replace'>): void
  }
}
`

/**
 * The path-param rule, from key extraction down to the derived shapes: which
 * keys a route path literal binds, whether it binds any, and the params
 * object they form.
 *
 * Emitted into every generated module that answers those questions — the
 * route manifest and the API client — so they all derive the answers from
 * the path string the server routes on, not from whatever shape their
 * generator happens to emit alongside it.
 *
 * @guren/inertia-client's components.tsx carries the same rule for library
 * code that cannot embed an emitted fragment; routes-types-fragments.test.ts
 * asserts it contains this fragment verbatim, so a change here fails there
 * until both move.
 */
export const PATH_PARAM_TYPE_HELPERS = `\
type NormalizeParamKey<TValue extends string> = TValue extends \`\${infer Key}?\` ? Key : TValue
type PathParamKeys<TPath extends string> =
  TPath extends \`\${string}:\${infer Param}/\${infer Rest}\`
    ? NormalizeParamKey<Param> | PathParamKeys<\`/\${Rest}\`>
    : TPath extends \`\${string}:\${infer Param}\`
      ? NormalizeParamKey<Param>
      : never
type HasPathParams<TPath extends string> = [PathParamKeys<TPath>] extends [never] ? false : true
type PathParamsOf<TPath extends string> =
  HasPathParams<TPath> extends false
    ? Record<string, never>
    : { [TKey in PathParamKeys<TPath>]: string | number }
`

/** Type definitions emitted after the route manifest object. */
export const RUNTIME_TYPE_DEFINITIONS = `\
export type RouteManifest = typeof routeManifest
export type RouteName = keyof RouteManifest
export type RouteMethod = [RouteName] extends [never] ? string : RouteManifest[RouteName]['method']
export type RoutePath = [RouteName] extends [never] ? string : RouteManifest[RouteName]['path']

type PrimitiveQueryValue = string | number | boolean | null | undefined
type QueryValue = PrimitiveQueryValue | readonly PrimitiveQueryValue[]
export type RouteQuery = Record<string, QueryValue>

${PATH_PARAM_TYPE_HELPERS}
export type RouteParams<TName extends RouteName> = PathParamsOf<RouteManifest[TName]['path']>

type RouteArgs<TName extends RouteName> =
  HasPathParams<RouteManifest[TName]['path']> extends false
    ? [query?: RouteQuery]
    : [params: RouteParams<TName>, query?: RouteQuery]
`

/** The `route()` function emitted into the runtime module. */
export const RUNTIME_ROUTE_FUNCTION = `\
export function route<TName extends RouteName>(name: TName, ...args: RouteArgs<TName>): string {
  const definition: { method: RouteMethod; path: RoutePath } | undefined = routeManifest[name]
  if (!definition) {
    throw new Error(\`Route [\${String(name)}] not defined.\`)
  }

  const [firstArg, secondArg] = args as [RouteQuery | RouteParams<TName> | undefined, RouteQuery | undefined]
  const params = (args.length > 1 ? firstArg : hasPathParams(definition.path) ? firstArg : undefined) as RouteParams<TName> | undefined
  const query = (args.length > 1 ? secondArg : hasPathParams(definition.path) ? undefined : firstArg) as RouteQuery | undefined
  const path = substituteParams(definition.path, params as Record<string, string | number> | undefined)
  return appendQueryString(path, query)
}
`

/**
 * The runtime half of the path-param rule: how a bound key is substituted
 * into the path. Token-based — whole `:param` tokens are replaced by key
 * lookup — so a param whose name is a prefix of another (`:id` vs
 * `:identifier`) can never corrupt it, and a key the path lacks really is a
 * no-op. A per-key `path.replace(':key', ...)` loop has neither property;
 * that spelling is what this fragment exists to keep out of the generators.
 *
 * Mirrored verbatim in @guren/inertia-client's components.tsx alongside
 * PATH_PARAM_TYPE_HELPERS, under the same pin test.
 */
export const PATH_PARAM_RUNTIME_HELPERS = `\
function substituteParams(path: string, params?: Record<string, string | number>): string {
  if (!params) {
    return path
  }

  return path.replace(/:([A-Za-z0-9_-]+)/gu, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return encodeURIComponent(String(params[key]))
  })
}
`

/** Runtime utility functions used by the `route()` helper. */
export const RUNTIME_UTILITY_FUNCTIONS = `\
function hasPathParams(path: string): boolean {
  return /:[A-Za-z0-9_-]+/u.test(path)
}

${PATH_PARAM_RUNTIME_HELPERS}
function appendQueryString(path: string, query?: RouteQuery): string {
  if (!query) {
    return path
  }

  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value == null) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) {
          search.append(key, String(item))
        }
      }
      continue
    }

    search.set(key, String(value))
  }

  const serialized = search.toString()
  return serialized ? \`\${path}?\${serialized}\` : path
}
`
