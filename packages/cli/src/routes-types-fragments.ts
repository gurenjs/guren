/** Static code fragments emitted by the route type generators, identical for every app. */

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
 * The path-param rule: which keys a route path literal binds. Mirrors Hono's own lexing
 * (verified against hono@4.13.1): a param starts at a segment boundary, its key ends at
 * the first `{`, and a trailing `?` is dropped because Hono strips it. A trailing `*` is
 * deliberately **kept** — `/files/:slug*` arrives as the key `slug*`. Mirrored verbatim in
 * @guren/inertia-client's components.tsx, pinned by routes-types-fragments.test.ts.
 */
export const PATH_PARAM_TYPE_HELPERS = `\
type SegmentParamKey<TSegment extends string> = TSegment extends \`:\${infer TParam}\`
  ? TParam extends \`\${infer TName}{\${string}\`
    ? TName
    : TParam extends \`\${infer TName}?\`
      ? TName
      : TParam
  : never
type PathParamKeys<TPath extends string> = TPath extends \`\${infer THead}/\${infer TRest}\`
  ? SegmentParamKey<THead> | PathParamKeys<TRest>
  : SegmentParamKey<TPath>
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
 * The runtime half of the path-param rule, same Hono lexing as PATH_PARAM_TYPE_HELPERS: a
 * constraint is consumed whole including one level of nested braces, the whole token goes
 * so no modifier is left in the URL, and a trailing `*` is part of the key. Replacing
 * whole tokens by key lookup keeps `:id` from corrupting `:identifier` and makes an absent
 * key a no-op. Mirrored verbatim in @guren/inertia-client's components.tsx, same pin test.
 */
export const PATH_PARAM_RUNTIME_HELPERS = `\
function substituteParams(path: string, params?: Record<string, string | number>): string {
  if (!params) {
    return path
  }

  return path.replace(/(^|\\/):([A-Za-z0-9_-]+\\*?)(?:\\{[^{}]*\\{[^{}]*\\}[^{}]*\\}|\\{[^{}]*\\})?\\??/gu, (match, prefix, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return \`\${prefix}\${encodeURIComponent(String(params[key]))}\`
  })
}
`

/** Runtime utility functions used by the `route()` helper. */
export const RUNTIME_UTILITY_FUNCTIONS = `\
function hasPathParams(path: string): boolean {
  return /(?:^|\\/):[A-Za-z0-9_-]/u.test(path)
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
